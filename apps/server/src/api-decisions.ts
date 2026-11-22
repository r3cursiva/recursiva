// The Decisions screen's reads (RSVA-644): the questions agents put on issues that wait on the viewer, and the rules
// people saved from them. A question is an agent's comment in the shape `@rsva/protocol/decisions` reads; it is open
// while nobody but an agent has replied to it, and its issue is live and not closed. Answers are replies posted as any
// comment is (POST …/comments with `parentId`), so the agent reads them where it reads every comment.
//
// Who a question waits on is the review's rule (isReviewer in @rsva/protocol): the issue's creator, or whoever triages
// when an agent created it; and anyone the issue is assigned to.
import { askKind, ASK_MARKERS, parseAsk, type DecisionRule, type OpenDecision } from "@rsva/protocol/decisions";
import { canTriage } from "@rsva/protocol/my-work";
import { isReviewer } from "@rsva/protocol";
import { can, refusal } from "@rsva/policy";
import { isClosedGroup, issueKey } from "@rsva/schema/models";
import { and, asc, desc, eq, isNull, or, sql as dsql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { workspaceOf } from "./api-tx.ts";
import { criteriaOf } from "./api-runs.ts";
import { db, projectKeyIs, schema } from "./db.ts";
import { HttpError } from "./http.ts";

const { comment, issue, project, user, workflowState, workspace, decisionRule } = schema;
type Ws = { ws: string };

/** The most open questions one answer lists: a screen of cards, one at a time, has no use for thousands. */
const OPEN_MAX = 500;
const RULE_TEXT_MAX = 500;
const RULES_MAX = 200;

/** The open questions of a workspace that wait on `me`, oldest first. */
async function openDecisions(workspaceId: string, me: string, role: string): Promise<OpenDecision[]> {
  const reply = alias(comment, "reply");
  const replier = alias(user, "replier");
  const asker = alias(user, "asker");
  // Comments that start with a mark, by agents, on live and open issues of live projects, with no reply from a person.
  const marked = or(...Object.values(ASK_MARKERS).map((m) => dsql`ltrim(${comment.body}) like ${`${m.replace(/[\\%_]/g, "\\$&")}%`}`))!;
  const answered = db
    .select({ one: dsql`1` })
    .from(reply)
    .innerJoin(replier, eq(replier.id, reply.authorId))
    .where(and(eq(reply.parentId, comment.id), isNull(reply.deletedAt), dsql`${replier.kind} <> 'agent'`));
  const [rows, [ws]] = await Promise.all([
    db
      .select({
        id: comment.id,
        body: comment.body,
        by: comment.authorId,
        at: comment.createdAt,
        issueId: issue.id,
        number: issue.number,
        createdById: issue.createdById,
        createdByAgent: dsql<boolean>`exists (select 1 from ${user} where ${user.id} = ${issue.createdById} and ${user.kind} = 'agent')`,
        assigneeIds: issue.assigneeIds,
        group: workflowState.group,
        projectKey: project.key,
      })
      .from(comment)
      .innerJoin(asker, eq(asker.id, comment.authorId))
      .innerJoin(issue, eq(issue.id, comment.issueId))
      .innerJoin(project, eq(project.id, issue.projectId))
      .innerJoin(workflowState, eq(workflowState.id, issue.stateId))
      .where(and(eq(comment.workspaceId, workspaceId), isNull(comment.deletedAt), eq(asker.kind, "agent"), marked, isNull(issue.deletedAt), isNull(issue.archivedAt), isNull(project.archivedAt), dsql`not exists (${answered})`))
      .orderBy(asc(comment.createdAt))
      .limit(OPEN_MAX),
    db.select({ triagers: workspace.triagers }).from(workspace).where(eq(workspace.id, workspaceId)),
  ]);
  const triages = canTriage({ me: { id: me }, role, workspace: ws ?? null });
  const out: OpenDecision[] = [];
  for (const r of rows) {
    if (isClosedGroup(r.group)) continue;
    if (!r.assigneeIds.includes(me) && !isReviewer(me, triages, r.createdById, r.createdByAgent)) continue;
    const ask = parseAsk(r.body);
    if (!ask) continue;
    out.push({ ...ask, commentId: r.id, issueId: r.issueId, key: issueKey(r.projectKey, r.number), by: r.by!, at: r.at, doneWhen: askKind(r.body) === "hand" ? await criteriaOf(r.issueId) : [] });
  }
  return out;
}

const text = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, "invalid", `${what}: a non-empty string`);
  if (v.length > RULE_TEXT_MAX) throw new HttpError(400, "invalid", `${what}: at most ${RULE_TEXT_MAX} characters`);
  return v.trim();
};

async function rulesOf(workspaceId: string, me: string): Promise<(DecisionRule & { mine: boolean })[]> {
  const rows = await db
    .select({ id: decisionRule.id, project: project.key, question: decisionRule.question, answer: decisionRule.answer, createdAt: decisionRule.createdAt, userId: decisionRule.userId })
    .from(decisionRule)
    .innerJoin(project, eq(project.id, decisionRule.projectId))
    .where(eq(decisionRule.workspaceId, workspaceId))
    .orderBy(desc(decisionRule.createdAt));
  return rows.map(({ userId, ...r }) => ({ ...r, mine: userId === me }));
}

/** A person's own act: an agent does not save the rules it is to follow, and a read-only token writes nothing. */
async function personWriting(req: FastifyRequest<{ Params: Ws }>) {
  const w = await workspaceOf(req);
  // The grant an answer needs (it is a comment), so a read-only token, or a custom one without it, is refused as the
  // comments route refuses it; and only a person: a rule is the owner's answer, not the asking agent's.
  if (!can(w.viewer, "comments.write")) throw new HttpError(403, "forbidden", refusal(w.viewer, "comments.write", "save or remove a rule"));
  const [me] = await db.select({ kind: user.kind }).from(user).where(eq(user.id, req.actor!.userId));
  if (me?.kind === "agent") throw new HttpError(403, "forbidden", "rules are saved by people");
  return w;
}

export function decisionRoutes(app: FastifyInstance): void {
  // The questions that wait on the caller, oldest first, as the Decisions screen shows them.
  app.get<{ Params: Ws }>("/api/v1/workspaces/:ws/decisions", async (req) => {
    const w = await workspaceOf(req);
    return { decisions: await openDecisions(w.workspaceId, req.actor!.userId, w.role) };
  });

  // Every rule of the workspace, newest first: agents read them to answer before asking; `mine` marks the caller's own.
  app.get<{ Params: Ws }>("/api/v1/workspaces/:ws/decision-rules", async (req) => {
    const w = await workspaceOf(req);
    return { rules: await rulesOf(w.workspaceId, req.actor!.userId) };
  });

  // {"project": "INFRA", "question": "…", "answer": "…"}: "Answer the same way next time".
  app.post<{ Params: Ws; Body: Record<string, unknown> | null }>("/api/v1/workspaces/:ws/decision-rules", async (req, reply) => {
    const w = await personWriting(req);
    const b = req.body ?? {};
    const key = text(b.project, "project").toUpperCase();
    const question = text(b.question, "question");
    const answer = text(b.answer, "answer");
    const [p] = await db.select({ id: project.id, key: project.key }).from(project).where(and(eq(project.workspaceId, w.workspaceId), projectKeyIs(key)));
    if (!p) throw new HttpError(400, "bad_ref", `no project ${key}`);
    const [{ n } = { n: 0 }] = await db.select({ n: dsql<number>`count(*)::int` }).from(decisionRule).where(and(eq(decisionRule.workspaceId, w.workspaceId), eq(decisionRule.userId, req.actor!.userId)));
    if (n >= RULES_MAX) throw new HttpError(400, "too_many", `at most ${RULES_MAX} rules; remove one first`);
    const [row] = await db.insert(decisionRule).values({ workspaceId: w.workspaceId, projectId: p.id, userId: req.actor!.userId, question, answer }).returning({ id: decisionRule.id, createdAt: decisionRule.createdAt });
    return reply.code(201).send({ rule: { id: row!.id, project: p.key, question, answer, createdAt: row!.createdAt, mine: true } });
  });

  // One's own rule; another person's is not one's to remove.
  app.delete<{ Params: Ws & { id: string } }>("/api/v1/workspaces/:ws/decision-rules/:id", async (req) => {
    const w = await personWriting(req);
    const id = req.params.id;
    const gone = /^[0-9a-f-]{36}$/i.test(id)
      ? await db.delete(decisionRule).where(and(eq(decisionRule.id, id), eq(decisionRule.workspaceId, w.workspaceId), eq(decisionRule.userId, req.actor!.userId))).returning({ id: decisionRule.id })
      : [];
    if (!gone.length) throw new HttpError(404, "not_found", `no rule ${id} of yours`);
    return { ok: true };
  });
}
