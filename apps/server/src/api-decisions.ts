// Decisions over REST (RSVA-644): an agent asks (`rsva ask`), a person answers or takes the answer back, everyone reads
// the questions and the rules (`rsva decisions`, `rsva rules`). Writes go through the write pipeline (sync/decisions.ts),
// which keeps the row and its comment in one transaction and holds the rules: an agent asks but never answers, and the
// grant they need is the comments' one (packages/policy).
//
// A question is asked by the agent holding the issue's run, and asking ends that run as `asked` in the same transaction:
// the agent waits for the answer instead of guessing, the run is not an attempt (runs.ts), and the issue cannot be
// claimed again until the question is answered or no longer open (decisionOpen). Agents read answers here, not in the
// issue's thread.
import { uuidv7 } from "@rsva/protocol";
import { decisionOpen } from "@rsva/protocol/my-work";
import { can, mayManage, refusal } from "@rsva/policy";
import { DECISION_KINDS, type Decision, type DecisionKind } from "@rsva/schema/models";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { keyOf, loadNames } from "./api-names.ts";
import { issueByKey, workspaceOf, writeTx, type IssueParams } from "./api-tx.ts";
import { db, schema } from "./db.ts";
import { HttpError } from "./http.ts";
import { decisionColumns } from "./sync/columns.ts";

const { decision, decisionRule, issue, project, user, workflowState } = schema;
type Ws = { ws: string };
type Body = Record<string, unknown> | null;
/** The most rule-answered questions Rules lists, over every rule. */
const RULED_MAX = 200;

/** The issues of these decisions, with what decisionOpen reads of them. */
async function issuesOf(rows: Decision[]) {
  const ids = [...new Set(rows.map((d) => d.issueId))];
  const found = ids.length
    ? await db
        .select({ id: issue.id, projectId: issue.projectId, number: issue.number, archivedAt: issue.archivedAt, deletedAt: issue.deletedAt, group: workflowState.group, projectArchivedAt: project.archivedAt })
        .from(issue)
        .innerJoin(workflowState, eq(workflowState.id, issue.stateId))
        .innerJoin(project, eq(project.id, issue.projectId))
        .where(inArray(issue.id, ids))
    : [];
  return new Map(found.map((i) => [i.id, i]));
}

/** Whether a decision waits, by the one rule (decisionOpen) the screen and the claim follow. */
const waits = (d: Decision, i: Awaited<ReturnType<typeof issuesOf>> extends Map<string, infer I> ? I | undefined : never) => !!i && decisionOpen(d, i, i.group, !!i.projectArchivedAt);

/** A decision as agents read it: the issue by key, people by email, options numbered from 1 as the CLI takes them. */
async function viewsOf(workspaceId: string, rows: Decision[], issues?: Awaited<ReturnType<typeof issuesOf>>) {
  const n = await loadNames(workspaceId);
  issues ??= await issuesOf(rows);
  const email = (id: string | null) => (id ? (n.users.get(id)?.email ?? null) : null);
  return rows.map((d) => ({
    id: d.id,
    key: issues.has(d.issueId) ? keyOf(n, issues.get(d.issueId)!) : null,
    kind: d.kind,
    question: d.question,
    options: d.options,
    recommended: d.recommended + 1,
    evidence: d.evidence,
    criteria: d.criteria,
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
  const criteria = b.criteria ?? [];
  if (!Array.isArray(criteria) || criteria.some((e) => typeof e !== "string")) throw new HttpError(400, "invalid", "criteria: a list of lines");
  return { issueId, kind, question: textOf(b.question, "question"), options, recommended: recommend - 1, evidence: evidence as string[], topic, criteria: criteria as string[] };
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
    const d = await one(found.w.workspaceId, id);
    // A question is asked by the run's holder, and ends the run in the ask's transaction unless a rule answered it.
    return reply.code(201).send({ decision: d, runEnded: d.kind === "question" && d.status === "open" });
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
    const issues = await issuesOf(rows);
    // Open means waiting: a question on a closed, archived or trashed issue waits on nobody (decisionOpen).
    const shown = status === "open" ? rows.filter((d) => waits(d, issues.get(d.issueId))) : rows;
    return { decisions: await viewsOf(w.workspaceId, shown, issues) };
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
      .select({ id: decisionRule.id, project: project.key, kind: decisionRule.kind, topic: decisionRule.topic, answer: decisionRule.answer, by: user.email, userId: decisionRule.userId, createdAt: decisionRule.createdAt })
      .from(decisionRule)
      .innerJoin(project, eq(project.id, decisionRule.projectId))
      .innerJoin(user, eq(user.id, decisionRule.userId))
      .where(eq(decisionRule.workspaceId, w.workspaceId))
      .orderBy(asc(project.key), asc(decisionRule.topic));
    // What each rule answered on its own, newest first, so the person who saved it can see what it decided for them.
    const ruled = rows.length
      ? ((await db
          .select(decisionColumns)
          .from(decision)
          .where(inArray(decision.ruleId, rows.map((r) => r.id)))
          .orderBy(desc(decision.answeredAt))
          .limit(RULED_MAX)) as Decision[])
      : [];
    const views = await viewsOf(w.workspaceId, ruled);
    return {
      rules: rows.map(({ userId, ...r }) => ({
        ...r,
        mine: userId === req.actor!.userId,
        answered: views.filter((v, i) => ruled[i]!.ruleId === r.id).map((v) => ({ key: v.key, question: v.question, answeredAt: v.answeredAt })),
      })),
    };
  });

  // A person removes their own rule, or an owner or admin anyone's: the comments' grant, and not an agent (it follows
  // rules, it does not set them).
  app.delete<{ Params: Ws & { id: string } }>("/api/v1/workspaces/:ws/decision-rules/:id", async (req) => {
    const w = await workspaceOf(req);
    if (!can(w.viewer, "comments.write")) throw new HttpError(403, "forbidden", refusal(w.viewer, "comments.write", "remove a rule"));
    const [me] = await db.select({ kind: user.kind }).from(user).where(eq(user.id, req.actor!.userId));
    if (me?.kind === "agent") throw new HttpError(403, "forbidden", "rules are set by people");
    const id = req.params.id;
    const [rule] = /^[0-9a-f-]{36}$/i.test(id) ? await db.select({ userId: decisionRule.userId }).from(decisionRule).where(and(eq(decisionRule.id, id), eq(decisionRule.workspaceId, w.workspaceId))) : [];
    if (!rule) throw new HttpError(404, "not_found", `no rule ${id}`);
    if (rule.userId !== req.actor!.userId && !mayManage(w.role)) throw new HttpError(403, "forbidden", "a rule is removed by the person who saved it, or an owner or admin");
    await db.delete(decisionRule).where(eq(decisionRule.id, id));
    return { ok: true };
  });
}
