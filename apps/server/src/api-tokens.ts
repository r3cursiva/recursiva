// API tokens over REST: list, make, change the access of, revoke (PLNR-20, PLNR-271). Managed from a signed-in browser
// only: a token cannot mint tokens or widen itself. Anyone may hold tokens for themselves; tokens for the workspace's agents
// need "agents.manage" (admins). The secret is in the creation answer and nowhere else.
//
// Access is read, write (what the member may do, following it) or custom: reads plus chosen grants, as Stripe's restricted
// keys (packages/policy, ADR 0037). A custom token's grants never go past what its member may do (grantable). Making a
// token, and widening one (anything it could not do before, now or later; to write always: policy `widens`), needs a
// fresh sign-in, as adding a passkey does: a token outlives the session that made it, and so does a widened one. Narrowing
// does not: it is protection, not new access.
import { can, grantable, isGrant, isRole, isScope, widens, type Grant, type Role, type Scope } from "@rsva/policy";
import { UUID } from "@rsva/schema/models";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { workspaceOf } from "./api-tx.ts";
import type { Access } from "./auth/access.ts";
import { linkOrigin, mailLater, type Mailer } from "./auth/mail.ts";
import { freshBrowserMailed } from "./auth/routes.ts";
import { createToken, listTokens, revokeToken, setTokenGrants } from "./auth/tokens.ts";
import { db, schema } from "./db.ts";
import { tokenMadeMail } from "./mail/emails.ts";
import { closeSockets } from "./sync/socket.ts";

const { apiToken, member, user, workspace } = schema;

/** The member a token belongs to, as its access is judged: role in the workspace and kind. */
interface Holder {
  id: string;
  role: Role;
  kind: string;
}

type AccessBody = { scope?: unknown; grants?: unknown };

/** The access asked for, checked against what the holder may do in the workspace; a 400 or 403 and null when not. */
function accessOf(body: AccessBody, holder: Holder, rights: readonly string[], reply: FastifyReply): { scope: Scope; grants: Grant[] } | null {
  const { scope, grants } = body;
  if (!isScope(scope)) return (reply.code(400).send({ error: "invalid", message: 'scope: "read", "write" or "custom"' }), null);
  if (scope !== "custom") {
    if (grants !== undefined && !(Array.isArray(grants) && grants.length === 0)) return (reply.code(400).send({ error: "invalid", message: 'grants: only with scope "custom"' }), null);
    return { scope, grants: [] };
  }
  if (!Array.isArray(grants) || grants.length === 0 || !grants.every(isGrant) || new Set(grants).size !== grants.length)
    return (reply.code(400).send({ error: "invalid", message: "grants: one or more distinct grants, such as issues.write or labels.write" }), null);
  const may = grantable(holder.role, rights);
  const over = grants.filter((g) => !may.includes(g));
  if (over.length) return (reply.code(403).send({ error: "forbidden", message: `a token never goes past its member: a ${holder.role} here cannot ${over.join(", ")}` }), null);
  return { scope, grants };
}

/** A member of the workspace, with role and kind; null when there is none. */
async function memberWhere(workspaceId: string, who: SQL): Promise<Holder | null> {
  const [u] = await db
    .select({ id: user.id, kind: user.kind, role: member.role })
    .from(user)
    .innerJoin(member, and(eq(member.userId, user.id), eq(member.workspaceId, workspaceId)))
    .where(who);
  return u && isRole(u.role) ? { id: u.id, kind: u.kind, role: u.role } : null;
}

/**
 * A live token of the workspace the caller may manage, or null, which answers 404. Members manage their own tokens.
 * Admins (agents.manage) revoke any and change agents' tokens; another person's token is that person's to widen.
 */
async function manageable(w: Access, actorId: string, id: string, to: "revoke" | "change") {
  if (!UUID.test(id)) return null;
  const [t] = await db
    .select({ name: apiToken.name, userId: apiToken.userId, scope: apiToken.scope, grants: apiToken.grants, expiresAt: apiToken.expiresAt })
    .from(apiToken)
    .where(and(eq(apiToken.id, id), eq(apiToken.workspaceId, w.workspaceId), isNull(apiToken.revokedAt)));
  if (!t || !isScope(t.scope)) return null;
  const holder = await memberWhere(w.workspaceId, eq(user.id, t.userId));
  const own = t.userId === actorId;
  const admin = can(w.viewer, "agents.manage");
  if (to === "revoke") return own || admin ? { ...t, scope: t.scope, holder } : null;
  if (!holder || !(own || (admin && holder.kind === "agent"))) return null;
  return { ...t, scope: t.scope, holder };
}

/**
 * Who hears of a new token (RSVA-188) or a widened one (RSVA-507, with `was`): an agent's goes to every owner of the
 * workspace, the person's own to that person. A member's own token goes to them and not to the owners: made with a stolen
 * session, it reaches the one who can tell, and owners do not get a mail for every personal token.
 */
async function mailToken(
  mailer: Mailer,
  req: FastifyRequest,
  w: Access,
  holderId: string,
  made: { name: string; scope: Scope; grants: Grant[]; expiresAt: Date | null; was?: { scope: Scope; grants: readonly string[] } },
) {
  const people = (where: SQL) => db.select({ id: user.id, name: user.name, email: user.email, kind: user.kind }).from(user).where(where);
  const [[holder], [by], [ws]] = await Promise.all([
    people(eq(user.id, holderId)),
    people(eq(user.id, req.actor!.userId)),
    db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, w.workspaceId)),
  ]);
  if (!holder || !by || !ws) return;
  const agent = holder.id !== by.id;
  const to = agent
    ? (await db.select({ email: user.email }).from(member).innerJoin(user, eq(user.id, member.userId)).where(and(eq(member.workspaceId, w.workspaceId), eq(member.role, "owner")))).map((o) => o.email)
    : [holder.email];
  for (const address of to)
    mailLater(
      mailer,
      tokenMadeMail({
        to: address,
        tokenName: made.name,
        holder: { name: holder.name, email: holder.email, agent },
        scope: made.scope,
        grants: made.grants,
        expiresAt: made.expiresAt,
        ...(made.was ? { was: made.was } : {}),
        createdBy: { name: by.name, email: by.email },
        workspaceName: ws.name,
        origin: linkOrigin(req.headers.origin),
      }),
      req.log,
      "token notice",
    );
}

export function tokenRoutes(app: FastifyInstance, mailer: Mailer): void {
  const byPerson = {
    preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.actor!.via !== "session") return reply.code(403).send({ error: "forbidden", message: "tokens are managed by a signed-in person" });
    },
  };

  app.get<{ Params: { ws: string } }>("/api/v1/workspaces/:ws/tokens", byPerson, async (req) => {
    const w = await workspaceOf(req);
    return { tokens: await listTokens(w.workspaceId, w.rights, can(w.viewer, "agents.manage") ? undefined : req.actor!.userId) };
  });

  app.post<{ Params: { ws: string }; Body: (AccessBody & { name?: unknown; user?: unknown; expiresInDays?: unknown }) | null }>(
    "/api/v1/workspaces/:ws/tokens",
    byPerson,
    async (req, reply) => {
      const w = await workspaceOf(req);
      // Its finish mails, so it counts under the per-person limit of mailed steps (RSVA-249).
      freshBrowserMailed(req, "make a token");
      const body = req.body ?? {};
      const { name, user: email, expiresInDays } = body;
      if (typeof name !== "string" || !name.trim() || name.length > 100) return reply.code(400).send({ error: "invalid", message: "name: 1 to 100 characters" });
      if (expiresInDays !== undefined && !(Number.isInteger(expiresInDays) && (expiresInDays as number) > 0 && (expiresInDays as number) <= 3650))
        return reply.code(400).send({ error: "invalid", message: "expiresInDays: a whole number of days up to 3650" });
      let holder = await memberWhere(w.workspaceId, eq(user.id, req.actor!.userId));
      if (!holder) return reply.code(404).send({ error: "not_found", message: `no workspace ${req.params.ws}` });
      if (email !== undefined) {
        // Another member's token: only for the workspace's agents, and only by an admin.
        const u = typeof email === "string" ? await memberWhere(w.workspaceId, eq(user.email, email)) : null;
        if (!u) return reply.code(400).send({ error: "bad_ref", message: `no member ${String(email)}` });
        if (u.id !== holder.id) {
          if (u.kind !== "agent") return reply.code(403).send({ error: "forbidden", message: "tokens for another person are not allowed; tokens for agents are" });
          if (!can(w.viewer, "agents.manage")) return reply.code(403).send({ error: "forbidden", message: `a ${w.role} cannot create tokens for agents` });
          holder = u;
        }
      }
      const access = accessOf(body, holder, w.rights, reply);
      if (!access) return reply;
      const made = { name: name.trim(), ...access, expiresAt: typeof expiresInDays === "number" ? new Date(Date.now() + expiresInDays * 86_400_000) : null };
      const t = await createToken({ workspaceId: w.workspaceId, userId: holder.id, ...made, createdById: req.actor!.userId });
      // After the answer, and never failing it: a lookup or a mail that fails is logged.
      void mailToken(mailer, req, w, holder.id, made).catch((e: unknown) => req.log.error(e, "token notice not sent"));
      return reply.code(201).send(t);
    },
  );

  // A token's access, changed in place: the secret stays, so whatever holds it keeps working with the new grants.
  app.patch<{ Params: { ws: string; id: string }; Body: AccessBody | null }>("/api/v1/workspaces/:ws/tokens/:id", byPerson, async (req, reply) => {
    const w = await workspaceOf(req);
    const t = await manageable(w, req.actor!.userId, req.params.id, "change");
    if (!t?.holder) return reply.code(404).send({ error: "not_found", message: "no such token" });
    const { holder } = t;
    const access = accessOf(req.body ?? {}, holder, w.rights, reply);
    if (!access) return reply;
    const widened = widens(t, access);
    // Its finish mails, as making a token does, so it counts under the per-person limit of mailed steps (RSVA-249).
    if (widened) freshBrowserMailed(req, "widen a token");
    if (!(await setTokenGrants(w.workspaceId, req.params.id, access.scope, access.grants, req.actor!.userId))) return reply.code(404).send({ error: "not_found", message: "no such token" });
    // Open sockets hold the old access: closed, they reconnect with the new one.
    closeSockets(req.params.id);
    // Narrowing is protection, not new access, and mails nothing. After the answer, and never failing it (RSVA-507).
    if (widened)
      void mailToken(mailer, req, w, holder.id, { name: t.name, ...access, expiresAt: t.expiresAt ? new Date(t.expiresAt) : null, was: { scope: t.scope, grants: t.grants } }).catch((e: unknown) =>
        req.log.error(e, "token notice not sent"),
      );
    return reply.code(204).send();
  });

  app.delete<{ Params: { ws: string; id: string } }>("/api/v1/workspaces/:ws/tokens/:id", byPerson, async (req, reply) => {
    const w = await workspaceOf(req);
    if (!(await manageable(w, req.actor!.userId, req.params.id, "revoke"))) return reply.code(404).send({ error: "not_found", message: "no such token" });
    if (!(await revokeToken(w.workspaceId, req.params.id))) return reply.code(404).send({ error: "not_found", message: "no such token" });
    closeSockets(req.params.id);
    return reply.code(204).send();
  });
}
