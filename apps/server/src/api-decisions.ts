// Decisions over REST (RSVA-644): an agent asks (`rsva ask`), a person answers or takes the answer back, everyone reads
// the questions and the rules (`rsva decisions`, `rsva rules`). Writes go through the write pipeline (sync/decisions.ts),
// which keeps the row and its comment in one transaction and holds the rules: an agent asks but never answers, and the
// grant they need is the comments' one (packages/policy).
//
// An agent that asks while it holds the issue's run ends that run as `asked`: it waits for the answer instead of
// guessing, the run is not an attempt (runs.ts), and the issue cannot be claimed again until the question is answered.
import { uuidv7 } from "@rsva/protocol";
import { can, refusal } from "@rsva/policy";
import { DECISION_KINDS, type Decision, type DecisionKind } from "@rsva/schema/models";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { keyOf, loadNames } from "./api-names.ts";
import { issueByKey, workspaceOf, writeTx, type IssueParams } from "./api-tx.ts";
import { db, schema } from "./db.ts";
import { HttpError } from "./http.ts";
import { decisionColumns } from "./sync/columns.ts";

const { decision, decisionRule, project, run, user } = schema;
type Ws = { ws: string };
type Body = Record<string, unknown> | null;

/** A decision as agents read it: the issue by key, people by email, options numbered from 1 as the CLI takes them. */
async function viewsOf(workspaceId: string, rows: Decision[]) {
  const n = await loadNames(workspaceId);
  const { issue } = schema;
  const issues = new Map((rows.length ? await db.select({ id: issue.id, projectId: issue.projectId, number: issue.number }).from(issue).where(eq(issue.workspaceId, workspaceId)) : []).map((i) => [i.id, i]));
  const email = (id: string | null) => (id ? (n.users.get(id)?.email ?? null) : null);
  return rows.map((d) => ({
    id: d.id,
    key: issues.has(d.issueId) ? keyOf(n, issues.get(d.issueId)!) : null,
    kind: d.kind,
    question: d.question,
    options: d.options,
    recommended: d.recommended + 1,
    evidence: d.evidence,
    topic: d.topic,
    askedBy: email(d.askedById),
    status: d.status,
    answer: d.answer,
    answerOption: d.answerOption === null ? null : d.answerOption + 1,
    answeredBy: email(d.answeredById),
    answeredAt: d.answeredAt,
    byRule: !!d.ruleId,
    createdAt: d.createdAt,
  }));
}

const textOf = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, "invalid", `${what}: text`);
  return v;
};

/** The body of an ask: options as {label, detail, why} or as plain labels; `recommend` counts from 1. */
function askOf(b: NonNullable<Body>, issueId: string) {
  const kind = (b.kind ?? "question") as DecisionKind;
  if (!DECISION_KINDS.includes(kind)) throw new HttpError(400, "invalid", `kind: one of ${DECISION_KINDS.join(", ")}`);
  if (!Array.isArray(b.options)) throw new HttpError(400, "invalid", "options: a list of 2 to 4");
  const options = b.options.map((o, i) => {
    const x = (typeof o === "string" ? { label: o } : o) as Record<string, unknown>;
    return { label: textOf(x?.label, `options[${i}].label`), detail: typeof x.detail === "string" ? x.detail : "", why: typeof x.why === "string" ? x.why : "" };
  });
  const recommend = b.recommend;
  if (typeof recommend !== "number" || !Number.isInteger(recommend)) throw new HttpError(400, "invalid", "recommend: the number of an option, from 1");
  const evidence = b.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.some((e) => typeof e !== "string")) throw new HttpError(400, "invalid", "evidence: a list of lines");
  const topic = b.topic === undefined || b.topic === null ? null : textOf(b.topic, "topic");
  return { issueId, kind, question: textOf(b.question, "question"), options, recommended: recommend - 1, evidence: evidence as string[], topic };
}

/** The caller's live run on the issue ends as `asked`: not an attempt, and the issue waits for the answer. */
async function endAsked(issueId: string, me: string): Promise<boolean> {
  const ended = await db
    .update(run)
    .set({ outcome: "asked", endedAt: new Date().toISOString() })
    .where(and(eq(run.issueId, issueId), eq(run.agentId, me), isNull(run.outcome)))
    .returning({ id: run.id });
  return ended.length > 0;
}

/** A decision of the path, in the workspace; a 404 when there is none. */
async function decisionOf(req: FastifyRequest<{ Params: Ws & { id: string } }>) {
  const w = await workspaceOf(req);
  const id = req.params.id;
  const [d] = /^[0-9a-f-]{36}$/i.test(id) ? await db.select({ id: decision.id }).from(decision).where(and(eq(decision.id, id), eq(decision.workspaceId, w.workspaceId))) : [];
  if (!d) throw new HttpError(404, "not_found", `no decision ${id}`);
  return { w, id };
}

const one = async (workspaceId: string, id: string) => (await viewsOf(workspaceId, (await db.select(decisionColumns).from(decision).where(eq(decision.id, id))) as Decision[]))[0]!;

export function decisionRoutes(app: FastifyInstance): void {
  // {"question": "…", "options": [{"label", "detail", "why"}…], "recommend": 1, "evidence": […], "topic": "…", "kind": "close"}
  app.post<{ Params: IssueParams; Body: Body }>("/api/v1/workspaces/:ws/issues/:key/decisions", async (req, reply) => {
    const found = await issueByKey(req);
    const id = uuidv7();
    await writeTx(req, found.w, [{ op: "create", m: "Decision", id, set: askOf(req.body ?? {}, found.issue.id) }]);
    const runEnded = await endAsked(found.issue.id, req.actor!.userId);
    return reply.code(201).send({ decision: await one(found.w.workspaceId, id), runEnded });
  });

  // The workspace's decisions, newest first; ?status=open (the default) or answered, or all.
  app.get<{ Params: Ws; Querystring: { status?: string } }>("/api/v1/workspaces/:ws/decisions", async (req) => {
    const w = await workspaceOf(req);
    const status = req.query.status ?? "open";
    if (!["open", "answered", "all"].includes(status)) throw new HttpError(400, "invalid", "status: open, answered or all");
    const rows = (await db
      .select(decisionColumns)
      .from(decision)
      .where(and(eq(decision.workspaceId, w.workspaceId), status === "all" ? undefined : eq(decision.status, status as "open" | "answered")))
      .orderBy(desc(decision.createdAt))
      .limit(500)) as Decision[];
    return { decisions: await viewsOf(w.workspaceId, rows) };
  });

  // {"option": 2} (from 1) or {"text": "…"}, and "rule": true to answer this topic so from now on. People only.
  app.post<{ Params: Ws & { id: string }; Body: Body }>("/api/v1/workspaces/:ws/decisions/:id/answer", async (req) => {
    const { w, id } = await decisionOf(req);
    const b = req.body ?? {};
    const option = b.option === undefined ? null : b.option;
    if (option !== null && (typeof option !== "number" || !Number.isInteger(option) || option < 1)) throw new HttpError(400, "invalid", "option: the number of an option, from 1");
    if (option === null && typeof b.text !== "string") throw new HttpError(400, "invalid", "option, or text: the answer in your own words");
    const set = { status: "answered" as const, option: option === null ? null : option - 1, ...(option === null ? { text: b.text as string } : {}), ...(b.rule === true ? { rule: true } : {}) };
    await writeTx(req, w, [{ op: "update", m: "Decision", id, set }]);
    return { decision: await one(w.workspaceId, id) };
  });

  // The answer taken back: by whoever gave it, within the undo window; its reply and rule go with it.
  app.post<{ Params: Ws & { id: string } }>("/api/v1/workspaces/:ws/decisions/:id/undo", async (req) => {
    const { w, id } = await decisionOf(req);
    await writeTx(req, w, [{ op: "update", m: "Decision", id, set: { status: "open" } }]);
    return { decision: await one(w.workspaceId, id) };
  });

  // Every rule of the workspace, by project and topic: agents read them before asking (`rsva rules`).
  app.get<{ Params: Ws }>("/api/v1/workspaces/:ws/decision-rules", async (req) => {
    const w = await workspaceOf(req);
    const rows = await db
      .select({ id: decisionRule.id, project: project.key, topic: decisionRule.topic, answer: decisionRule.answer, by: user.email, userId: decisionRule.userId, createdAt: decisionRule.createdAt })
      .from(decisionRule)
      .innerJoin(project, eq(project.id, decisionRule.projectId))
      .innerJoin(user, eq(user.id, decisionRule.userId))
      .where(eq(decisionRule.workspaceId, w.workspaceId))
      .orderBy(asc(project.key), asc(decisionRule.topic));
    return { rules: rows.map(({ userId, ...r }) => ({ ...r, mine: userId === req.actor!.userId })) };
  });

  // A person removes a rule: the comments' grant, and not an agent (it follows rules, it does not set them).
  app.delete<{ Params: Ws & { id: string } }>("/api/v1/workspaces/:ws/decision-rules/:id", async (req) => {
    const w = await workspaceOf(req);
    if (!can(w.viewer, "comments.write")) throw new HttpError(403, "forbidden", refusal(w.viewer, "comments.write", "remove a rule"));
    const [me] = await db.select({ kind: user.kind }).from(user).where(eq(user.id, req.actor!.userId));
    if (me?.kind === "agent") throw new HttpError(403, "forbidden", "rules are set by people");
    const id = req.params.id;
    const gone = /^[0-9a-f-]{36}$/i.test(id) ? await db.delete(decisionRule).where(and(eq(decisionRule.id, id), eq(decisionRule.workspaceId, w.workspaceId))).returning({ id: decisionRule.id }) : [];
    if (!gone.length) throw new HttpError(404, "not_found", `no rule ${id}`);
    return { ok: true };
  });
}
