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
import { DECISION_EVIDENCE_MAX, DECISION_KINDS, DECISION_OPTIONS_MAX, DECISION_OPTIONS_MIN, DECISION_TEXT_MAX, DECISION_UNDO_MS, type Decision, type DecisionAnswer, type DecisionCreate } from "@rsva/schema/models";
import type { CommentCreate } from "@rsva/protocol";
import { mayManage } from "@rsva/policy";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema, type Tx } from "../db.ts";
import { decisionColumns } from "./columns.ts";
import { created, lockOwned } from "./rows.ts";
import { TxError, type Pending } from "./tx-error.ts";

const { decision, decisionRule, issue, member, user } = schema;

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
  })
  .strict()
  .refine((s) => s.recommended < s.options.length, "recommended: the number of one of the options");
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

/** What a decision writes besides itself: comments, through the pipeline's own handlers (write.ts passes them in). */
export interface Comments {
  create(tx: Tx, workspaceId: string, actorId: string, id: string, set: CommentCreate): Promise<Pending>;
  remove(tx: Tx, workspaceId: string, actorId: string, id: string): Promise<Pending | null>;
}

const line = (s: string) => s.replace(/\s+/g, " ").trim();
const KIND_HEAD = { question: "Question", close: "Close proposal", handoff: "Hand-off" } as const;

/** The comment that mirrors a question in the issue's thread: the question, the options, the recommendation, the evidence. */
function askComment(d: Pick<Decision, "kind" | "question" | "options" | "recommended" | "evidence">): string {
  const options = d.options.map((o, i) => `${i + 1}. ${line(o.label)}${o.detail ? ` — ${line(o.detail)}` : ""}${i === d.recommended ? " (recommended)" : ""}`);
  const why = d.options[d.recommended]?.why;
  return [
    `**${KIND_HEAD[d.kind]}:** ${line(d.question)}`,
    "",
    ...options,
    ...(why ? ["", `Why ${d.recommended + 1}: ${line(why)}`] : []),
    ...(d.evidence.length ? ["", "Evidence:", ...d.evidence.map((e) => `- ${line(e)}`)] : []),
    "",
    "Answer it in Decisions.",
  ].join("\n");
}

/** The reply that answers it. */
const answerComment = (words: string, rule?: { topic: string; by: string }): string =>
  `**Decision:** ${line(words)}${rule ? `\n\nAnswered by the rule for “${line(rule.topic)}” that ${line(rule.by)} saved.` : ""}`;

const projectOf = async (tx: Tx, workspaceId: string, issueId: string): Promise<string> => {
  const [i] = await tx.select({ projectId: issue.projectId }).from(issue).where(and(eq(issue.id, issueId), eq(issue.workspaceId, workspaceId)));
  if (!i) throw new TxError("bad_ref", "issue is not in the workspace");
  return i.projectId;
};

export async function createDecision(tx: Tx, workspaceId: string, actorId: string, id: string, set: DecisionCreate, comments: Comments): Promise<Pending[]> {
  const commentId = crypto.randomUUID();
  const asked = await comments.create(tx, workspaceId, actorId, commentId, { issueId: set.issueId, body: askComment(set) });
  const projectId = await projectOf(tx, workspaceId, set.issueId);
  const [rule] = set.topic
    ? await tx
        .select({ id: decisionRule.id, answer: decisionRule.answer, userId: decisionRule.userId, name: user.name })
        .from(decisionRule)
        .innerJoin(user, eq(user.id, decisionRule.userId))
        .where(and(eq(decisionRule.projectId, projectId), eq(decisionRule.topic, set.topic)))
    : [];
  const out: Pending[] = [asked];
  let answered: Partial<typeof decision.$inferInsert> = {};
  if (rule) {
    const replyId = crypto.randomUUID();
    out.push(await comments.create(tx, workspaceId, actorId, replyId, { issueId: set.issueId, parentId: commentId, body: answerComment(rule.answer, { topic: set.topic!, by: rule.name }) }));
    const option = set.options.findIndex((o) => o.label === rule.answer);
    answered = { status: "answered", answer: rule.answer, answerOption: option < 0 ? null : option, answeredById: rule.userId, answeredAt: new Date().toISOString(), answerCommentId: replyId, ruleId: rule.id };
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

export async function answerDecision(tx: Tx, workspaceId: string, actorId: string, agent: boolean, id: string, set: DecisionAnswer, comments: Comments): Promise<Pending[]> {
  if (agent) throw new TxError("forbidden", "only a person answers a decision; the agent that asked waits for the answer");
  const row = await lockOwned(tx, decision, workspaceId, id, "decision");
  if (set.status === "open") return reopen(tx, workspaceId, actorId, row, comments);
  if (row.status !== "open") throw new TxError("conflict", "the decision is answered already");
  const text = set.option === null ? (set.text ?? "") : row.options[set.option]?.label;
  if (text === undefined) throw new TxError("invalid", `option: one of 0…${row.options.length - 1}`);
  if (!text) throw new TxError("invalid", "an answer in one's own words needs the words");
  const replyId = crypto.randomUUID();
  const reply = await comments.create(tx, workspaceId, actorId, replyId, { issueId: row.issueId, ...(row.commentId ? { parentId: row.commentId } : {}), body: answerComment(text) });
  const changed = { status: "answered" as const, answer: text, answerOption: set.option, answeredById: actorId, answeredAt: new Date().toISOString(), answerCommentId: replyId };
  await tx.update(decision).set(changed).where(eq(decision.id, id));
  if (set.rule && row.topic) {
    const projectId = await projectOf(tx, workspaceId, row.issueId);
    // Another person's rule for the topic is theirs to change, or an owner's or admin's: not replaced by an answer.
    const [held] = await tx.select({ userId: decisionRule.userId }).from(decisionRule).where(and(eq(decisionRule.projectId, projectId), eq(decisionRule.topic, row.topic))).for("update");
    if (held && held.userId !== actorId) {
      const [m] = await tx.select({ role: member.role }).from(member).where(and(eq(member.workspaceId, workspaceId), eq(member.userId, actorId)));
      if (!mayManage(m?.role)) throw new TxError("forbidden", `another person's rule answers “${row.topic}” here; they, or an owner or admin, change it`);
    }
    await tx
      .insert(decisionRule)
      .values({ workspaceId, projectId, topic: row.topic, answer: text, userId: actorId, decisionId: id })
      .onConflictDoUpdate({ target: [decisionRule.projectId, decisionRule.topic], set: { answer: text, userId: actorId, decisionId: id, createdAt: new Date().toISOString() } });
  }
  return [reply, { m: "Decision", mid: id, a: "U", d: { issueId: row.issueId, ...changed }, p: { status: row.status } }];
}

/** Takes an answer back: the person who gave it, within the window; its reply and the rule saved with it go too. */
async function reopen(tx: Tx, workspaceId: string, actorId: string, row: typeof decision.$inferSelect, comments: Comments): Promise<Pending[]> {
  if (row.status !== "answered") return [];
  if (row.answeredById !== actorId || row.ruleId) throw new TxError("forbidden", "only the person who answered takes the answer back");
  if (Date.now() - Date.parse(row.answeredAt!) > DECISION_UNDO_MS) throw new TxError("conflict", `an answer is taken back within ${DECISION_UNDO_MS / 1000} s; answer again with a comment`);
  const removed = row.answerCommentId ? await comments.remove(tx, workspaceId, actorId, row.answerCommentId) : null;
  await tx.delete(decisionRule).where(and(eq(decisionRule.decisionId, row.id), eq(decisionRule.userId, actorId)));
  const changed = { status: "open" as const, answer: null, answerOption: null, answeredById: null, answeredAt: null, answerCommentId: null };
  await tx.update(decision).set(changed).where(eq(decision.id, row.id));
  return [...(removed ? [removed] : []), { m: "Decision", mid: row.id, a: "U", d: { issueId: row.issueId, ...changed }, p: { status: row.status } }];
}
