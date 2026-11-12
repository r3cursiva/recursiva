// API tokens: `Authorization: Bearer rsva_…` for agents, the CLI and scripts. A token acts as its member in its one
// workspace, narrowed by its scope and a custom token's grants. Lookups are cached for a minute like sessions; revoking
// or changing the grants drops the cache entry here.
import { isRole, isScope, tokenGrants, type Grant, type Scope } from "@rsva/policy";
import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema, type Tx } from "../db.ts";
import { onMembershipChange } from "../sync/membership.ts";
import { Limiter, Misses } from "./limits.ts";
import { randomSecret, sha256 } from "./secret.ts";

const { apiToken, member, user } = schema;

const TOKEN_PREFIX = "rsva_";
const CACHE_MS = 60_000;
const TOUCH_MS = 300_000;

/** A token makes at most this many requests a minute, over HTTP (requireActor) and WebSocket transactions together. */
export const perToken = new Limiter(600, 60_000);

export interface TokenInfo {
  id: string;
  workspaceId: string;
  userId: string;
  scope: Scope;
  /** A custom token's grants as stored; access.ts narrows them to what holds now (tokenGrants). */
  grants: readonly string[];
}

interface Cached extends TokenInfo {
  hash: string;
  expiresAt: number | null;
  lastUsed: number;
  checked: number;
}
const cache = new Map<string, Cached>();
/** Hashes of no live token: a wrong token repeated costs one read a minute. */
const misses = new Misses(CACHE_MS);
/** Bumped by a revocation: a lookup that read the row before it does not cache its stale answer. */
let generation = 0;

export interface NewToken {
  workspaceId: string;
  userId: string;
  name: string;
  scope: Scope;
  /** A custom token's grants, checked by the caller against what the granter may give (grantable). */
  grants?: Grant[];
  createdById: string | null;
  expiresAt?: Date | null;
}

/** Who set a custom token's grants: the person making it. A change records its author whatever the scope (setTokenGrants). */
const granted = (scope: Scope, by: string | null) => (scope === "custom" ? { grantedById: by, grantedAt: new Date().toISOString() } : { grantedById: null, grantedAt: null });

/** Creates a token; the secret is returned once and never stored. */
export async function createToken(t: NewToken): Promise<{ id: string; secret: string }> {
  const secret = TOKEN_PREFIX + randomSecret();
  const [row] = await db
    .insert(apiToken)
    .values({ ...t, grants: t.scope === "custom" ? (t.grants ?? []) : [], ...granted(t.scope, t.createdById), expiresAt: t.expiresAt?.toISOString() ?? null, hash: sha256(secret) })
    .returning({ id: apiToken.id });
  return { id: row!.id, secret };
}

/**
 * Sets a live token's scope and grants; false if there is no such token in the workspace. The cached lookup goes at once,
 * so the next request holds the new grants; the caller closes the token's sockets, which reconnect with them.
 */
export async function setTokenGrants(workspaceId: string, id: string, scope: Scope, grants: Grant[], by: string): Promise<boolean> {
  // Who changed it and when, for every scope: an email change undone revokes what was widened since, read to write too.
  // Only a custom token's grants read the granter's role (tokenGrants), so recording it on the others gives nothing.
  return changeLive(workspaceId, id, { scope, grants: scope === "custom" ? grants : [], grantedById: by, grantedAt: new Date().toISOString() });
}

/** Changes a live token of the workspace and drops its cached lookup; false if there is no such token. */
async function changeLive(workspaceId: string, id: string, set: Partial<typeof apiToken.$inferInsert>): Promise<boolean> {
  const rows = await db
    .update(apiToken)
    .set(set)
    .where(and(eq(apiToken.id, id), eq(apiToken.workspaceId, workspaceId), isNull(apiToken.revokedAt)))
    .returning({ hash: apiToken.hash });
  forgetTokens(rows.map((r) => r.hash));
  return rows.length > 0;
}

export async function tokenFromSecret(secret: string): Promise<TokenInfo | null> {
  if (!secret.startsWith(TOKEN_PREFIX) || secret.length > 100) return null;
  const hash = sha256(secret);
  const now = Date.now();
  let c = cache.get(hash);
  if (!c || now - c.checked > CACHE_MS) {
    if (misses.has(hash, now)) return null;
    const before = generation;
    const [row] = await db
      .select({
        id: apiToken.id,
        workspaceId: apiToken.workspaceId,
        userId: apiToken.userId,
        scope: apiToken.scope,
        grants: apiToken.grants,
        expiresAt: apiToken.expiresAt,
        lastUsedAt: apiToken.lastUsedAt,
      })
      .from(apiToken)
      .where(and(eq(apiToken.hash, hash), isNull(apiToken.revokedAt)));
    if (!row) {
      cache.delete(hash);
      misses.add(hash, now);
      return null;
    }
    c = {
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      // An unknown scope reads as read: never more than the row says.
      scope: isScope(row.scope) ? row.scope : "read",
      grants: row.grants,
      hash,
      expiresAt: row.expiresAt ? Date.parse(row.expiresAt) : null,
      lastUsed: row.lastUsedAt ? Date.parse(row.lastUsedAt) : 0,
      checked: now,
    };
    if (generation === before) cache.set(hash, c);
    if (cache.size > 10_000) cache.delete(cache.keys().next().value!);
  }
  if (c.expiresAt !== null && now >= c.expiresAt) return null;
  if (now - c.lastUsed > TOUCH_MS) {
    c.lastUsed = now;
    void db
      .update(apiToken)
      .set({ lastUsedAt: new Date(now).toISOString() })
      .where(eq(apiToken.id, c.id))
      .catch((e: unknown) => console.error("token touch failed", e));
  }
  return { id: c.id, workspaceId: c.workspaceId, userId: c.userId, scope: c.scope, grants: c.grants };
}

// A member who left or was removed: the write pipeline revoked their tokens in the same transaction. One whose role
// changed: it narrowed their tokens' grants (sync/members.ts, narrowGrants). Either way the cached lookups of their
// tokens go now, not after a minute, or a grant dropped there would still hold from the cache once their role was back.
onMembershipChange((workspaceId, userId) => {
  generation++;
  for (const [hash, c] of cache) if (c.workspaceId === workspaceId && c.userId === userId) cache.delete(hash);
});

/** Revokes a token of the workspace; false if there is no such live token. */
export async function revokeToken(workspaceId: string, id: string): Promise<boolean> {
  return changeLive(workspaceId, id, { revokedAt: new Date().toISOString() });
}

/**
 * Revokes, in `tx`, the live tokens a person made, was given or widened since `since`, an agent's they made or widened
 * too; returns their hashes for forgetTokens once `tx` commits (email-change.ts).
 */
export async function revokeTokensSince(tx: Tx, userId: string, since: string): Promise<string[]> {
  const rows = await tx
    .update(apiToken)
    .set({ revokedAt: new Date().toISOString() })
    .where(
      and(
        or(and(or(eq(apiToken.userId, userId), eq(apiToken.createdById, userId)), gte(apiToken.createdAt, since)), and(eq(apiToken.grantedById, userId), gte(apiToken.grantedAt, since))),
        isNull(apiToken.revokedAt),
      ),
    )
    .returning({ hash: apiToken.hash });
  return rows.map((r) => r.hash);
}

/** Drops the cached lookups of revoked tokens: their next request reads the row. */
export function forgetTokens(hashes: string[]): void {
  generation++;
  for (const h of hashes) cache.delete(h);
}

const granter = alias(user, "granter");
const holderMember = alias(member, "holder_member");

/**
 * Live tokens of a workspace, newest first; `userId` narrows to one member's. Secrets are never listed. `held` is what a
 * custom token's grants give now (tokenGrants): less than `grants` once its member's role or the workspace's member
 * rights no longer allow some.
 */
export async function listTokens(workspaceId: string, rights: readonly string[], userId?: string) {
  const rows = await db
    .select({
      id: apiToken.id,
      name: apiToken.name,
      scope: apiToken.scope,
      grants: apiToken.grants,
      grantedBy: granter.email,
      grantedAt: apiToken.grantedAt,
      user: user.email,
      createdAt: apiToken.createdAt,
      lastUsedAt: apiToken.lastUsedAt,
      expiresAt: apiToken.expiresAt,
      role: holderMember.role,
    })
    .from(apiToken)
    .innerJoin(user, eq(user.id, apiToken.userId))
    .leftJoin(holderMember, and(eq(holderMember.userId, apiToken.userId), eq(holderMember.workspaceId, apiToken.workspaceId)))
    .leftJoin(granter, eq(granter.id, apiToken.grantedById))
    .where(and(eq(apiToken.workspaceId, workspaceId), isNull(apiToken.revokedAt), userId ? eq(apiToken.userId, userId) : undefined))
    .orderBy(desc(apiToken.createdAt));
  return rows.map(({ role, ...t }) => ({ ...t, held: isRole(role) ? [...tokenGrants(t.grants, role, rights)] : [] }));
}
