// The notifier's first half (PLNR-200): it reads each workspace's log forward from its cursor, asks the inbox's
// classifier (inboxEvent, the same the inbox and the client run) whom each action concerns, applies their rules and
// writes what is to be sent into notify_outbox with the time it may go: an email, a digest row, a Telegram message. The second half sends it (send.ts); what the
// person put in the digest waits there for the digest (digest.ts).
//
// Who might be concerned is narrowed first: the issue's creator, its assignees before and after, everyone who commented
// on it, whoever subscribed to it, and the people a comment or description mentions. The classifier then decides for
// each, with the issue as it is when the notifier reads the action: moments after the write, as a client classifies a
// delta against its pool. Only human members get mail: agents and the GitHub bot read the inbox.
//
// A workspace the notifier meets for the first time starts at the end of its log: nobody gets mail about the past.
//
// Group chats (PLNR-204) are told about a project rather than a person: an issue that became urgent, an agent's plan
// moved into review. One row per group, under the person who linked it.
//
// A person whose chat stopped taking messages (the bot blocked) gets by email what was set to Telegram only: the rows
// are marked `fallback`, and the settings page counts them in its banner.
import { BUNDLE_MS, afterQuiet, delivery, inboxEvent, isReviewer, notifyEvent, SEEN_WAIT_MS, workspaceAllows, type GroupEvent, type InboxContext, type InboxEvent, type NotifyEvent } from "@rsva/protocol";
import { URGENT } from "@rsva/schema/models";
import { and, asc, eq, gt, inArray, isNull, or, sql as dsql } from "drizzle-orm";
import { db, schema, type Tx } from "../db.ts";
import { logFields, markColumns, notifiable, stageMap, toAction, toMark, type LogRow } from "../sync/inbox.ts";
import { prefsOf } from "./prefs.ts";
import { MAX_AGE_MS } from "./send.ts";
import { mayManage, mayRead } from "@rsva/policy";

const { workspace, syncAction, notifyCursor, notifyOutbox, issue, comment, workflowState, project, member, user, inboxMark, telegramChat, telegramGroup } = schema;

/** Actions classified per transaction: a burst (an import, a bulk edit) is taken in steps. */
const BATCH = 500;
/** Outbox rows per insert. */
const INSERT_ROWS = 1000;

type Logged = LogRow & { before: string[] | null; beforeState: string | null; at: string; priority: number | null; wasPriority: number | null };
interface Found {
  e: InboxEvent;
  me: string;
  event: NotifyEvent;
  urgent: boolean;
}
/** A project event for group chats: what happened to which issue of which project. */
interface GroupFound {
  r: Logged;
  projectId: string;
  /** In the order a group that takes several gets the first: an urgent plan is news as urgent. */
  events: { event: GroupEvent; kind: "urgent_created" | "urgent_raised" | "plan" }[];
}

/** The log fields the notifier reads beyond the inbox's: a priority and what it was, for "New urgent issue". */
const followFields = {
  ...logFields,
  priority: dsql<number | null>`(${syncAction.data}->>'priority')::int`,
  wasPriority: dsql<number | null>`(${syncAction.prev}->>'priority')::int`,
};
/** What the inbox reads, and a priority change, which only group chats hear about. */
const followed = () => or(notifiable(), and(eq(syncAction.model, "Issue"), eq(syncAction.action, "U"), dsql`${syncAction.data} ? 'priority'`));

/** Workspaces whose log is past the notifier's cursor (or that it has never seen). */
export async function behind(): Promise<string[]> {
  const rows = await db
    .select({ id: workspace.id })
    .from(workspace)
    .leftJoin(notifyCursor, eq(notifyCursor.workspaceId, workspace.id))
    .where(dsql`${notifyCursor.lastId} is null or ${notifyCursor.lastId} < ${workspace.lastSyncId}`);
  return rows.map((r) => r.id);
}

/**
 * Classifies one batch of the workspace's new actions; true while more are left. `telegram`: a bot sends this process's
 * Telegram rows; without one none are written, or they would wait in the outbox for ever.
 */
export async function follow(workspaceId: string, now = new Date(), telegram = false): Promise<boolean> {
  return db.transaction(async (tx) => {
    // The cursor row is the lock: two runs over one workspace (a poke during a tick, two processes) take turns, and the
    // log's end is read only once the lock is held, so the second never moves the cursor back.
    const [start] = await tx.select({ s: workspace.lastSyncId }).from(workspace).where(eq(workspace.id, workspaceId));
    await tx.insert(notifyCursor).values({ workspaceId, lastId: start!.s }).onConflictDoNothing();
    const [c] = await tx.select({ lastId: notifyCursor.lastId }).from(notifyCursor).where(eq(notifyCursor.workspaceId, workspaceId)).for("update");
    const [w] = await tx.select({ s: workspace.lastSyncId }).from(workspace).where(eq(workspace.id, workspaceId));
    const log: Logged[] = await tx
      .select(followFields)
      .from(syncAction)
      .where(and(eq(syncAction.workspaceId, workspaceId), gt(syncAction.id, c!.lastId), dsql`${syncAction.id} <= ${w!.s}`, followed()))
      .orderBy(asc(syncAction.id))
      .limit(BATCH);
    const upTo = log.length === BATCH ? log.at(-1)!.id : w!.s;
    if (log.length) {
      const { found, groups } = await classify(tx, workspaceId, log);
      await schedule(tx, workspaceId, found, now, telegram);
      if (telegram) await scheduleGroups(tx, workspaceId, groups, now);
    }
    await tx.update(notifyCursor).set({ lastId: dsql`greatest(${notifyCursor.lastId}, ${upTo})` }).where(eq(notifyCursor.workspaceId, workspaceId));
    return upTo < w!.s;
  });
}

async function classify(tx: Tx, workspaceId: string, log: Logged[]): Promise<{ found: Found[]; groups: GroupFound[] }> {
  const issueOf = (r: Logged) => (r.m === "Comment" ? r.issueId! : r.mid);
  const issueIds = [...new Set(log.map(issueOf))];
  // The workspace's agents: who acted as one, and whose issues a manager reviews.
  const [issues, comments, marks, states, humans, agents] = await Promise.all([
    tx.select({ id: issue.id, projectId: issue.projectId, createdById: issue.createdById, assigneeIds: issue.assigneeIds, priority: issue.priority }).from(issue).where(inArray(issue.id, issueIds)),
    tx.select({ issueId: comment.issueId, authorId: comment.authorId, root: dsql<string>`coalesce(${comment.parentId}, ${comment.id})` }).from(comment).where(inArray(comment.issueId, issueIds)),
    tx.select({ ...markColumns, userId: inboxMark.userId }).from(inboxMark).where(and(eq(inboxMark.workspaceId, workspaceId), inArray(inboxMark.issueId, issueIds))),
    tx
      .select({ id: workflowState.id, projectId: workflowState.projectId, group: workflowState.group })
      .from(workflowState)
      .innerJoin(project, eq(project.id, workflowState.projectId))
      .where(eq(project.workspaceId, workspaceId))
      .orderBy(asc(workflowState.position)),
    tx.select({ id: user.id, role: member.role }).from(member).innerJoin(user, eq(user.id, member.userId)).where(and(eq(member.workspaceId, workspaceId), eq(user.kind, "human"))),
    tx.select({ id: user.id }).from(member).innerJoin(user, eq(user.id, member.userId)).where(and(eq(member.workspaceId, workspaceId), eq(user.kind, "agent"))),
  ]);
  const byId = new Map(issues.map((i) => [i.id, i]));
  const stages = stageMap(states);
  const groups = new Map(states.map((s) => [s.id, s.group]));
  const roles = new Map(humans.map((h) => [h.id, h.role]));
  const human = new Set(humans.filter((h) => mayRead(h.role)).map((h) => h.id));
  const agent = new Set(agents.map((a) => a.id));
  // Per issue, built once: who wrote on it and in which threads (counted, so the walk below can take comments back),
  // and the marks of the people who have one.
  const count = <K>(m: Map<K, number>, k: K, by: number) => m.set(k, (m.get(k) ?? 0) + by);
  const wrote = new Map<string, number>(); // issueId + author
  const inThread = new Map<string, number>(); // root + author
  const authors = new Map<string, Set<string>>();
  for (const c of comments) {
    if (!c.authorId) continue;
    count(wrote, `${c.issueId} ${c.authorId}`, 1);
    count(inThread, `${c.root} ${c.authorId}`, 1);
    let set = authors.get(c.issueId);
    if (!set) authors.set(c.issueId, (set = new Set()));
    set.add(c.authorId);
  }
  const markOf = new Map(marks.map((m) => [`${m.issueId} ${m.userId}`, m]));
  const subscribers = new Map<string, string[]>();
  for (const m of marks) if (m.subscribed) subscribers.set(m.issueId, [...(subscribers.get(m.issueId) ?? []), m.userId]);
  const assignees = new Map(issues.map((i) => [i.id, i.assigneeIds]));

  // Newest first, as the inbox reads the log (sync/inbox.ts): each action is classified against the issue as it was
  // then. Assignees are rewound through the stored before-values, and comments drop out once the walk passes them.
  const out: Found[] = [];
  for (const r of [...log].reverse()) {
    const a = toAction(r);
    const i = byId.get(issueOf(r));
    const d = a.d!;
    if (a.by && i) {
      const now = { ...i, assigneeIds: assignees.get(i.id) ?? [] };
      const candidates = new Set([i.createdById, ...now.assigneeIds, ...(r.assigneeIds ?? []), ...(r.before ?? []), ...(r.mentionIds ?? []), ...(authors.get(i.id) ?? [])]);
      for (const id of subscribers.get(i.id) ?? []) candidates.add(id);
      for (const me of candidates) {
        if (!me || me === a.by || !human.has(me)) continue;
        const mark = markOf.get(`${i.id} ${me}`);
        const ctx: InboxContext = {
          me,
          issue: (id) => (id === i.id ? now : undefined),
          stage: (id) => stages.get(id),
          group: (id) => groups.get(id),
          reviews: () => isReviewer(me, mayManage(roles.get(me)), i.createdById, agent.has(i.createdById ?? "")),
          commented: () => (wrote.get(`${i.id} ${me}`) ?? 0) > 0,
          inThread: (root) => (inThread.get(`${root} ${me}`) ?? 0) > 0,
          mark: () => (mark ? toMark(mark) : undefined),
        };
        const e = inboxEvent(a, r.before ?? undefined, r.at, ctx, r.beforeState);
        if (e) out.push({ e, me, event: notifyEvent(e.kind, agent.has(a.by)), urgent: i.priority === URGENT });
      }
    }
    if (r.m === "Issue" && "assigneeIds" in d) assignees.set(r.mid, r.a === "U" ? (r.before ?? []) : []);
    if (r.m === "Comment" && r.a === "I" && r.by) {
      count(wrote, `${d.issueId as string} ${r.by}`, -1);
      count(inThread, `${(d.parentId as string | null | undefined) ?? r.mid} ${r.by}`, -1);
    }
  }
  return { found: out.reverse(), groups: projectEvents(log, (id) => byId.get(id)?.projectId, stages, agent) };
}

/** What each action is for group chats: an issue created urgent or raised to it, an agent moving one into review. */
function projectEvents(log: Logged[], projectOf: (issueId: string) => string | undefined, stages: ReadonlyMap<string, string>, agent: ReadonlySet<string>): GroupFound[] {
  const out: GroupFound[] = [];
  for (const r of log) {
    const projectId = r.m === "Issue" && r.by ? projectOf(r.mid) : undefined;
    if (!projectId) continue;
    const events: GroupFound["events"] = [];
    if (r.priority === URGENT && r.a === "I") events.push({ event: "urgent", kind: "urgent_created" });
    if (r.priority === URGENT && r.a === "U" && r.wasPriority !== URGENT) events.push({ event: "urgent", kind: "urgent_raised" });
    if (r.a === "U" && r.stateId && stages.get(r.stateId) === "review" && agent.has(r.by!)) events.push({ event: "plan", kind: "plan" });
    if (events.length) out.push({ r, projectId, events });
  }
  return out;
}

/** A row per group chat that takes the event, under its linker; nothing for a group that stopped or has nothing picked. */
async function scheduleGroups(tx: Tx, workspaceId: string, found: GroupFound[], now: Date): Promise<void> {
  const fresh = found.filter((f) => now.getTime() - Date.parse(f.r.at) <= MAX_AGE_MS);
  if (!fresh.length) return;
  const groups = await tx
    .select({ id: telegramGroup.id, linkedBy: telegramGroup.linkedBy, projectIds: telegramGroup.projectIds, events: telegramGroup.events })
    .from(telegramGroup)
    .where(and(eq(telegramGroup.workspaceId, workspaceId), isNull(telegramGroup.error)));
  const rows = fresh.flatMap(({ r, projectId, events }) =>
    groups.flatMap((g) => {
      const e = g.projectIds.includes(projectId) ? events.find((x) => g.events.includes(x.event)) : undefined;
      if (!e) return [];
      return [{ userId: g.linkedBy, workspaceId, channel: "group", groupId: g.id, actionId: r.id, issueId: r.mid, kind: e.kind, event: e.event, byId: r.by, stateId: e.event === "plan" ? r.stateId : null, dueAt: now.toISOString() }];
    }),
  );
  await insertRows(tx, rows);
}

/** In parts: Postgres takes at most 65,535 parameters in a statement, and a row has twelve. */
async function insertRows(tx: Tx, rows: (typeof notifyOutbox.$inferInsert)[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_ROWS) await tx.insert(notifyOutbox).values(rows.slice(i, i + INSERT_ROWS)).onConflictDoNothing();
}

/** What the people's rules let through, with the time each may go: after "already seen" and quiet hours. */
async function schedule(tx: Tx, workspaceId: string, found: Found[], now: Date, withTelegram: boolean): Promise<void> {
  if (!found.length) return;
  const people = [...new Set(found.map((f) => f.me))];
  const [prefs, chats] = await Promise.all([
    prefsOf(people),
    withTelegram ? tx.select({ userId: telegramChat.userId, error: telegramChat.error }).from(telegramChat).where(inArray(telegramChat.userId, people)) : [],
  ]);
  // Telegram only to a chat that takes messages; while one refuses, what was set to Telegram goes by email instead,
  // until the person connects it again.
  const telegram = new Set(chats.filter((c) => !c.error).map((c) => c.userId));
  const refusing = new Set(chats.filter((c) => c.error).map((c) => c.userId));
  const rows = found.flatMap(({ e, me, event, urgent }) => {
    const { prefs: p, timeZone } = prefs.get(me)!;
    // News a day old is not news: a notifier that was stopped for a while does not mail its backlog.
    if (now.getTime() - Date.parse(e.at) > MAX_AGE_MS || !workspaceAllows(p, workspaceId, event)) return [];
    const row = (channel: "email" | "digest" | "telegram", due: Date, fallback = false) => ({
      userId: me,
      workspaceId,
      channel,
      actionId: e.id,
      issueId: e.issueId,
      kind: e.kind,
      event,
      byId: e.by,
      commentId: e.commentId ?? null,
      stateId: e.stateId ?? null,
      dueAt: due.toISOString(),
      fallback,
    });
    const out = [];
    const ready = new Date(now.getTime() + (p.seen ? SEEN_WAIT_MS : 0));
    const through = urgent && p.urgent;
    const how = delivery(p, event, "email");
    // A digest that will not go (off, no days, no time zone to have a morning in) takes nothing in.
    const noDigest = !p.digest.on || !p.digest.days.length || !timeZone;
    // A digest row waits for the person's next digest (digest.ts), whenever they set it; its due time is when it happened.
    if (how === "digest" && !noDigest) out.push(row("digest", now));
    if (how === "now") {
      // A bundle goes on the next half hour; an urgent issue does not wait for it.
      const bundled = p.email.bundle && !through ? new Date(Math.ceil(ready.getTime() / BUNDLE_MS) * BUNDLE_MS) : ready;
      out.push(row("email", through ? ready : afterQuiet(bundled, p.quiet, timeZone)));
    }
    // Telegram has no digest: Instantly or nothing. In quiet hours it goes silently (send.ts) or waits for their end.
    const toTelegram = delivery(p, event, "telegram") === "now";
    if (telegram.has(me) && toTelegram) out.push(row("telegram", through || p.telegram.silent ? ready : afterQuiet(ready, p.quiet, timeZone)));
    // Mailed as email's own instant would be: unless email already mails it at once.
    if (refusing.has(me) && toTelegram && how !== "now") out.push(row("email", through ? ready : afterQuiet(ready, p.quiet, timeZone), true));
    return out;
  });
  await insertRows(tx, rows);
}
