// The viewer's inbox for agents and the CLI (PLNR-232), and for the bot's /inbox (PLNR-205). The lines are the ones the browser draws (inboxGroups of
// @rsva/protocol) over the same read (sync/inbox.ts), named by keys and emails. Marks are made as the browser makes
// them (markRead, markArchived) and reach the viewer's open tabs at once, as a mark sent over the socket does.
import { blankMark, inboxGroups, markArchived, markRead, type InboxGroup, type InboxMark, type ServerFrame } from "@rsva/protocol";
import { isLiveIssue } from "@rsva/schema/models";
import { inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { keyOf, loadNames } from "./api-names.ts";
import { workspaceOf } from "./api-tx.ts";
import { RateLimited } from "./auth/limits.ts";
import type { Access } from "./auth/access.ts";
import { db, schema } from "./db.ts";
import { sendToUser } from "./sync/hub.ts";
import { INBOX_COST, MARKS_MAX, MarkError, readInbox, writeMarks } from "./sync/inbox.ts";
import { reads } from "./sync/limits.ts";

type Ws = { ws: string };
const ACTIONS = ["read", "unread", "archive"] as const;

/** The workspace, after the read budget the socket's inbox answer also takes. */
async function inboxAccess(req: FastifyRequest<{ Params: Ws }>): Promise<Access> {
  const w = await workspaceOf(req);
  const me = req.actor!.userId;
  if (!reads.take(me, INBOX_COST)) throw new RateLimited(reads.retryAfter(me, INBOX_COST), "too many inbox requests");
  return w;
}

/** The viewer's lines with their issues and marks; issues the viewer no longer sees (archived, deleted) drop out. */
export async function linesOf(workspaceId: string, me: string) {
  const [frame, n] = await Promise.all([readInbox(workspaceId, me), loadNames(workspaceId)]);
  const ids = [...new Set(frame.e.map((e) => e.issueId))];
  const { issue } = schema;
  const rows = ids.length
    ? await db
        .select({ id: issue.id, projectId: issue.projectId, number: issue.number, title: issue.title, stateId: issue.stateId, createdById: issue.createdById, assigneeIds: issue.assigneeIds, archivedAt: issue.archivedAt, deletedAt: issue.deletedAt })
        .from(issue)
        .where(inArray(issue.id, ids))
    : [];
  const issues = new Map(rows.map((r) => [r.id, r]));
  const marks = new Map(frame.m.map((m) => [m.issueId, m]));
  const live = (id: string) => {
    const i = issues.get(id);
    return !!i && isLiveIssue(i);
  };
  const groups = inboxGroups(frame.e, (id) => marks.get(id), Date.now(), live);
  const key = (g: InboxGroup) => keyOf(n, issues.get(g.issueId)!);
  return { n, groups, issues, marks, key };
}

/** Writes marks as the browser sends them, and shows them in the viewer's open tabs at once. */
export async function writeLineMarks(workspaceId: string, me: string, next: InboxMark[]): Promise<void> {
  for (let i = 0; i < next.length; i += MARKS_MAX) {
    const r = await writeMarks(workspaceId, me, next.slice(i, i + MARKS_MAX));
    sendToUser(workspaceId, me, JSON.stringify({ t: "marks", ...r } satisfies ServerFrame));
  }
}

export function inboxRoutes(app: FastifyInstance): void {
  // The lines, newest first; snoozed ones only with ?all=1. `unread` counts what the badge in the app counts.
  app.get<{ Params: Ws; Querystring: { all?: string } }>("/api/v1/workspaces/:ws/inbox", async (req) => {
    const w = await inboxAccess(req);
    const { n, groups, issues, key } = await linesOf(w.workspaceId, req.actor!.userId);
    const all = req.query.all === "1" || req.query.all === "true";
    return {
      unread: groups.filter((g) => g.unread && !g.snoozedUntil).length,
      lines: (all ? groups : groups.filter((g) => !g.snoozedUntil)).map((g) => {
        const state = n.states.get(issues.get(g.issueId)!.stateId);
        return {
          key: key(g),
          title: issues.get(g.issueId)!.title,
          state: state?.name ?? null,
          stateGroup: state?.group ?? null,
          kind: g.latest.kind,
          kinds: [...new Set(g.events.map((e) => e.kind))],
          count: g.events.length,
          by: n.users.get(g.latest.by)?.email ?? null,
          at: g.latest.at,
          unread: g.unread,
          snoozedUntil: g.snoozedUntil,
        };
      }),
    };
  });

  // {"read": ["PLNR-9"]}, {"unread": […]} or {"archive": […]}; "all" instead of a list: every line that is not snoozed.
  app.post<{ Params: Ws; Body: Partial<Record<(typeof ACTIONS)[number], unknown>> | null }>("/api/v1/workspaces/:ws/inbox", async (req, reply) => {
    const w = await inboxAccess(req);
    if (w.viewer.scope === "read") return reply.code(403).send({ error: "forbidden", message: "the token is read-only" });
    const body = req.body ?? {};
    const given = ACTIONS.filter((a) => body[a] !== undefined);
    const target = given.length === 1 ? body[given[0]!] : undefined;
    const keys = Array.isArray(target) && target.length && target.every((k) => typeof k === "string") ? (target as string[]).map((k) => k.toUpperCase()) : null;
    if (target !== "all" && !keys) return reply.code(400).send({ error: "invalid", message: 'one of "read", "unread", "archive": a list of issue keys or "all"' });
    const me = req.actor!.userId;
    const { groups, marks, key } = await linesOf(w.workspaceId, me);
    const byKey = new Map(groups.map((g) => [key(g), g]));
    const missing = keys?.filter((k) => !byKey.has(k)) ?? [];
    if (missing.length) return reply.code(400).send({ error: "bad_ref", message: `nothing in your inbox for ${missing.join(", ")}` });
    const chosen = keys ? [...new Set(keys)].map((k) => byKey.get(k)!) : groups.filter((g) => !g.snoozedUntil);
    const action = given[0]!;
    const next = chosen.map((g) => {
      const m = marks.get(g.issueId) ?? blankMark(g.issueId);
      return action === "archive" ? markArchived(m, g.latest.id) : markRead(m, g.latest.id, action === "read");
    });
    try {
      await writeLineMarks(w.workspaceId, me, next);
    } catch (e) {
      if (!(e instanceof MarkError)) throw e;
      return reply.code(400).send({ error: "invalid", message: e.message });
    }
    return { ok: true, marked: next.length };
  });
}
