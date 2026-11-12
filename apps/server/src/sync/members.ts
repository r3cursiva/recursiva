// Members in the write pipeline: an admin changes someone's role or removes them, anyone removes themselves (leaves),
// and an accepted invite adds a member (join). Each is a User action in the log, so open clients see the member list,
// the assignee pickers and their own role change at once; who may do what is checked here, against the member rows
// locked in the same transaction, not only by the policy table: leaving comes through the REST API, past deniedOps.
//
// The owner cannot leave or be changed or removed: that waits for the transfer of ownership. A member who is gone
// keeps their user row: their name stays on their issues and comments, the action carries `role: null`. Their address
// goes from the workspace's log (RSVA-609): the snapshot lists members only, and a catch-up from an early number would
// otherwise still hand it to every member.
import { capRole, isRole, mayManage, tokenGrants, type Role } from "@rsva/policy";
import { ASSIGNABLE_ROLES, type AssignableRole } from "@rsva/schema/models";
import { and, asc, eq, inArray, isNull, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { schema, type Tx } from "../db.ts";
import { TxError, type Pending } from "./tx-error.ts";
import { forgetText } from "./log.ts";

const { member, user, apiToken, workspace } = schema;

const uuid = z.uuid();
export const memberOpSchemas = [
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("update"), m: z.literal("User"), id: uuid, set: z.object({ role: z.enum(ASSIGNABLE_ROLES) }).strict() }).strict(),
    z.object({ op: z.literal("delete"), m: z.literal("User"), id: uuid }).strict(),
  ]),
] as const;

/**
 * Roles of these users in the workspace, their member rows locked in user id order: two admins changing each other at
 * once wait for one another instead of each acting on a role the other is taking away, and cannot deadlock.
 */
async function lockRoles(tx: Tx, workspaceId: string, userIds: string[]): Promise<Map<string, Role>> {
  const rows = await tx
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(and(eq(member.workspaceId, workspaceId), inArray(member.userId, userIds)))
    .orderBy(asc(member.userId))
    .for("update");
  return new Map(rows.flatMap((r) => (isRole(r.role) ? [[r.userId, r.role] as const] : [])));
}

/** A new role, or null to end the membership. */
export async function setMemberRole(tx: Tx, workspaceId: string, actorId: string, userId: string, role: AssignableRole | null): Promise<Pending | null> {
  const self = actorId === userId;
  const roles = await lockRoles(tx, workspaceId, [...new Set([actorId, userId])]);
  if (!self) {
    if (!mayManage(roles.get(actorId))) throw new TxError("forbidden", "only admins change other members");
  }
  const current = roles.get(userId) ?? null;
  if (!current) throw new TxError("not_found", `no member ${userId}`);
  if (current === "owner")
    throw new TxError("forbidden", self && role === null ? "the owner cannot leave: transfer ownership first" : "the owner's role changes only by a transfer of ownership");
  if (self && role !== null) throw new TxError("forbidden", "another admin has to change your role");
  if (role === current) return null;
  if (role !== null && role !== "member") {
    const [u] = await tx.select({ kind: user.kind }).from(user).where(eq(user.id, userId));
    if (capRole(role, u!.kind) !== role) throw new TxError("forbidden", "an agent's role is at most member");
  }
  const where = and(eq(member.workspaceId, workspaceId), eq(member.userId, userId));
  if (role === null) {
    await tx.delete(member).where(where);
    await forgetText(tx, workspaceId, dsql`values ('User', ${userId}::uuid)`, ["email"]);
    // Their tokens for this workspace end with the membership: an invite back must not bring them to life.
    await tx.update(apiToken).set({ revokedAt: dsql`now()` }).where(and(eq(apiToken.workspaceId, workspaceId), eq(apiToken.userId, userId), isNull(apiToken.revokedAt)));
  }
  else await tx.update(member).set({ role }).where(where);
  if (role) await narrowGrants(tx, workspaceId, userId, role);
  return { m: "User", mid: userId, a: "U", d: { role }, p: { role: current } };
}

/**
 * A member's role changed: their custom tokens keep only the grants the new role allows here (packages/policy,
 * tokenGrants). Read at each request, the others already stop; dropped here, they do not come back if the role does, as
 * revoked tokens do not on an invite back.
 */
export async function narrowGrants(tx: Tx, workspaceId: string, userId: string, role: Role): Promise<void> {
  const [w] = await tx.select({ rights: workspace.memberRights }).from(workspace).where(eq(workspace.id, workspaceId));
  const rows = await tx
    .select({ id: apiToken.id, grants: apiToken.grants })
    .from(apiToken)
    .where(and(eq(apiToken.workspaceId, workspaceId), eq(apiToken.userId, userId), eq(apiToken.scope, "custom"), isNull(apiToken.revokedAt)));
  for (const t of rows) {
    const held = tokenGrants(t.grants, role, w?.rights ?? []);
    if (held.size !== t.grants.length) await tx.update(apiToken).set({ grants: [...held] }).where(eq(apiToken.id, t.id));
  }
}

/** Adds a member; null if they already are one (an invite accepted twice, or an old invite of a member). */
export async function addMember(tx: Tx, workspaceId: string, userId: string, role: Role): Promise<Pending | null> {
  const added = await tx.insert(member).values({ workspaceId, userId, role }).onConflictDoNothing().returning({ userId: member.userId });
  if (!added.length) return null;
  // FOR SHARE waits for a rename in progress (auth/account.ts), which did not see this membership: the action carries the
  // new name instead of one the workspace would never hear changed.
  const [u] = await tx.select({ id: user.id, email: user.email, name: user.name, kind: user.kind, picture: user.picture, avatar: user.avatar }).from(user).where(eq(user.id, userId)).for("share");
  return { m: "User", mid: userId, a: "I", d: { ...u!, role } };
}
