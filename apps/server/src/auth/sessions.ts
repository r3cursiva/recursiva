// Browser sessions: a random token in an HttpOnly cookie, its hash in the session table.
//
// Every request with a cookie is checked, so lookups are cached in memory for a minute: the database sees one read per
// session a minute, plus one write an hour to move lastSeenAt. Ending a session here drops it from the cache at once;
// with several server processes (PLNR-11) another process may honour it for up to CACHE_MS more.
//
// A session lives only while its person may have one (eligibility.ts: a member somewhere, or invited). The rule is part
// of the cached lookup, so a removed member, an expired invite or a sender who lost their admin role ends it within
// CACHE_MS; a membership change (sync/membership.ts) or a revoked invite (workspaces.ts) drops the person's cached
// sessions at once. Sessions that fail the rule are deleted, all of that person's together.
//
// Considered (2026-10-29): ending sessions in the transactions that remove the last reason (removal, leaving, revoking,
// declining) misses the reasons that end with time (an invite running out, its sender demoted) and touches every such
// path; a per-request membership query costs a read per request. The rule in the cached lookup covers every path at
// one read a minute.
import type { SessionView } from "@rsva/protocol";
import { and, desc, eq, gt, inArray, lt, lte, ne, or, sql as dsql } from "drizzle-orm";
import { db, schema, type Tx } from "../db.ts";
import { onMembershipChange } from "../sync/membership.ts";
import { deviceName } from "./device.ts";
import { mayHaveSession } from "./eligibility.ts";
import { Misses } from "./limits.ts";
import { randomSecret, sha256 } from "./secret.ts";

const { session, user } = schema;

const DAY = 86_400_000;
/** A session unused this long ends. */
const IDLE_MS = 30 * DAY;
/**
 * A terminal's session (method "cli", terminal.ts) unused this long ends. It sits in the Keychain, where any process of
 * the Mac that may run `security` reads it (the sandbox of dispatched agents may not, other sessions may), and it opens
 * every workspace of the person: what is taken from there must not live a month unused (security review, PLNR-326).
 */
const CLI_IDLE_MS = 7 * DAY;
/** Every session ends this long after sign-in, used or not. */
export const MAX_MS = 365 * DAY;
/**
 * Adding a passkey, making an API token, changing the email or connecting the personal Telegram chat (sign-in codes go
 * there) needs a sign-in this recent: a stolen session cookie must not become a key of its own that outlives the session. Older sessions get 403 reauth_required (routes.ts), and the
 * web asks for an email code first (account-menu.tsx).
 */
export const FRESH_MS = 10 * 60_000;
const TOUCH_MS = 3_600_000;
const CACHE_MS = 60_000;

export type SignInMethod = "code" | "passkey" | "cli";

export interface SessionInfo {
  id: string;
  userId: string;
  /** When the person signed in: what FRESH_MS is measured from. */
  createdAt: number;
  expiresAt: number;
  /** A terminal's session (terminal.ts), whatever carries it: it never makes a new key (routes.ts, freshBrowser). */
  terminal: boolean;
}

interface Cached extends SessionInfo {
  idleMs: number;
  lastSeen: number;
  checked: number;
}
const cache = new Map<string, Cached>();
/** Hashes that matched no session: a wrong cookie or header sent again and again costs one read a minute. */
const misses = new Misses(CACHE_MS);
/** Bumped whenever cached sessions are dropped: a lookup that started before does not cache its stale answer. */
let generation = 0;

const idleOf = (method: string) => (method === "cli" ? CLI_IDLE_MS : IDLE_MS);
/** SQL: the lastSeenAt before which a session of its method is idle. */
const idleCutoff = (now: number) =>
  dsql`case when ${session.method} = 'cli' then ${new Date(now - CLI_IDLE_MS).toISOString()}::timestamptz else ${new Date(now - IDLE_MS).toISOString()}::timestamptz end`;

/** The person no longer has a session's right: their session rows. */
const ineligible = () => dsql`not exists (select 1 from ${user} where ${user.id} = ${session.userId} and ${mayHaveSession()})`;

/**
 * Opens a session; the token goes into the cookie and is never stored. `signedInAt`: when the person last signed in, if
 * not now (a terminal's session takes its browser's, terminal.ts); FRESH_MS and MAX_MS count from it.
 */
export async function createSession(userId: string, method: SignInMethod, userAgent: string | undefined, signedInAt?: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomSecret();
  const expiresAt = new Date((signedInAt ?? Date.now()) + MAX_MS);
  const createdAt = signedInAt === undefined ? {} : { createdAt: new Date(signedInAt).toISOString() };
  await db.insert(session).values({ id: sha256(token), userId, method, userAgent: userAgent?.slice(0, 300) ?? null, expiresAt: expiresAt.toISOString(), ...createdAt });
  return { token, expiresAt };
}

/** The live session of a cookie token, or null. */
export async function sessionFromToken(token: string): Promise<SessionInfo | null> {
  return !token || token.length > 100 ? null : sessionById(sha256(token));
}

/** The live session with this id (the hash of its token), or null: the same cached lookup and rules as a cookie's. */
export async function sessionById(id: string): Promise<SessionInfo | null> {
  const now = Date.now();
  let c = cache.get(id);
  if (!c || now - c.checked > CACHE_MS) {
    if (misses.has(id, now)) return null;
    const before = generation;
    const [row] = await db
      .select({ userId: session.userId, method: session.method, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt, allowed: dsql<boolean>`${mayHaveSession()}` })
      .from(session)
      .innerJoin(user, eq(user.id, session.userId))
      .where(eq(session.id, id));
    if (!row?.allowed) {
      cache.delete(id);
      misses.add(id, now);
      if (row) await endSessionsIfIneligible({ userId: row.userId });
      return null;
    }
    c = { id, userId: row.userId, createdAt: Date.parse(row.createdAt), expiresAt: Date.parse(row.expiresAt), terminal: row.method === "cli", idleMs: idleOf(row.method), lastSeen: Date.parse(row.lastSeenAt), checked: now };
    if (generation === before) cache.set(id, c);
    if (cache.size > 10_000) cache.delete(cache.keys().next().value!);
  }
  if (now >= c.expiresAt || now - c.lastSeen >= c.idleMs) {
    await endSession(id);
    return null;
  }
  if (now - c.lastSeen > TOUCH_MS) {
    c.lastSeen = now;
    void db
      .update(session)
      .set({ lastSeenAt: new Date(now).toISOString() })
      .where(eq(session.id, id))
      .catch((e: unknown) => console.error("session touch failed", e));
  }
  return { id: c.id, userId: c.userId, createdAt: c.createdAt, expiresAt: c.expiresAt, terminal: c.terminal };
}

export async function endSession(id: string): Promise<void> {
  cache.delete(id);
  await db.delete(session).where(eq(session.id, id));
  // A lookup that read the row before the delete must not put it back for a minute.
  generation++;
  cache.delete(id);
}

/** What a list calls a session: the key itself stays on the server, out of pages and request logs. */
const handle = (id: string) => sha256(`session:${id}`).slice(0, 22);

/** A person's live sessions, the latest used first (lastSeenAt moves once an hour). */
export async function listSessions(userId: string, currentId: string): Promise<SessionView[]> {
  const now = Date.now();
  const rows = await db
    .select({ id: session.id, method: session.method, userAgent: session.userAgent, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt })
    .from(session)
    .where(and(eq(session.userId, userId), gt(session.expiresAt, new Date(now).toISOString()), gt(session.lastSeenAt, idleCutoff(now))))
    .orderBy(desc(session.lastSeenAt));
  return rows.map(({ id, userAgent, ...r }) => ({ ...r, id: handle(id), device: deviceName(userAgent), current: id === currentId }));
}

/** The session a list's handle names, among this person's own; null for anyone else's. */
export async function sessionByHandle(userId: string, h: string): Promise<{ id: string; createdAt: number } | null> {
  const rows = await db.select({ id: session.id, createdAt: session.createdAt }).from(session).where(eq(session.userId, userId));
  const s = rows.find((r) => handle(r.id) === h);
  return s ? { id: s.id, createdAt: Date.parse(s.createdAt) } : null;
}

/** Ends every session of a person but one, with `signedInBy` only those signed in by then; returns the ids ended. */
export async function endOtherSessions(userId: string, keepId: string, signedInBy?: number): Promise<string[]> {
  const gone = await db
    .delete(session)
    .where(and(eq(session.userId, userId), ne(session.id, keepId), signedInBy === undefined ? undefined : lte(session.createdAt, new Date(signedInBy).toISOString())))
    .returning({ id: session.id });
  // After the delete, so that a lookup running across it does not cache its answer.
  forgetUser(userId);
  return gone.map((g) => g.id);
}

/**
 * Ends the sessions of a person (by id, or by an invited address) who may no longer have one; returns the ids ended.
 * Their cached sessions are dropped first, synchronously: a request right after sees the database, not the cache.
 */
export async function endSessionsIfIneligible(who: { userId: string } | { email: string }): Promise<string[]> {
  if ("userId" in who) forgetUser(who.userId);
  else generation++;
  const whose =
    "userId" in who
      ? eq(session.userId, who.userId)
      : inArray(session.userId, db.select({ id: user.id }).from(user).where(eq(dsql`lower(${user.email})`, who.email.toLowerCase())));
  const gone = await db.delete(session).where(and(whose, ineligible())).returning({ id: session.id });
  return dropped(gone);
}

/** Forgets the cached lookups of deleted sessions and returns their ids. */
function dropped(gone: { id: string }[]): string[] {
  for (const g of gone) cache.delete(g.id);
  return gone.map((g) => g.id);
}

/** Deletes every session of a person in `tx` and returns their ids; forgetUser once it commits (auth/email-change.ts). */
export async function deleteSessionsIn(tx: Tx, userId: string): Promise<string[]> {
  return (await tx.delete(session).where(eq(session.userId, userId)).returning({ id: session.id })).map((r) => r.id);
}

/** Drops a person's cached sessions: their next request reads the session and the rule again. */
export function forgetUser(userId: string): void {
  generation++;
  for (const [k, c] of cache) if (c.userId === userId) cache.delete(k);
}

// A role taken away or given: the person's sessions are checked again on their next request, and end if that was
// their last workspace and no invite is left.
onMembershipChange((_, userId, role) => {
  forgetUser(userId);
  if (role === null) void endSessionsIfIneligible({ userId }).catch((e: unknown) => console.error("ending sessions failed", e));
});

/** Deletes sessions that can no longer be used and returns their ids; run now and then (main.ts). */
export async function sweepSessions(): Promise<string[]> {
  const now = Date.now();
  const gone = await db
    .delete(session)
    .where(or(lt(session.expiresAt, new Date(now).toISOString()), lt(session.lastSeenAt, idleCutoff(now)), ineligible()))
    .returning({ id: session.id });
  return dropped(gone);
}

/** Drops every cached session (tests). */
export function forgetSessions(): void {
  generation++;
  cache.clear();
  misses.clear();
}
