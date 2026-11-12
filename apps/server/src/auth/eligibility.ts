// Who may hold an account's rights: a session (members, invited people and people let in from the waitlist), and
// creating workspaces (the people the deployment lists, and once each the people let in). The rules sign-in, sessions,
// invites and the workspace routes share (docs/decisions/0011-members-invites.md, 0054-waitlist.md).
import { and, eq, gt, isNull, or, sql as dsql, type SQL } from "drizzle-orm";
import { db, schema } from "../db.ts";

const { user, member, invite, waitlist } = schema;

/** An invite not yet accepted, revoked or declined (expired ones included: an admin may send them again). */
export const openInvite = () => and(isNull(invite.acceptedAt), isNull(invite.revokedAt))!;

/**
 * An invite the invited person can use: open, unexpired, and its sender still an admin there. An invite does not
 * outlive its sender's right to send it. The one rule for signing in, the invite page and joining.
 */
export const usableInvite = () =>
  and(
    openInvite(),
    gt(invite.expiresAt, dsql`now()`),
    dsql`exists (select 1 from ${member} where ${member.workspaceId} = ${invite.workspaceId} and ${member.userId} = ${invite.invitedById} and ${member.role} in ('admin', 'owner'))`,
  )!;

/** A usable invite to this address (lower-cased SQL text) in any workspace. */
const liveInviteFor = (email: SQL) => dsql`exists (select 1 from ${invite} where ${invite.email} = ${email} and ${usableInvite()})`;

/**
 * A waitlist entry for this address (lower-cased SQL text) that was let in and not yet used to create a workspace (ADR
 * 0054). It works as a live invite does: a code goes out, the first sign-in makes the account, the session lasts.
 */
const admittedFor = (email: SQL) =>
  dsql`exists (select 1 from ${waitlist} where ${waitlist.email} = ${email} and ${waitlist.admittedAt} is not null and ${waitlist.usedAt} is null)`;

/** An invite or a let-in waitlist entry: what brings a person without a workspace in. */
export const wayInFor = (email: SQL) => or(liveInviteFor(email), admittedFor(email))!;

/**
 * Who may sign in and stay signed in: a human member of some workspace, or one with a live invite (to accept it, or to
 * see it after leaving their last workspace). Agents have tokens only. Checked when a session opens and on every
 * session lookup (sessions.ts): whoever loses the last reason loses their sessions too (owner's decision 2026-10-29).
 */
export const mayHaveSession = () =>
  and(eq(user.kind, "human"), or(dsql`exists (select 1 from ${member} where ${member.userId} = ${user.id})`, wayInFor(dsql`lower(${user.email})`)));

export async function maySignIn(userId: string): Promise<boolean> {
  const [u] = await db.select({ id: user.id }).from(user).where(and(eq(user.id, userId), mayHaveSession()));
  return !!u;
}

/**
 * Whether this address may create workspaces: one of RSVA_WORKSPACE_CREATORS (comma-separated, any case). Unset or
 * empty, nobody may (owner's decision 2026-10-29: otherwise anyone invited once makes workspaces and sends invite mail
 * from our address). Read on every call: a restart with a new list, or a test, needs nothing else.
 */
export function listedCreator(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const e = email.trim().toLowerCase();
  return e !== "" && (env.RSVA_WORKSPACE_CREATORS ?? "").split(",").some((c) => c.trim().toLowerCase() === e);
}

/** Whether this address may create a workspace now: a listed creator any number of times, a let-in one once. */
export async function mayCreateWorkspaces(email: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (listedCreator(email, env)) return true;
  const [r] = await db.execute<{ ok: boolean }>(dsql`select ${admittedFor(dsql`${email.trim().toLowerCase()}`)} as ok`);
  return !!r?.ok;
}
