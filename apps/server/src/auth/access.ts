// What an actor may open: membership and role in a workspace, with what the workspace opened to members, narrowed by a
// token's workspace, scope and grants. Every path to workspace data asks here first: the snapshot, the WebSocket
// subscription, issue history and the agent API.
//
// A workspace the actor is not a member of answers as if it did not exist (404), so slugs of other teams do not leak:
// not by the answer, nor by its time. A free slug costs the same queries as a foreign one, first one then none for 30 s,
// so a probe can't tell them apart by how fast the 404 comes (RSVA-579).
// Roles and member rights are cached for 30 s; a change made through the write pipeline drops its entry at once
// (sync/membership.ts).
import { can, isRole, tokenGrants, type Capability, type Role, type Viewer } from "@rsva/policy";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { HttpError } from "../http.ts";
import { onMembershipChange, onRightsChange } from "../sync/membership.ts";
import type { Actor } from "./actor.ts";

const { workspace, member } = schema;

const ROLE_MS = 30_000;

export interface Access {
  workspaceId: string;
  slug: string;
  role: Role;
  /** What the workspace opened to members (packages/policy, MEMBER_RIGHTS). */
  rights: readonly string[];
  viewer: Viewer;
}

export type AccessResult = Access | { status: 403 | 404; error: string };

const slugs = new Map<string, string>();
/** Slugs with no workspace, cached as long as a role is: when each was looked up. */
const missing = new Map<string, number>();
const roles = new Map<string, { role: Role | null; at: number }>();
const rights = new Map<string, { rights: readonly string[]; at: number }>();
/** Bumped by every membership change: a role read before the change is not cached after it was dropped. */
let generation = 0;

/**
 * The workspace of a slug and the person's role there, in one query when neither is cached. Slugs never change, so an
 * id stays; a slug with no workspace is remembered as long as a role, and the create route forgets it (forgetMissing).
 */
async function bySlug(slug: string, userId: string): Promise<{ id: string | null; role: Role | null }> {
  const id = slugs.get(slug);
  if (id) return { id, role: await roleIn(id, userId) };
  const at = missing.get(slug);
  if (at !== undefined && Date.now() - at < ROLE_MS) return { id: null, role: null };
  const before = generation;
  const [w] = await db
    .select({ id: workspace.id, role: member.role })
    .from(workspace)
    .leftJoin(member, and(eq(member.workspaceId, workspace.id), eq(member.userId, userId)))
    .where(eq(workspace.slug, slug));
  if (!w) return (cache(missing, slug, Date.now()), { id: null, role: null });
  slugs.set(slug, w.id);
  const role = w.role && isRole(w.role) ? w.role : null;
  if (generation === before) cache(roles, `${w.id}:${userId}`, { role, at: Date.now() });
  return { id: w.id, role };
}

/** A new workspace's slug is no longer missing: its creator opens it at once. */
export function forgetMissing(slug: string): void {
  missing.delete(slug);
}

export async function roleIn(workspaceId: string, userId: string): Promise<Role | null> {
  const key = `${workspaceId}:${userId}`;
  const hit = roles.get(key);
  if (hit && Date.now() - hit.at < ROLE_MS) return hit.role;
  const before = generation;
  const [m] = await db.select({ role: member.role }).from(member).where(and(eq(member.workspaceId, workspaceId), eq(member.userId, userId)));
  const role = m && isRole(m.role) ? m.role : null;
  if (generation === before) cache(roles, key, { role, at: Date.now() });
  return role;
}

/** Sets an entry and drops the oldest past 10 000, so probes can't grow a cache without end. */
function cache<V>(map: Map<string, V>, key: string, value: V): void {
  map.set(key, value);
  if (map.size > 10_000) map.delete(map.keys().next().value!);
}

/** What the workspace opened to members (ADR 0037), cached like roles; a change through the write pipeline drops it at once. */
async function rightsIn(workspaceId: string): Promise<readonly string[]> {
  const hit = rights.get(workspaceId);
  if (hit && Date.now() - hit.at < ROLE_MS) return hit.rights;
  const before = generation;
  const [w] = await db.select({ rights: workspace.memberRights }).from(workspace).where(eq(workspace.id, workspaceId));
  const r = w?.rights ?? [];
  if (generation === before) cache(rights, workspaceId, { rights: r, at: Date.now() });
  return r;
}

async function check(actor: Actor, id: string | null, slug: string, roleOf: () => Promise<Role | null>): Promise<AccessResult> {
  const notFound = { status: 404 as const, error: `no workspace ${slug}` };
  if (!id || (actor.token && actor.token.workspaceId !== id)) return notFound;
  const role = await roleOf();
  if (!role) return notFound;
  const rights = await rightsIn(id);
  const viewer = viewerOf(actor, role, rights);
  if (!can(viewer, "read")) return { status: 403, error: role === "guest" ? "guest access is not available yet" : "no access to this workspace" };
  return { workspaceId: id, slug, role, rights, viewer };
}

/**
 * A session's viewer is its role and the workspace's member rights. A token's adds its scope; a custom token's, the
 * grants that hold now: never past what its member may do (packages/policy, tokenGrants).
 */
function viewerOf(actor: Actor, role: Role, rights: readonly string[]): Viewer {
  const t = actor.token;
  if (!t) return { role, rights };
  if (t.scope !== "custom") return { role, scope: t.scope, rights };
  return { role, scope: "custom", grants: tokenGrants(t.grants, role, rights), rights };
}

export async function accessBySlug(actor: Actor, slug: string): Promise<AccessResult> {
  const { id, role } = await bySlug(slug, actor.userId);
  return check(actor, id, slug, async () => role);
}

/** The access, or an HttpError 404 or 403 with the reason: how a route answers a workspace the actor cannot open. */
export function granted(a: AccessResult): Access {
  if ("status" in a) throw new HttpError(a.status, a.status === 404 ? "not_found" : "forbidden", a.error);
  return a;
}

export interface MyWorkspace {
  id: string;
  slug: string;
  name: string;
  color: (typeof workspace.$inferSelect)["color"];
  role: Role;
}

/**
 * The person's workspaces by name, with their role in each as stored now (not the 30 s cache: a list is read once). A
 * row with no known role is no membership, as roleIn reads it. With `cap`, only those where their role allows it: the
 * role alone, without a token or the workspace's member rights (packages/policy, can), as the bot and the mails need.
 */
export async function workspacesOf(userId: string, cap?: Capability): Promise<MyWorkspace[]> {
  const rows = await db
    .select({ id: workspace.id, slug: workspace.slug, name: workspace.name, color: workspace.color, role: member.role })
    .from(member)
    .innerJoin(workspace, eq(workspace.id, member.workspaceId))
    .where(eq(member.userId, userId))
    .orderBy(asc(workspace.name));
  return rows.filter((r): r is MyWorkspace => isRole(r.role) && (!cap || can({ role: r.role }, cap)));
}

export async function accessById(actor: Actor, id: string): Promise<AccessResult> {
  const [w] = await db.select({ slug: workspace.slug }).from(workspace).where(eq(workspace.id, id));
  return check(actor, w ? id : null, w?.slug ?? id, () => roleIn(id, actor.userId));
}

onMembershipChange((workspaceId, userId) => {
  generation++;
  roles.delete(`${workspaceId}:${userId}`);
});

onRightsChange((workspaceId) => {
  generation++;
  rights.delete(workspaceId);
});

/** Drops cached roles and member rights (tests). */
export function forgetRoles(): void {
  generation++;
  roles.clear();
  rights.clear();
  missing.clear();
}
