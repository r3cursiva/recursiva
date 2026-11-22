// Decisions in the write pipeline (RSVA-644): an agent's question to a person, and the person's answer.
//
// A question is a row (what the Decisions screen and the agent read) and a comment that mirrors it for whoever reads the
// issue's thread; the answer sets the row and adds a reply to that comment, "Decision: …". Each pair is one transaction,
// so the thread and the row never disagree, from the browser, the API or the CLI alike.
//
// Rules: only a person answers (an agent asked, and answering itself would decide for the owner); the answer can be taken
// back by the person who gave it within DECISION_UNDO_MS, which opens the question again and deletes the reply. A
// question whose topic a rule of its project covers is answered as it is written, by the rule, with a reply naming it:
// exact topics only. A rule is saved with an answer (`rule: true`) and taken back with it.
//
// Compared: answering by a comment the server parses (the first version of this screen: no table, but a second store of
// questions in free text, and nothing an offline client could count), and a server-only table read over REST (an extra
// request at every start, and no offline queue). A synced row costs one model in the snapshot and gives both.
import { DECISION_CRITERIA_MAX, DECISION_EVIDENCE_MAX, DECISION_KINDS, DECISION_OPTIONS_MAX, DECISION_OPTIONS_MIN, DECISION_TEXT_MAX, DECISION_UNDO_MS, CLOSE_AS, CLOSE_OPTION, HANDOFF_OPTION, issueKey, type Decision, type DecisionAnswer, type DecisionCreate, type IssueUpdate } from "@rsva/schema/models";
import type { CommentCreate, Op } from "@rsva/protocol";
import type { DocNode, NodeName } from "@rsva/editor/doc";
import { toMarkdown } from "@rsva/editor/markdown";
import { mayManage, type Capability } from "@rsva/policy";
import { decisionOpen } from "@rsva/protocol/my-work";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { schema, type Tx } from "../db.ts";
import { doneWhen } from "../done-when.ts";
import { decisionColumns } from "./columns.ts";
import { created, lockOwned } from "./rows.ts";
import { TxError, type Pending } from "./tx-error.ts";

const { decision, decisionRule, document, issue, member, project, run, user, workflowState } = schema;

const uuid = z.uuid();
const target = { id: uuid };
const words = z.string().max(DECISION_TEXT_MAX).transform((s) => s.replace(/\s+/g, " ").trim());
const needed = words.pipe(z.string().min(1, "empty"));
const option = z.object({ label: needed, detail: words.default(""), why: words.default("") }).strict();
const create = z
  .object({
    issueId: uuid,
    kind: z.enum(DECISION_KINDS),
    question: needed,
    options: z.array(option).min(DECISION_OPTIONS_MIN).max(DECISION_OPTIONS_MAX),
    recommended: z.number().int().min(0),
    evidence: z.array(needed).max(DECISION_EVIDENCE_MAX),
    topic: needed.nullable(),
    criteria: z.array(needed).max(DECISION_CRITERIA_MAX).default([]),
    closeAs: z.enum(CLOSE_AS).nullable().default(null),
  })
  .strict()
  .refine((s) => s.recommended < s.options.length, "recommended: the number of one of the options")
  .refine((s) => s.kind !== "handoff" || s.criteria.length > 0, "a hand-off proposes its Done when: at least one criterion")
  .refine((s) => s.kind === "handoff" || s.criteria.length === 0, "criteria: a hand-off's only")
  .refine((s) => (s.kind === "close") === (s.closeAs !== null), "closeAs: where a close proposal takes the issue (done or canceled), and a close proposal's only");
const answer = z.discriminatedUnion("status", [
  z.object({ status: z.literal("answered"), option: z.number().int().min(0).nullable(), text: words.optional(), rule: z.boolean().optional() }).strict(),
  z.object({ status: z.literal("open") }).strict(),
]);

export const decisionOpSchemas = [
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("create"), m: z.literal("Decision"), ...target, set: create }).strict(),
    z.object({ op: z.literal("update"), m: z.literal("Decision"), ...target, set: answer }).strict(),
  ]),
] as const;

/**
 * What a decision writes besides itself, through the pipeline's own handlers (write.ts passes them in): comments, the
 * removal of its own reply on an undo (past the guard that keeps a decision's comments as written), and a description.
 */
export interface Comments {
  create(tx: Tx, workspaceId: string, actorId: string, id: string, set: CommentCreate): Promise<Pending>;
  remove(tx: Tx, workspaceId: string, id: string): Promise<Pending | null>;
  describe(tx: Tx, workspaceId: string, txId: string, op: Extract<Op, { m: "Document" }>): Promise<Pending | null>;
  /** An issue's state or delegate, as a person's change: the issue's history and the inboxes see it. */
  update(tx: Tx, workspaceId: string, actorId: string, issueId: string, set: IssueUpdate): Promise<Pending | null>;
}

const line = (s: string) => s.replace(/\s+/g, " ").trim();
const KIND_HEAD = { question: "Question", close: "Close proposal", handoff: "Hand-off" } as const;

/** The comment that mirrors a question in the issue's thread: the question, the options, the recommendation, the evidence. */
function askComment(d: Pick<Decision, "kind" | "question" | "options" | "recommended" | "evidence" | "criteria">): string {
  const options = d.options.map((o, i) => `${i + 1}. ${line(o.label)}${o.detail ? ` — ${line(o.detail)}` : ""}${i === d.recommended ? " (recommended)" : ""}`);
  const why = d.options[d.recommended]?.why;
  return [
    `**${KIND_HEAD[d.kind]}:** ${line(d.question)}`,
    "",
    ...options,
    ...(why ? ["", `Why ${d.recommended + 1}: ${line(why)}`] : []),
    ...(d.evidence.length ? ["", "Evidence:", ...d.evidence.map((e) => `- ${line(e)}`)] : []),
    ...(d.criteria.length ? ["", "Done when, as proposed:", ...d.criteria.map((c) => `- ${line(c)}`)] : []),
    "",
    "Answer it in Decisions.",
  ].join("\n");
}

/** The reply that answers it. */
const answerComment = (words: string, more = ""): string => `**Decision:** ${line(words)}${more ? `\n\n${more}` : ""}`;

/** The issue's project and key, the issue locked: two asks at once take turns, so one open question per issue holds. */
const issueOf = async (tx: Tx, workspaceId: string, issueId: string) => {
  const [i] = await tx
    .select({ projectId: issue.projectId, number: issue.number, key: project.key, deletedAt: issue.deletedAt, archivedAt: issue.archivedAt, group: workflowState.group, projectArchivedAt: project.archivedAt })
    .from(issue)
    .innerJoin(project, eq(project.id, issue.projectId))
    .innerJoin(workflowState, eq(workflowState.id, issue.stateId))
    .where(and(eq(issue.id, issueId), eq(issue.workspaceId, workspaceId)))
    .for("update", { of: issue });
  if (!i || i.deletedAt) throw new TxError("bad_ref", "issue is not in the workspace, or it is deleted");
  return { projectId: i.projectId, key: issueKey(i.key, i.number), open: decisionOpen({ status: "open" }, i, i.group, !!i.projectArchivedAt) };
};

/**
 * A question to a person. A plain question is the working agent's: only the holder of the issue's live run asks one, and
 * asking ends that run as `asked` in this transaction (not an attempt; the issue waits for the answer). A close proposal
 * or a hand-off needs no run. One open decision per issue. A rule of the project answers it as it is written only when
 * it is for this kind and topic and its answer is one of the options asked: an agent cannot make a rule say what it
 * offers, and a rule-answered decision has no person as its answerer (`ruleId`, no `answeredById`).
 */
export async function createDecision(tx: Tx, workspaceId: string, actorId: string, id: string, set: DecisionCreate, comments: Comments): Promise<Pending[]> {
  const where = await issueOf(tx, workspaceId, set.issueId);
  // Nothing is asked on an issue that waits on nobody (closed, archived): a decision there would hold a slot for nothing.
  if (!where.open) throw new TxError("invalid", `${where.key} is closed or archived: nothing is asked on it`);
  const [waiting] = await tx.select({ question: decision.question }).from(decision).where(and(eq(decision.issueId, set.issueId), eq(decision.kind, set.kind), eq(decision.status, "open")));
  if (waiting) throw new TxError("conflict", `${where.key} already waits on “${waiting.question}”: one open ${set.kind} per issue`);
  const [live] = set.kind === "question" ? await tx.select({ id: run.id }).from(run).where(and(eq(run.issueId, set.issueId), eq(run.agentId, actorId), isNull(run.outcome))).for("update") : [];
  if (set.kind === "question" && !live) throw new TxError("forbidden", `a question is asked by the agent working on ${where.key}: claim it first (rsva run claim ${where.key})`);
  const commentId = crypto.randomUUID();
  const out: Pending[] = [await comments.create(tx, workspaceId, actorId, commentId, { issueId: set.issueId, body: askComment(set) })];
  // Only a question is answered by a rule: a hand-off's criteria and a close are read and acted on by a person.
  const [rule] = set.topic && set.kind === "question"
    ? await tx
        .select({ id: decisionRule.id, answer: decisionRule.answer })
        .from(decisionRule)
        .where(and(eq(decisionRule.projectId, where.projectId), eq(decisionRule.kind, set.kind), eq(decisionRule.topic, set.topic)))
    : [];
  const option = rule ? set.options.findIndex((o) => o.label === rule.answer) : -1;
  let answered: Partial<typeof decision.$inferInsert> = {};
  if (rule && option >= 0) {
    const replyId = crypto.randomUUID();
    out.push(await comments.create(tx, workspaceId, actorId, replyId, { issueId: set.issueId, parentId: commentId, body: answerComment(rule.answer, `Answered by the rule for “${line(set.topic!)}” (rsva rules); nobody was asked.`) }));
    answered = { status: "answered", answer: rule.answer, answerOption: option, answeredAt: new Date().toISOString(), answerCommentId: replyId, ruleId: rule.id };
  } else if (live) {
    await tx.update(run).set({ outcome: "asked", endedAt: new Date().toISOString() }).where(eq(run.id, live.id));
  }
  const row = await created(
    tx
      .insert(decision)
      .values({ id, workspaceId, ...set, askedById: actorId, commentId, ...answered })
      .onConflictDoNothing()
      .returning(decisionColumns),
    `decision ${id}`,
  );
  return [...out, { m: "Decision", mid: id, a: "I", d: row as Record<string, unknown> }];
}

const node = (type: NodeName, content?: DocNode[], attrs?: Record<string, string | number | boolean>): DocNode => ({ type, ...(attrs ? { attrs } : {}), ...(content ? { content } : {}) });

/** What an answer did to its issue: the changes it wrote, and the words the reply says them in. */
interface Acted {
  pending: Pending[];
  note: string;
  undoStateId?: string;
}

/**
 * A hand-off handed over: its criteria become the issue's "Done when" section, after what the description holds, when it
 * has none (one it has is kept, and the reply says so), and the issue is delegated to the agent that asked, which finds
 * it with `agent:me is:ready`.
 */
async function handOver(tx: Tx, workspaceId: string, actorId: string, txId: string, row: Decision, comments: Comments): Promise<Acted> {
  const out: Pending[] = [];
  const [d] = await tx.select({ doc: document.doc }).from(document).where(eq(document.id, row.issueId));
  const doc = (d?.doc as DocNode | undefined) ?? { type: "doc", content: [] };
  let note: string;
  if (doneWhen(toMarkdown(doc)).length) note = "The issue has its own Done when, so it is kept; the proposed criteria were not written.";
  else {
    const section = [node("heading", [{ type: "text", text: "Done when" }], { level: 2 }), node("bullet_list", row.criteria.map((c) => node("list_item", [node("paragraph", [{ type: "text", text: line(c) }])])))];
    const content = (doc.content ?? []).filter((n) => !(n.type === "paragraph" && !n.content?.length));
    const p = await comments.describe(tx, workspaceId, txId, { op: "update", m: "Document", id: row.issueId, set: { doc: { type: "doc", content: [...content, ...section] } as never } });
    if (p) out.push(p);
    note = "Its Done when is now in the description.";
  }
  const [asker] = await tx.select({ kind: user.kind, name: user.name }).from(user).where(eq(user.id, row.askedById));
  if (asker?.kind === "agent") {
    const p = await comments.update(tx, workspaceId, actorId, row.issueId, { delegateId: row.askedById });
    if (p) out.push(p);
    note += ` Delegated to ${line(asker.name)}.`;
  }
  return { pending: out, note };
}

/** A close proposal's close: the issue to its project's state for done (the completed group) or canceled. */
async function closeIt(tx: Tx, workspaceId: string, actorId: string, row: Decision, comments: Comments): Promise<Acted> {
  const [i] = await tx.select({ projectId: issue.projectId, stateId: issue.stateId }).from(issue).where(eq(issue.id, row.issueId));
  const group = row.closeAs === "canceled" ? "cancelled" : "completed";
  const [to] = await tx
    .select({ id: workflowState.id, name: workflowState.name })
    .from(workflowState)
    .where(and(eq(workflowState.projectId, i!.projectId), eq(workflowState.group, group)))
    .orderBy(desc(workflowState.isDefault), asc(workflowState.position))
    .limit(1);
  if (!to) throw new TxError("invalid", `the project has no ${group} state to close the issue in`);
  const p = await comments.update(tx, workspaceId, actorId, row.issueId, { stateId: to.id });
  return { pending: p ? [p] : [], note: `Closed as ${row.closeAs}: moved to ${line(to.name)}.`, undoStateId: i!.stateId };
}

export async function answerDecision(tx: Tx, workspaceId: string, actorId: string, txId: string, agent: boolean, may: (cap: Capability) => boolean, id: string, set: DecisionAnswer, comments: Comments): Promise<Pending[]> {
  if (agent) throw new TxError("forbidden", "only a person answers a decision; the agent that asked waits for the answer");
  const row = await lockOwned(tx, decision, workspaceId, id, "decision");
  if (set.status === "open") return reopen(tx, workspaceId, actorId, row, comments);
  if (row.status !== "open") throw new TxError("conflict", "the decision is answered already");
  const text = set.option === null ? (set.text ?? "") : row.options[set.option]?.label;
  if (text === undefined) throw new TxError("invalid", `option: one of 0…${row.options.length - 1}`);
  if (!text) throw new TxError("invalid", "an answer in one's own words needs the words");
  if (set.rule && row.kind !== "question") throw new TxError("invalid", "only a question is answered by a rule: a hand-off and a close are a person's every time");
  // Handing over and closing change the issue: the issues' grant too, checked before anything is written.
  const hands = row.kind === "handoff" && set.option === HANDOFF_OPTION;
  const closes = row.kind === "close" && set.option === CLOSE_OPTION;
  if ((hands || closes) && !may("issues.write")) throw new TxError("forbidden", `${hands ? "handing an issue over" : "closing an issue"} changes it: that needs the issues grant`);
  const acted: Acted = hands ? await handOver(tx, workspaceId, actorId, txId, row, comments) : closes ? await closeIt(tx, workspaceId, actorId, row, comments) : { pending: [], note: "" };
  const replyId = crypto.randomUUID();
  const out: Pending[] = [await comments.create(tx, workspaceId, actorId, replyId, { issueId: row.issueId, ...(row.commentId ? { parentId: row.commentId } : {}), body: answerComment(text, acted.note) }), ...acted.pending];
  const changed = { status: "answered" as const, answer: text, answerOption: set.option, answeredById: actorId, answeredAt: new Date().toISOString(), answerCommentId: replyId };
  const replacedRule = set.rule && row.topic ? await saveRule(tx, workspaceId, actorId, row, text) : null;
  await tx.update(decision).set({ ...changed, replacedRule, undoStateId: acted.undoStateId ?? null }).where(eq(decision.id, id));
  return [...out, { m: "Decision", mid: id, a: "U", d: { issueId: row.issueId, ...changed }, p: { status: row.status } }];
}

/**
 * "Same next time": the topic's rule for this kind in the project, this answer. Another person's rule is theirs, or an
 * owner's or admin's, to change. The rule it replaces is returned as it was, so an undo puts it back.
 */
async function saveRule(tx: Tx, workspaceId: string, actorId: string, row: Decision, answer: string): Promise<NonNullable<typeof decision.$inferSelect.replacedRule> | null> {
  const { projectId } = await issueOf(tx, workspaceId, row.issueId);
  const key = and(eq(decisionRule.projectId, projectId), eq(decisionRule.kind, row.kind), eq(decisionRule.topic, row.topic!));
  const [held] = await tx.select().from(decisionRule).where(key).for("update");
  if (held && held.userId !== actorId) {
    const [m] = await tx.select({ role: member.role }).from(member).where(and(eq(member.workspaceId, workspaceId), eq(member.userId, actorId)));
    if (!mayManage(m?.role)) throw new TxError("forbidden", `another person's rule answers “${row.topic}” here; they, or an owner or admin, change it`);
  }
  if (held) {
    await tx.update(decisionRule).set({ answer, userId: actorId, decisionId: row.id, createdAt: new Date().toISOString() }).where(eq(decisionRule.id, held.id));
    return { answer: held.answer, userId: held.userId, decisionId: held.decisionId, createdAt: held.createdAt };
  }
  await tx.insert(decisionRule).values({ workspaceId, projectId, kind: row.kind, topic: row.topic!, answer, userId: actorId, decisionId: row.id });
  return null;
}

/**
 * Takes an answer back: the person who gave it, within the window; its reply goes, and the rule saved with it (the one it
 * replaced comes back). A hand-over that wrote the issue's Done when is not taken back: the description is the issue's now.
 */
async function reopen(tx: Tx, workspaceId: string, actorId: string, row: typeof decision.$inferSelect, comments: Comments): Promise<Pending[]> {
  if (row.status !== "answered") return [];
  if (row.answeredById !== actorId || row.ruleId) throw new TxError("forbidden", "only the person who answered takes the answer back");
  if (Date.now() - Date.parse(row.answeredAt!) > DECISION_UNDO_MS) throw new TxError("conflict", `an answer is taken back within ${DECISION_UNDO_MS / 1000} s; answer again with a comment`);
  if (row.kind === "handoff" && row.answerOption === HANDOFF_OPTION) throw new TxError("conflict", "a hand-over is not taken back: its Done when is in the description; change the issue instead");
  const removed = row.answerCommentId ? await comments.remove(tx, workspaceId, row.answerCommentId) : null;
  // A close taken back puts the issue back in the state it was in.
  const back = row.kind === "close" && row.answerOption === CLOSE_OPTION && row.undoStateId ? await comments.update(tx, workspaceId, actorId, row.issueId, { stateId: row.undoStateId }) : null;
  const mine = and(eq(decisionRule.decisionId, row.id), eq(decisionRule.userId, actorId));
  if (row.replacedRule) await tx.update(decisionRule).set(row.replacedRule).where(mine);
  else await tx.delete(decisionRule).where(mine);
  const changed = { status: "open" as const, answer: null, answerOption: null, answeredById: null, answeredAt: null, answerCommentId: null };
  await tx.update(decision).set({ ...changed, replacedRule: null, undoStateId: null }).where(eq(decision.id, row.id));
  return [...(removed ? [removed] : []), ...(back ? [back] : []), { m: "Decision", mid: row.id, a: "U", d: { issueId: row.issueId, ...changed }, p: { status: row.status } }];
}
