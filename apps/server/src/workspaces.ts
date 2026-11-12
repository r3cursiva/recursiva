// People in workspaces: invites, joining, leaving and new workspaces (docs/decisions/0011-members-invites.md). Signed-in
// people only: a token can neither invite nor join. Roles and removals by admins go through the write pipeline as User
// ops (sync/members.ts); everything here that changes membership goes through it too (applyServerChange), so open
// clients get a User action and the role caches and sockets learn about it.
//
// An invite link carries a random secret (32 bytes) and works for 7 days, only for the address it was sent to: a
// forwarded link shows the invite, but joining needs a session of that address. A dead link (revoked, used, expired or
// made up) answers 404 with nothing about the workspace.
import { can, mayManage } from "@rsva/policy";
import { DEFAULT_STATES, type CreateWorkspace, type InviteResult, type InviteView, type PendingInvite } from "@rsva/protocol";
import { ASSIGNABLE_ROLES, PROJECT_KEY, RESERVED_SLUGS, TILE_COLORS, UUID, WORKSPACE_SLUG, type AssignableRole } from "@rsva/schema/models";
import { and, desc, eq, inArray, sql as dsql, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { accessBySlug, forgetMissing, granted, type Access } from "./auth/access.ts";
import { listedCreator, mayCreateWorkspaces, openInvite, usableInvite } from "./auth/eligibility.ts";
import { Limiter } from "./auth/limits.ts";
import { linkOrigin, mailLater, type Mailer } from "./auth/mail.ts";
import { inviteMail } from "./mail/emails.ts";
import { requireActor } from "./auth/routes.ts";
import { randomSecret, sha256 } from "./auth/secret.ts";
import { endSessionsIfIneligible } from "./auth/sessions.ts";
import { db, schema, type Tx } from "./db.ts";
import { clientKey, email, HttpError, limit, name, parse } from "./http.ts";
import { addMember, setMemberRole } from "./sync/members.ts";
import { uniqueViolation } from "./sync/retry.ts";
import { TxError } from "./sync/tx-error.ts";
import { GROUP_COLOR } from "./sync/settings.ts";
import { applyServerChange } from "./sync/write.ts";

const { workspace, member, user, invite, project, workflowState } = schema;

const MIN = 60_000;
const INVITE_MS = 7 * 24 * 60 * MIN;

/** A new project's workflow, as New project in the app sends it: the first state is the default. */

const lowerEmail = email.transform((e) => e.toLowerCase());
const role = z.enum(ASSIGNABLE_ROLES);
const createBody = z
  .object({
    name,
    slug: z.string().regex(WORKSPACE_SLUG, "an address is 3 to 32 lower-case letters, digits and hyphens"),
    color: z.enum(TILE_COLORS).nullable(),
    projects: z
      .array(z.object({ name, key: z.string().regex(PROJECT_KEY, "a key is a letter, then up to 11 letters or digits, upper case") }).strict())
      .max(10),
  })
  .strict();

/**
 * Slugs a browser would read as a host: "//3405803781/x" or "//0x7f000001/x" leaves the site. The web never builds a
 * URL from a raw path (sign-in.tsx), and new workspaces do not take such names either. Existing ones stay valid.
 */
const HOST_LIKE = /^(?:\d+|0x[0-9a-f]+)$/;

/** Why a slug can't be taken, or null when it is free. */
async function slugProblem(slug: string): Promise<string | null> {
  if (!WORKSPACE_SLUG.test(slug)) return "Use 3 to 32 lower-case letters, digits and hyphens.";
  if (HOST_LIKE.test(slug)) return "Add a letter: an address can't be only a number.";
  if (RESERVED_SLUGS.has(slug)) return "This address is reserved.";
  const [w] = await db.select({ id: workspace.id }).from(workspace).where(eq(workspace.slug, slug));
  return w ? "This address is taken." : null;
}

/** Invites as the invited person sees them. */
async function inviteViews(where: ReturnType<typeof and>): Promise<(InviteView & { workspaceId: string })[]> {
  const inviter = schema.user;
  const rows = await db
    .select({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      invitedBy: inviter.name,
      workspaceId: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      color: workspace.color,
      members: dsql<number>`(select count(*)::int from ${member} where ${member.workspaceId} = ${workspace.id})`,
    })
    .from(invite)
    .innerJoin(workspace, eq(workspace.id, invite.workspaceId))
    .leftJoin(inviter, eq(inviter.id, invite.invitedById))
    .where(where)
    .orderBy(desc(invite.createdAt));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role as AssignableRole,
    invitedBy: r.invitedBy,
    workspaceId: r.workspaceId,
    workspace: { slug: r.slug, name: r.name, color: r.color, members: r.members },
  }));
}

/**
 * Accepts a live invite as this user, whose address it must be: adds the member (one User action) and uses up the
 * invite. An invite of someone who is a member already is used up without a change.
 */
/** Revokes an open invite by its id where `whose` holds (the workspace's, or the person's own); none when there is no such invite. */
async function revokeInvite(id: string, whose: SQL): Promise<{ email: string } | undefined> {
  if (!UUID.test(id)) return undefined;
  const [done] = await db.update(invite).set({ revokedAt: dsql`now()` }).where(and(eq(invite.id, id), whose, openInvite())).returning({ email: invite.email });
  return done;
}

/** The names an invite mail gives: the workspace's and the inviter's. */
async function inviteNames(workspaceId: string, inviterId: string): Promise<{ workspace: string; inviter: string }> {
  const [[ws], [me]] = await Promise.all([db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, workspaceId)), db.select({ name: user.name }).from(user).where(eq(user.id, inviterId))]);
  return { workspace: ws!.name, inviter: me!.name };
}

async function accept(inviteId: string, userId: string): Promise<{ slug: string }> {
  const [row] = await db
    .select({ workspaceId: invite.workspaceId, slug: workspace.slug })
    .from(invite)
    .innerJoin(workspace, eq(workspace.id, invite.workspaceId))
    .where(eq(invite.id, inviteId));
  if (!row) throw new TxError("not_found", "This invite no longer works.");
  await applyServerChange(row.workspaceId, userId, async (tx: Tx) => {
    const [i] = await tx.select().from(invite).where(and(eq(invite.id, inviteId), usableInvite())).for("update");
    if (!i) throw new TxError("not_found", "This invite no longer works.");
    // The sender's role again, its row held until commit: a demotion running at the same time waits for this join or
    // makes it fail, never lets it through on the role it is taking away (setMemberRole locks the same row).
    const [sender] = i.invitedById
      ? await tx.select({ role: member.role }).from(member).where(and(eq(member.workspaceId, i.workspaceId), eq(member.userId, i.invitedById))).for("share")
      : [];
    if (!mayManage(sender?.role)) throw new TxError("not_found", "This invite no longer works.");
    const [u] = await tx.select({ email: user.email }).from(user).where(eq(user.id, userId));
    if (!u || u.email.toLowerCase() !== i.email) throw new TxError("wrong_account", `This invite is for ${i.email}.`);
    await tx.update(invite).set({ acceptedAt: dsql`now()` }).where(eq(invite.id, inviteId));
    const added = await addMember(tx, i.workspaceId, userId, i.role as AssignableRole);
    return added ? [added] : [];
  });
  return { slug: row.slug };
}

function inviteNotice(origin: string, secret: string, to: string, inviterName: string, workspaceName: string, role: AssignableRole, expiresAt: string) {
  return inviteMail({ to, link: `${origin}/join/${secret}`, inviterName, workspaceName, role, expiresAt: new Date(expiresAt), origin });
}

export function registerWorkspaceApi(root: FastifyInstance, mailer: Mailer): void {
  void root.register(async (app) => routes(app, mailer));
}

function routes(app: FastifyInstance, mailer: Mailer): void {
  const session = { preHandler: requireActor({ sessionOnly: true }) };
  const invitesByWorkspace = new Limiter(100, 60 * MIN);
  // Per sender across all their workspaces: an admin of many workspaces still sends a bounded number of mails from our
  // address (and only listed people create workspaces, RSVA_WORKSPACE_CREATORS).
  const invitesBySender = new Limiter(50, 24 * 60 * MIN);
  const createByUser = new Limiter(10, 24 * 60 * MIN);
  const slugChecks = new Limiter(120, 15 * MIN);
  const linksByIp = new Limiter(60, 15 * MIN);

  /** The workspace of the path; a 404 or 403 unless the viewer may manage its members. */
  async function managed(req: FastifyRequest<{ Params: { ws: string } }>): Promise<Access> {
    const a = granted(await accessBySlug(req.actor!, req.params.ws));
    if (!can(a.viewer, "members.manage")) throw new HttpError(403, "forbidden", `a ${a.role} cannot manage members`);
    return a;
  }

  /** Pending invites of a workspace, the expired ones too (an admin sends them again or revokes them). */
  async function pending(workspaceId: string, ids?: string[]): Promise<PendingInvite[]> {
    const inviter = schema.user;
    const rows = await db
      .select({ id: invite.id, email: invite.email, role: invite.role, invitedBy: inviter.name, createdAt: invite.createdAt, expiresAt: invite.expiresAt })
      .from(invite)
      .leftJoin(inviter, eq(inviter.id, invite.invitedById))
      .where(and(eq(invite.workspaceId, workspaceId), openInvite(), ids ? inArray(invite.id, ids) : undefined))
      .orderBy(desc(invite.createdAt));
    return rows.map((r) => ({ ...r, role: r.role as AssignableRole }));
  }

  // ── Invites, for admins ─────────────────────────────────────────────────────────────────────────────────────

  app.get<{ Params: { ws: string } }>("/api/v1/workspaces/:ws/invites", session, async (req) => {
    const w = await managed(req);
    return { invites: await pending(w.workspaceId) };
  });

  app.post<{ Params: { ws: string }; Body: unknown }>("/api/v1/workspaces/:ws/invites", session, async (req, reply) => {
    const w = await managed(req);
    const body = parse(z.object({ emails: z.array(lowerEmail).min(1).max(50), role }).strict(), req.body);
    const emails = [...new Set(body.emails)];
    for (const _ of emails) {
      limit(invitesByWorkspace, w.workspaceId);
      limit(invitesBySender, req.actor!.userId);
    }
    const members = (
      await db
        .select({ email: dsql<string>`lower(${user.email})` })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(eq(member.workspaceId, w.workspaceId), inArray(dsql`lower(${user.email})`, emails)))
    ).map((r) => r.email);
    const toInvite = emails.filter((e) => !members.includes(e));
    const secrets = new Map(toInvite.map((e) => [e, randomSecret()]));
    const expiresAt = new Date(Date.now() + INVITE_MS).toISOString();
    let ids: string[];
    try {
      ids = await db.transaction(async (tx) => {
        const out: string[] = [];
        for (const e of toInvite) {
          const row = { role: body.role, hash: sha256(secrets.get(e)!), invitedById: req.actor!.userId, createdAt: new Date().toISOString(), expiresAt };
          // One live invite per address: a second one replaces the first's secret, role and time.
          const [old] = await tx.select({ id: invite.id }).from(invite).where(and(eq(invite.workspaceId, w.workspaceId), eq(invite.email, e), openInvite())).for("update");
          if (old) await tx.update(invite).set(row).where(eq(invite.id, old.id));
          const id = old?.id ?? (await tx.insert(invite).values({ workspaceId: w.workspaceId, email: e, ...row }).returning({ id: invite.id }))[0]!.id;
          out.push(id);
        }
        return out;
      });
    } catch (e) {
      // Another admin invited the same address at the same moment: the live-invite index answers for the second.
      if (uniqueViolation(e)) return reply.code(409).send({ error: "conflict", message: "Someone invited this address at the same moment. Try again." });
      throw e;
    }
    const names = await inviteNames(w.workspaceId, req.actor!.userId);
    for (const e of toInvite) mailLater(mailer, inviteNotice(linkOrigin(req.headers.origin), secrets.get(e)!, e, names.inviter, names.workspace, body.role, expiresAt), req.log, "invite");
    const result: InviteResult = { invited: ids.length ? await pending(w.workspaceId, ids) : [], members };
    return reply.code(201).send(result);
  });

  app.post<{ Params: { ws: string; id: string } }>("/api/v1/workspaces/:ws/invites/:id/resend", session, async (req, reply) => {
    const w = await managed(req);
    limit(invitesByWorkspace, w.workspaceId);
    limit(invitesBySender, req.actor!.userId);
    if (!UUID.test(req.params.id)) return reply.code(404).send({ error: "not_found", message: "no such invite" });
    const secret = randomSecret();
    const expiresAt = new Date(Date.now() + INVITE_MS).toISOString();
    const [i] = await db
      .update(invite)
      .set({ hash: sha256(secret), invitedById: req.actor!.userId, createdAt: dsql`now()`, expiresAt })
      .where(and(eq(invite.id, req.params.id), eq(invite.workspaceId, w.workspaceId), openInvite()))
      .returning({ email: invite.email, role: invite.role });
    if (!i) return reply.code(404).send({ error: "not_found", message: "no such invite" });
    const names = await inviteNames(w.workspaceId, req.actor!.userId);
    mailLater(mailer, inviteNotice(linkOrigin(req.headers.origin), secret, i.email, names.inviter, names.workspace, i.role as AssignableRole, expiresAt), req.log, "invite");
    return (await pending(w.workspaceId, [req.params.id]))[0];
  });

  app.delete<{ Params: { ws: string; id: string } }>("/api/v1/workspaces/:ws/invites/:id", session, async (req, reply) => {
    const w = await managed(req);
    const done = await revokeInvite(req.params.id, eq(invite.workspaceId, w.workspaceId));
    if (!done) return reply.code(404).send({ error: "not_found", message: "no such invite" });
    // The invite may have been the address's last reason to be signed in.
    await endSessionsIfIneligible({ email: done.email });
    return reply.code(204).send();
  });

  // ── The invited person ──────────────────────────────────────────────────────────────────────────────────────

  // By the link, signed in or not: what the invite page shows. Anything but a live invite is the same 404.
  app.get<{ Params: { secret: string } }>("/api/v1/invites/:secret", async (req, reply) => {
    limit(linksByIp, clientKey(req.ip));
    const [v] = req.params.secret.length <= 64 ? await inviteViews(and(eq(invite.hash, sha256(req.params.secret)), usableInvite())) : [];
    if (!v) return reply.code(404).send({ error: "not_found", message: "This invite link no longer works." });
    const { workspaceId: _, ...view } = v;
    return reply.header("cache-control", "no-store").send(view);
  });

  app.post<{ Params: { secret: string } }>("/api/v1/invites/:secret/accept", session, async (req, reply) => {
    limit(linksByIp, clientKey(req.ip));
    const [i] = req.params.secret.length <= 64 ? await db.select({ id: invite.id }).from(invite).where(eq(invite.hash, sha256(req.params.secret))) : [];
    if (!i) return reply.code(404).send({ error: "not_found", message: "This invite link no longer works." });
    return accept(i.id, req.actor!.userId);
  });

  /** The signed-in person's address, lower-cased. */
  const myEmail = async (req: FastifyRequest) => (await db.select({ email: user.email }).from(user).where(eq(user.id, req.actor!.userId)))[0]!.email.toLowerCase();

  // Invites to the signed-in person's address: for the "no workspace yet" screen and "Join" in the create dialog.
  app.get("/api/v1/me/invites", session, async (req) => {
    const views = await inviteViews(and(eq(invite.email, await myEmail(req)), usableInvite()));
    return { invites: views.map(({ workspaceId: _, ...v }) => v) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/me/invites/:id/accept", session, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send({ error: "not_found", message: "no such invite" });
    return accept(req.params.id, req.actor!.userId);
  });

  // Declining the last invite without a workspace ends the session too (eligibility.ts).
  app.post<{ Params: { id: string } }>("/api/v1/me/invites/:id/decline", session, async (req, reply) => {
    if (!(await revokeInvite(req.params.id, eq(invite.email, await myEmail(req))))) return reply.code(404).send({ error: "not_found", message: "no such invite" });
    await endSessionsIfIneligible({ userId: req.actor!.userId });
    return reply.code(204).send();
  });

  // ── Leaving and new workspaces ──────────────────────────────────────────────────────────────────────────────

  app.post<{ Params: { ws: string } }>("/api/v1/workspaces/:ws/leave", session, async (req, reply) => {
    const a = await accessBySlug(req.actor!, req.params.ws);
    if ("status" in a) return reply.code(404).send({ error: "not_found", message: a.error });
    const me = req.actor!.userId;
    await applyServerChange(a.workspaceId, me, async (tx) => {
      const left = await setMemberRole(tx, a.workspaceId, me, me, null);
      return left ? [left] : [];
    });
    return reply.code(204).send();
  });

  /** True after replying 403 when the signed-in person may not create workspaces (a boolean: a reply is a thenable). */
  async function notCreator(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (await mayCreateWorkspaces(await myEmail(req))) return false;
    reply.code(403).send({ error: "forbidden", message: "Creating workspaces is limited to the people this server lists. Ask its admin, or join one you were invited to." });
    return true;
  }

  // Creators only: the check tells taken addresses, and nobody else needs it.
  app.get<{ Params: { slug: string } }>("/api/v1/workspace-slugs/:slug", session, async (req, reply) => {
    if (await notCreator(req, reply)) return reply;
    limit(slugChecks, req.actor!.userId);
    const problem = await slugProblem(req.params.slug);
    return problem ? { available: false, reason: problem } : { available: true };
  });

  app.post<{ Body: unknown }>("/api/v1/workspaces", session, async (req, reply) => {
    if (await notCreator(req, reply)) return reply;
    const body = parse(createBody, req.body) as CreateWorkspace;
    const keys = body.projects.map((p) => p.key);
    if (new Set(keys).size !== keys.length) return reply.code(400).send({ error: "invalid", message: "two projects have the same key" });
    const problem = await slugProblem(body.slug);
    if (problem) return reply.code(409).send({ error: "conflict", message: problem });
    limit(createByUser, req.actor!.userId);
    const mine = await myEmail(req);
    try {
      await db.transaction(async (tx) => {
        // A person let in from the waitlist creates one workspace (ADR 0054): the entry is used up here, in the same
        // transaction, so two creates at once make one workspace and the other is refused.
        if (!listedCreator(mine)) {
          const { waitlist } = schema;
          const used = await tx
            .update(waitlist)
            .set({ usedAt: dsql`now()` })
            .where(and(eq(waitlist.email, mine), dsql`${waitlist.admittedAt} is not null`, dsql`${waitlist.usedAt} is null`))
            .returning({ id: waitlist.id });
          if (!used.length) throw new HttpError(403, "forbidden", "Your invitation from the waitlist was used for a workspace already.");
        }
        const [w] = await tx.insert(workspace).values({ slug: body.slug, name: body.name, color: body.color }).returning({ id: workspace.id });
        // The notifier reads a new workspace from its first action (an existing one it meets late starts at the end).
        await tx.insert(schema.notifyCursor).values({ workspaceId: w!.id, lastId: 0 });
        await tx.insert(member).values({ workspaceId: w!.id, userId: req.actor!.userId, role: "owner" });
        for (const p of body.projects) {
          const [row] = await tx.insert(project).values({ workspaceId: w!.id, key: p.key, name: p.name }).returning({ id: project.id });
          await tx.insert(workflowState).values(DEFAULT_STATES.map((s) => ({ ...s, projectId: row!.id, color: GROUP_COLOR[s.group]! })));
        }
      });
    } catch (e) {
      // Two people took the same address at once: the unique index answers for the second.
      if (uniqueViolation(e)) return reply.code(409).send({ error: "conflict", message: "This address is taken." });
      throw e;
    }
    forgetMissing(body.slug);
    return reply.code(201).send({ slug: body.slug });
  });
}
