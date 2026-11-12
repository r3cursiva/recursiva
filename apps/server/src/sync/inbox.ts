// The viewer's inbox over the socket (PLNR-26): read off the log with the classifier the client also runs on deltas
// (packages/protocol/src/inbox.ts), plus the viewer's marks (inbox_mark), which also hold their subscriptions (PLNR-28).
//
// Considered (2026-10-28): a notification row per recipient written by the write pipeline (Plane, Linear) costs a write
// per recipient on every change and a second record to keep in step with the log; here the log is the record, and the
// only per-person rows are the marks the person sets. Delivery over the socket instead of a request: a warm client
// classifies the catch-up deltas itself and asks only for marks changed since its last, so a warm start receives
// nothing new (net.warm.bytes stays 19 B).
import { mayManage } from "@rsva/policy";
import { INBOX_DAYS, INBOX_MAX, inboxEvent, isReviewer, type Action, type InboxEvent, type InboxFrame, type InboxMark } from "@rsva/protocol";
import { startedStage, type StartedStage } from "@rsva/schema/models";
import { and, asc, desc, eq, gt, inArray, or, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db.ts";

const { workspace, issue, workflowState, comment, syncAction, inboxMark, member, user } = schema;

/** What a whole inbox answer is counted as against the reader's budget (limits.ts `reads`): about what is read for it at most. */
export const INBOX_COST = 2 ** 20;

/** Marks one write takes at most. */
export const MARKS_MAX = 500;

/** Log actions read per answer at most (the viewer's own included): older ones are past the window in any workspace we have. */
const SCAN = 20_000;

export const markColumns = {
  issueId: inboxMark.issueId,
  readId: inboxMark.readId,
  archivedId: inboxMark.archivedId,
  snoozedId: inboxMark.snoozedId,
  snoozedUntil: inboxMark.snoozedUntil,
  subscribed: inboxMark.subscribed,
  subscribedId: inboxMark.subscribedId,
};

type MarkRow = Omit<InboxMark, "subscribed" | "subscribedId"> & { subscribed: boolean | null; subscribedId: number; updatedAt: string };

/**
 * A row as the wire has it: the subscription only when the viewer chose one, and `snoozedUntil` in ISO 8601. Postgres
 * gives the column back as `2026-11-06 15:31:24.325+00`; sent back by the client in its next mark, that form failed
 * `marksSchema`, and the refusal made the client drop the mark and re-read the inbox: the unread dot came back (RSVA-565).
 */
export function toMark({ subscribed, subscribedId, ...m }: Omit<MarkRow, "updatedAt"> & { updatedAt?: string }): InboxMark {
  delete m.updatedAt;
  const mark = m.snoozedUntil === null ? m : { ...m, snoozedUntil: new Date(m.snoozedUntil).toISOString() };
  return subscribed === null ? mark : { ...mark, subscribed, subscribedId };
}

/**
 * Only the fields the classifier reads, taken out in SQL: a comment's I action holds its whole text (up to 64 KB), and
 * 20,000 of them read whole were more than a gigabyte (PLNR-32). Of the text, its start only: the line an inbox event
 * carries is cut from it (RSVA-571, `commentLine`).
 */
/** Characters of a comment read off the log: several times the line cut from them, so marks and links taken off leave enough. */
const BODY_START = 600;

export const logFields = {
  id: syncAction.id,
  m: syncAction.model,
  mid: syncAction.modelId,
  a: syncAction.action,
  issueId: dsql<string | null>`${syncAction.data}->>'issueId'`,
  parentId: dsql<string | null>`${syncAction.data}->>'parentId'`,
  // A move to another project (PLNR-448) maps the state it had: no state change to tell anyone about (protocol inboxEvent).
  stateId: dsql<string | null>`case when ${syncAction.data} ? 'projectId' then null else ${syncAction.data}->>'stateId' end`,
  assigneeIds: dsql<string[] | null>`${syncAction.data}->'assigneeIds'`,
  mentionIds: dsql<string[] | null>`${syncAction.data}->'mentionIds'`,
  // The comment as it reads now, not as the action wrote it: an agent's comment is made empty and filled by an edit.
  body: dsql<string | null>`case when ${syncAction.model} = 'Comment' then (select left(${comment.body}, ${BODY_START}) from ${comment} where ${comment.id} = ${syncAction.modelId}) end`,
  before: dsql<string[] | null>`${syncAction.prev}->'assigneeIds'`,
  // The state the issue was in: Done out of a review is classified apart from Done out of the blue (RSVA-574).
  beforeState: dsql<string | null>`${syncAction.prev}->>'stateId'`,
  by: syncAction.actorId,
  at: syncAction.createdAt,
};
export interface LogRow {
  id: number;
  m: string;
  mid: string;
  a: string;
  issueId: string | null;
  parentId: string | null;
  stateId: string | null;
  assigneeIds: string[] | null;
  mentionIds: string[] | null;
  body: string | null;
  by: string | null;
}

/** A row read with logFields as the classifier takes it. */
export function toAction(r: LogRow): Action {
  const d: Record<string, unknown> = {};
  if (r.issueId !== null) d.issueId = r.issueId;
  if (r.parentId !== null) d.parentId = r.parentId;
  if (r.stateId !== null) d.stateId = r.stateId;
  if (r.assigneeIds !== null) d.assigneeIds = r.assigneeIds;
  if (r.mentionIds !== null) d.mentionIds = r.mentionIds;
  if (r.body !== null) d.body = r.body;
  return { id: r.id, m: r.m, mid: r.mid, a: r.a, d, ...(r.by ? { by: r.by } : {}) } as Action;
}

/**
 * What the classifier can turn into a notification: new comments, new issues, state or assignee changes, mentions in an
 * edited comment or a description. The inbox and the notifier (notify/follow.ts) read the log through it.
 */
export const notifiable = () =>
  or(
    and(eq(syncAction.model, "Comment"), eq(syncAction.action, "I")),
    and(inArray(syncAction.model, ["Comment", "Document"]), eq(syncAction.action, "U"), dsql`${syncAction.data} ? 'mentionIds'`),
    and(eq(syncAction.model, "Issue"), eq(syncAction.action, "I")),
    and(eq(syncAction.model, "Issue"), eq(syncAction.action, "U"), dsql`(${syncAction.data} ? 'stateId' or ${syncAction.data} ? 'assigneeIds')`),
  );

/** The whole inbox, cut at one log number in one REPEATABLE READ transaction (the same cut as the snapshot). */
export async function readInbox(workspaceId: string, me: string): Promise<InboxFrame> {
  return db.transaction(
    async (tx) => {
      const [w] = await tx.select({ s: workspace.lastSyncId }).from(workspace).where(eq(workspace.id, workspaceId));
      const [log, states, mine, marks] = await Promise.all([
        tx
          .select(logFields)
          .from(syncAction)
          .where(
            and(
              eq(syncAction.workspaceId, workspaceId),
              dsql`${syncAction.createdAt} > now() - make_interval(days => ${INBOX_DAYS})`,
              // The viewer's own and imports included: walking back over them rewinds the context below.
              notifiable(),
            ),
          )
          .orderBy(desc(syncAction.id))
          .limit(SCAN),
        tx
          .select({ id: workflowState.id, projectId: workflowState.projectId, group: workflowState.group })
          .from(workflowState)
          .innerJoin(schema.project, eq(schema.project.id, workflowState.projectId))
          .where(eq(schema.project.workspaceId, workspaceId))
          .orderBy(asc(workflowState.position)),
        tx
          .select({ issueId: comment.issueId, root: dsql<string>`coalesce(${comment.parentId}, ${comment.id})` })
          .from(comment)
          .where(and(eq(comment.workspaceId, workspaceId), eq(comment.authorId, me))),
        tx
          .select({ ...markColumns, updatedAt: inboxMark.updatedAt })
          .from(inboxMark)
          .where(and(eq(inboxMark.userId, me), eq(inboxMark.workspaceId, workspaceId))),
      ]);
      const issueIds = [...new Set(log.map((a) => (a.m === "Comment" ? a.issueId! : a.mid)))];
      const issues = issueIds.length
        ? await tx.select({ id: issue.id, createdById: issue.createdById, assigneeIds: issue.assigneeIds }).from(issue).where(inArray(issue.id, issueIds))
        : [];
      // Who reviews an issue (isReviewer): its creator, or for an agent's issue whoever manages the workspace.
      const authors = [...new Set(issues.flatMap((i) => (i.createdById ? [i.createdById] : [])))];
      const [[mine_], agents] = await Promise.all([
        tx.select({ role: member.role }).from(member).where(and(eq(member.workspaceId, workspaceId), eq(member.userId, me))),
        authors.length ? tx.select({ id: user.id }).from(user).where(and(inArray(user.id, authors), eq(user.kind, "agent"))) : [],
      ]);
      const manages = mayManage(mine_?.role);
      const agent = new Set(agents.map((a) => a.id));
      const groups = new Map(states.map((s) => [s.id, s.group]));

      // The log is classified as each action found the issue, as the client does with a delta: walking from the newest
      // action back, assignees are rewound through the stored before-values, and the viewer's own comments drop out of
      // "commented" and "wrote in the thread" once the walk passes them.
      const assignees = new Map(issues.map((i) => [i.id, i.assigneeIds]));
      const creators = new Map(issues.map((i) => [i.id, i.createdById]));
      const stages = stageMap(states);
      const byIssue = new Map(marks.map((m) => [m.issueId, toMark(m)]));
      const count = (list: string[]) => list.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
      const commentsOn = count(mine.map((c) => c.issueId));
      const commentsIn = count(mine.map((c) => c.root));
      const ctx = {
        me,
        issue: (id: string) => (creators.has(id) ? { createdById: creators.get(id)!, assigneeIds: assignees.get(id) ?? [] } : undefined),
        stage: (id: string) => stages.get(id),
        group: (id: string) => groups.get(id),
        reviews: (id: string) => isReviewer(me, manages, creators.get(id) ?? null, agent.has(creators.get(id) ?? "")),
        commented: (id: string) => (commentsOn.get(id) ?? 0) > 0,
        inThread: (id: string) => (commentsIn.get(id) ?? 0) > 0,
        mark: (id: string) => byIssue.get(id),
      };
      const events: InboxEvent[] = [];
      for (const r of log) {
        const a = toAction(r);
        const d = a.d!;
        const before = r.before ?? undefined;
        if (events.length < INBOX_MAX) {
          const e = inboxEvent(a, before, r.at, ctx, r.beforeState);
          if (e) events.push(e);
        }
        if (r.m === "Issue" && "assigneeIds" in d) assignees.set(r.mid, r.a === "U" ? (before ?? []) : []);
        if (r.m === "Comment" && r.a === "I" && r.by === me) {
          commentsOn.set(d.issueId as string, (commentsOn.get(d.issueId as string) ?? 1) - 1);
          const root = (d.parentId as string | null | undefined) ?? r.mid;
          commentsIn.set(root, (commentsIn.get(root) ?? 1) - 1);
        }
      }
      events.reverse();
      const at = marks.reduce<string | null>((max, m) => (max === null || m.updatedAt > max ? m.updatedAt : max), null);
      const c = [...new Set(mine.map((x) => x.issueId))];
      const th = [...new Set(mine.map((x) => x.root))];
      return { t: "inbox", s: w!.s, e: events, m: [...byIssue.values()], c, th, at };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** Marks the viewer changed after `at` (another tab or device), with the latest change's time; null when none. */
export async function marksSince(workspaceId: string, me: string, at: string): Promise<{ m: InboxMark[]; at: string } | null> {
  const rows = await db
    .select({ ...markColumns, updatedAt: inboxMark.updatedAt })
    .from(inboxMark)
    .where(and(eq(inboxMark.userId, me), eq(inboxMark.workspaceId, workspaceId), gt(inboxMark.updatedAt, at)))
    .orderBy(asc(inboxMark.updatedAt));
  if (!rows.length) return null;
  return { m: rows.map(toMark), at: rows.at(-1)!.updatedAt };
}

const logNumber = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const marksSchema = z
  .array(
    z
      .object({
        issueId: z.uuid(),
        readId: logNumber,
        archivedId: logNumber,
        snoozedId: logNumber,
        snoozedUntil: z.iso.datetime({ offset: true }).nullable(),
        subscribed: z.boolean().optional(),
        subscribedId: logNumber.optional(),
      })
      .strict()
      .refine((m) => (m.subscribed === undefined) === (m.subscribedId === undefined), "subscribed and subscribedId come together"),
  )
  .min(1)
  .max(MARKS_MAX);

/** Stores the viewer's marks; issues outside the workspace are refused. Returns them with the time they were stored. */
export async function writeMarks(workspaceId: string, me: string, raw: unknown): Promise<{ m: InboxMark[]; at: string }> {
  const parsed = marksSchema.safeParse(raw);
  if (!parsed.success) throw new MarkError(z.prettifyError(parsed.error));
  const marks = parsed.data;
  const ids = [...new Set(marks.map((m) => m.issueId))];
  // One upsert cannot change a row twice: a client never sends that, so it is refused rather than guessed at.
  if (ids.length !== marks.length) throw new MarkError("an issue is marked twice");
  const found = await db.select({ id: issue.id }).from(issue).where(and(eq(issue.workspaceId, workspaceId), inArray(issue.id, ids)));
  if (found.length !== ids.length) throw new MarkError("issue is not in the workspace");
  const rows = await db
    .insert(inboxMark)
    .values(marks.map((m) => ({ ...m, subscribed: m.subscribed ?? null, subscribedId: m.subscribedId ?? 0, userId: me, workspaceId })))
    .onConflictDoUpdate({
      target: [inboxMark.userId, inboxMark.issueId],
      set: {
        readId: dsql`excluded.read_id`,
        archivedId: dsql`excluded.archived_id`,
        snoozedId: dsql`excluded.snoozed_id`,
        snoozedUntil: dsql`excluded.snoozed_until`,
        // A mark without a subscription (a shell from before PLNR-28) keeps the one stored: no client ever clears it.
        subscribed: dsql`coalesce(excluded.subscribed, ${inboxMark.subscribed})`,
        subscribedId: dsql`case when excluded.subscribed is null then ${inboxMark.subscribedId} else excluded.subscribed_id end`,
        updatedAt: dsql`clock_timestamp()`,
      },
    })
    .returning({ ...markColumns, updatedAt: inboxMark.updatedAt });
  const at = rows.reduce((max, r) => (r.updatedAt > max ? r.updatedAt : max), rows[0]!.updatedAt);
  return { m: rows.map(toMark), at };
}

export class MarkError extends Error {}

/** Each state's started stage, from the workspace's states in position order. */
export function stageMap(states: { id: string; projectId: string; group: string }[]): Map<string, StartedStage> {
  const byProject = new Map<string, typeof states>();
  for (const s of states) {
    let list = byProject.get(s.projectId);
    if (!list) byProject.set(s.projectId, (list = []));
    list.push(s);
  }
  const out = new Map<string, StartedStage>();
  for (const list of byProject.values()) {
    for (const s of list) {
      const stage = startedStage(list, s.id);
      if (stage) out.set(s.id, stage);
    }
  }
  return out;
}
