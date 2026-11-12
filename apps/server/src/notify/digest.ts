// The morning digest and the weekly summary (PLNR-201). Each pass of the notifier works out, for every person who may
// get mail, whether their digest time has come in their time zone today and today is one of their days. Only for those
// whose last digest (notify_digest, their local date) is older than today does it open a transaction, read what waits on
// them, what is due today, what agents finished since their last digest and what they put in the digest (the outbox's
// "digest" rows), and mail it. The row is taken FOR UPDATE SKIP LOCKED, so a day has one at most, however many passes
// or processes.
//
// A person the digest meets for the first time gets their first one the next day: a deploy does not send everybody a
// digest at once. Without a time zone there is no morning to send it in; a person gets their browser's zone with their
// first visit (account.ts).
//
// "Due today" and "Cycle starts or ends" (PLNR-206) are listed here when their email cell is Digest; set to Instantly,
// the morning pass sends them (morning.ts), which shares the day's bookkeeping below.
import { WEEKLY, delivery, wallClock, workspaceAllows, type NotifyEvent, type NotifyPrefs } from "@rsva/protocol";
import { ASK_LABELS, asksViewer } from "@rsva/protocol/my-work";
import { settingsPath, cyclePath, isClosedGroup, issueKey, issuePath } from "@rsva/schema/models";
import { and, arrayContains, asc, eq, gte, inArray, isNull, lt, or, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { PUBLIC_ORIGIN, type Mail, type Mailer } from "../auth/mail.ts";
import { requireActor } from "../auth/routes.ts";
import { db, schema, type Tx } from "../db.ts";
import { digestMail, weeklyMail, type DigestItem } from "../mail/emails.ts";
import { linesOf } from "../api-inbox.ts";
import { loadIssues } from "../api-names.ts";
import { workIn } from "../my-work.ts";
import { prefsOf } from "./prefs.ts";
import { noticeItem, TITLE_CLIP } from "./words.ts";
import { noticeFor, seenInApp } from "./send.ts";
import { forPerson, unsubscribeLink } from "./unsubscribe.ts";
import { mayRead } from "@rsva/policy";
import { workspacesOf } from "../auth/access.ts";

const { member, user, workspace, project, issue, workflowState, notifyOutbox, notifyDigest, syncAction, cycle } = schema;

const DAY_MS = 86_400_000;
/** Digest rows older than this are dropped: a person whose digest never goes does not pile them up. */
const DIGEST_ROW_DAYS = 7;

type Log = { error: (e: unknown, msg: string) => void };
type Kind = "daily" | "weekly";
type Cache = Map<string, Promise<unknown>>;
interface Built {
  mail: Mail;
  empty: boolean;
  /** Digest rows in the mail: marked sent once it went. */
  rows: string[];
  /** Digest rows that will never go (read in the app, the rule changed, the workspace gone). */
  skipped: { id: string; status: "seen" | "dropped" }[];
}

/** Human members who may read at least one workspace: who can get a digest. */
export async function people(): Promise<string[]> {
  const rows = await db.selectDistinct({ id: user.id, role: member.role }).from(member).innerJoin(user, eq(user.id, member.userId)).where(eq(user.kind, "human"));
  return [...new Set(rows.filter((r) => mayRead(r.role)).map((r) => r.id))];
}

/** Sends the digests and summaries that are due now; returns how many went. */
export async function sendDigests(mailer: Mailer, origin: string, log: Log, now = new Date()): Promise<number> {
  await db
    .update(notifyOutbox)
    .set({ status: "dropped", doneAt: dsql`now()`, error: "stale" })
    .where(and(eq(notifyOutbox.channel, "digest"), eq(notifyOutbox.status, "pending"), lt(notifyOutbox.createdAt, new Date(now.getTime() - DIGEST_ROW_DAYS * DAY_MS).toISOString())));
  const ids = await people();
  const prefs = await prefsOf(ids);
  // Whose digest or summary time has come today, by their own clock: worked out in memory, no query per person.
  const due: { userId: string; kind: Kind; date: string; prefs: NotifyPrefs; timeZone: string }[] = [];
  for (const userId of ids) {
    const { prefs: p, timeZone } = prefs.get(userId)!;
    if (!timeZone) continue;
    const t = wallClock(now, timeZone);
    if (p.digest.on && p.digest.days.includes(t.weekday) && t.time >= p.digest.time) due.push({ userId, kind: "daily", date: t.date, prefs: p, timeZone });
    if (p.weekly && t.weekday === WEEKLY.day && t.time >= WEEKLY.time) due.push({ userId, kind: "weekly", date: t.date, prefs: p, timeZone });
  }
  const cache: Cache = new Map();
  let sent = 0;
  for (const { previous, ...d } of await notYet(due)) {
    // Since the last one, a day at least and a week at most: Monday's digest covers the weekend.
    const days = Math.min(7, Math.max(1, Math.round((Date.parse(d.date) - Date.parse(previous)) / DAY_MS)));
    try {
      const build = d.kind === "daily" ? () => daily(d.userId, d.prefs, origin, now, d.date, d.timeZone, days, cache) : () => weekly(d.userId, d.prefs, origin, now, d.timeZone, cache);
      sent += await once(d, build, mailer, origin, log);
    } catch (e) {
      // One person's failure does not stop the others'; theirs is tried on the next pass.
      log.error(e, `${d.kind} digest of ${d.userId} not built`);
    }
  }
  return sent;
}

/**
 * Of the people whose time of the `kind` has come today, those whose last one was before today, with its day. The first
 * time a kind meets a person, today counts as sent and nothing goes.
 */
export async function notYet<T extends { userId: string; kind: string; date: string }>(due: T[]): Promise<(T & { previous: string })[]> {
  if (!due.length) return [];
  const last = await db.select().from(notifyDigest).where(inArray(notifyDigest.userId, [...new Set(due.map((d) => d.userId))]));
  const sentOn = new Map(last.map((r) => [`${r.userId} ${r.kind}`, r.sentOn]));
  const out: (T & { previous: string })[] = [];
  for (const d of due) {
    const previous = sentOn.get(`${d.userId} ${d.kind}`);
    if (previous === undefined) await db.insert(notifyDigest).values({ userId: d.userId, kind: d.kind, sentOn: d.date }).onConflictDoNothing();
    else if (previous < d.date) out.push({ ...d, previous });
  }
  return out;
}

/**
 * Runs `send` for the person's `kind` of `date` once at most, however many passes or processes: their notify_digest row
 * is the lock, and it is marked in the same transaction. The day is marked whatever `send` does after that: a service
 * that is down does not get it again every half minute today. A `send` that throws rolls the mark back.
 */
export async function onceOn(d: { userId: string; kind: string; date: string }, send: (tx: Tx) => Promise<number>): Promise<number> {
  const mine = and(eq(notifyDigest.userId, d.userId), eq(notifyDigest.kind, d.kind));
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ sentOn: notifyDigest.sentOn }).from(notifyDigest).where(and(mine, lt(notifyDigest.sentOn, d.date))).for("update", { skipLocked: true });
    if (!row) return 0;
    await tx.update(notifyDigest).set({ sentOn: d.date }).where(mine);
    return send(tx);
  });
}

function once(d: { userId: string; kind: Kind; date: string; prefs: NotifyPrefs }, build: () => Promise<Built>, mailer: Mailer, origin: string, log: Log): Promise<number> {
  return onceOn(d, async (tx) => {
    // What it held goes with the next one.
    const b = await build();
    for (const status of ["seen", "dropped"] as const) {
      const ids = b.skipped.filter((s) => s.status === status).map((s) => s.id);
      if (ids.length) await tx.update(notifyOutbox).set({ status, doneAt: dsql`now()` }).where(inArray(notifyOutbox.id, ids));
    }
    if (b.empty && d.kind === "daily" && d.prefs.digest.skipEmpty) return 0;
    try {
      await mailer(forPerson(b.mail, d.prefs, (await unsubscribeLink(d.userId, origin)).headers));
    } catch (e) {
      log.error(e, `${d.kind} digest not sent`);
      return 0;
    }
    if (b.rows.length) await tx.update(notifyOutbox).set({ status: "sent", doneAt: dsql`now()` }).where(inArray(notifyOutbox.id, b.rows));
    return 1;
  });
}

/** The person's workspaces they may read and get mail from. */
export async function mailedWorkspaces(userId: string, prefs: NotifyPrefs) {
  return (await workspacesOf(userId, "read")).filter((w) => prefs.workspaces[w.id] !== "off");
}

/** The open issues of these workspaces with their keys and state groups, filtered by `where`. */
async function issuesWhere(workspaceIds: string[], where: ReturnType<typeof and>) {
  if (!workspaceIds.length) return [];
  return db
    .select({ id: issue.id, number: issue.number, title: issue.title, key: project.key, slug: workspace.slug, stateId: issue.stateId, group: workflowState.group })
    .from(issue)
    .innerJoin(project, eq(project.id, issue.projectId))
    .innerJoin(workspace, eq(workspace.id, issue.workspaceId))
    .innerJoin(workflowState, eq(workflowState.id, issue.stateId))
    .where(and(inArray(issue.workspaceId, workspaceIds), isNull(issue.deletedAt), isNull(issue.archivedAt), where))
    .orderBy(asc(project.key), asc(issue.number));
}

/**
 * Issues moved into a completed state in a workspace over the last `days`, and whether an agent did it: read once per
 * workspace and period in a pass, whoever's digest asks.
 */
function completedIn(workspaceId: string, now: Date, days: number, cache: Cache) {
  const key = `done ${workspaceId} ${days}`;
  if (!cache.has(key))
    cache.set(
      key,
      db
        .selectDistinct({ issueId: syncAction.modelId, projectId: workflowState.projectId, agent: dsql<boolean>`coalesce(${user.kind} = 'agent', false)` })
        .from(syncAction)
        .innerJoin(workflowState, eq(workflowState.id, dsql`(${syncAction.data}->>'stateId')::uuid`))
        .leftJoin(user, eq(user.id, syncAction.actorId))
        .where(and(eq(syncAction.workspaceId, workspaceId), eq(syncAction.model, "Issue"), eq(workflowState.group, "completed"), gte(syncAction.createdAt, new Date(now.getTime() - days * DAY_MS).toISOString()))),
    );
  return cache.get(key) as Promise<{ issueId: string; projectId: string; agent: boolean }[]>;
}

/** An issue as a digest's row. */
function issueItem(origin: string, i: { key: string; number: number; title: string; slug: string }, line?: string): DigestItem {
  const key = issueKey(i.key, i.number);
  return { key, title: i.title.slice(0, TITLE_CLIP), link: `${origin}${issuePath(i.slug, key)}`, ...(line ? { line } : {}) };
}

/** The workspaces of `ws` that let the event through to this person ("Only about me" keeps neither of the day's rows). */
export const allowing = (ws: { id: string }[], p: NotifyPrefs, event: NotifyEvent) => ws.filter((w) => workspaceAllows(p, w.id, event)).map((w) => w.id);

/** The person's open issues due on `date`, their own day. */
export async function dueOn(userId: string, workspaceIds: string[], date: string, origin: string): Promise<DigestItem[]> {
  const rows = await issuesWhere(workspaceIds, and(arrayContains(issue.assigneeIds, [userId]), eq(issue.dueDate, date)));
  return rows.filter((i) => !isClosedGroup(i.group)).map((i) => issueItem(origin, i));
}

const dayFmt = (d: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${d}T00:00:00Z`));

/**
 * The cycles that start or end on `date` and are not completed: those the person leads in these workspaces, or those of
 * a group chat's projects (PLNR-253). The artboard says "in projects you lead"; a project has no lead here, and a cycle
 * does, so its lead is told.
 */
export async function cyclesOn(of: { leadId: string; workspaceIds: string[] } | { projectIds: string[] }, date: string, origin: string): Promise<DigestItem[]> {
  const ids = "leadId" in of ? of.workspaceIds : of.projectIds;
  if (!ids.length) return [];
  const which = "leadId" in of ? and(inArray(cycle.workspaceId, ids), eq(cycle.leadId, of.leadId)) : inArray(cycle.projectId, ids);
  const rows = await db
    .select({ number: cycle.number, name: cycle.name, startDate: cycle.startDate, endDate: cycle.endDate, key: project.key, slug: workspace.slug })
    .from(cycle)
    .innerJoin(project, eq(project.id, cycle.projectId))
    .innerJoin(workspace, eq(workspace.id, cycle.workspaceId))
    .where(and(which, isNull(cycle.completedAt), isNull(project.archivedAt), or(eq(cycle.startDate, date), eq(cycle.endDate, date))))
    .orderBy(asc(project.key), asc(cycle.number));
  return rows.map((c) => ({
    key: `${c.key} C${c.number}`,
    title: c.name.slice(0, TITLE_CLIP),
    link: `${origin}${cyclePath(c.slug, c.key, c.number)}`,
    line: c.startDate === date ? (c.endDate === date ? "Starts and ends today" : `Starts today, ends ${dayFmt(c.endDate!)}`) : "Ends today",
  }));
}

/** Who a digest or summary goes to: their address, the workspaces it covers, and its footer's links. */
async function addressee(userId: string, p: NotifyPrefs, origin: string) {
  const [me] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  const ws = await mailedWorkspaces(userId, p);
  return {
    to: me!.email,
    ws,
    ids: ws.map((w) => w.id),
    settings: `${origin}${settingsPath(ws[0]?.slug ?? "", "notifications/email")}`,
    unsubscribe: (await unsubscribeLink(userId, origin)).link,
  };
}

async function daily(userId: string, p: NotifyPrefs, origin: string, now: Date, date: string, timeZone: string, days: number, cache: Cache): Promise<Built> {
  const { to, ws, ids, settings, unsubscribe } = await addressee(userId, p, origin);
  const item = (i: { key: string; number: number; title: string; slug: string }, line?: string) => issueItem(origin, i, line);
  const inDigest = (event: NotifyEvent) => (delivery(p, event, "email") === "digest" ? allowing(ws, p, event) : []);

  // Waiting on you, by the one rule the app has (RSVA-572, asksViewer): reviews, replies and mentions, the longest
  // waiting first. It was the person's issues in review only; a question put to them was not in the mail.
  const waiting = (
    await Promise.all(
      ws.map(async (w) => {
        const lines = await linesOf(w.id, userId);
        return workIn(userId, { ...w, ...lines }, await loadIssues(w.id), now.getTime())
          // A new assignment to decide on is mailed on its own (the assignment mail), not repeated here.
          .filter((x) => asksViewer(x) && x.ask !== "decide")
          .map((x) => ({ x, key: lines.n.projects.get(x.issue.projectId)?.key ?? "?", slug: w.slug }));
      }),
    )
  )
    .flat()
    .sort((a, b) => a.x.since.localeCompare(b.x.since))
    .map(({ x, key, slug }) => item({ key, number: x.issue.number, title: x.issue.title, slug }, ASK_LABELS[x.ask!]));

  // Due today, in the person's zone, among their open issues; and the cycles they lead that start or end today.
  const due = await dueOn(userId, inDigest("due"), date, origin);
  const cycles = await cyclesOn({ leadId: userId, workspaceIds: inDigest("cycle") }, date, origin);

  // What agents finished since the last digest on the person's issues (created or assigned).
  const byAgents = [...new Set((await Promise.all(ids.map((w) => completedIn(w, now, days, cache)))).flat().filter((d) => d.agent).map((d) => d.issueId))];
  const finished = byAgents.length
    ? (await issuesWhere(ids, and(inArray(issue.id, byAgents), dsql`(${issue.createdById} = ${userId} or ${userId} = any(${issue.assigneeIds}))`))).filter((i) => i.group === "completed").map((i) => item(i, "Done by an agent"))
    : [];

  // What the person put in the digest, checked again as an instant mail is: the rule, the workspace, already seen.
  const pending = await db.select().from(notifyOutbox).where(and(eq(notifyOutbox.userId, userId), eq(notifyOutbox.channel, "digest"), eq(notifyOutbox.status, "pending"))).orderBy(asc(notifyOutbox.actionId));
  const updates: DigestItem[] = [];
  const rows: string[] = [];
  const skipped: Built["skipped"] = [];
  for (const r of pending) {
    const event = r.event as NotifyEvent;
    if (delivery(p, event, "email") !== "digest" || !workspaceAllows(p, r.workspaceId, event) || !ids.includes(r.workspaceId)) {
      skipped.push({ id: r.id, status: "dropped" });
      continue;
    }
    if (p.seen && (await seenInApp(r))) {
      skipped.push({ id: r.id, status: "seen" });
      continue;
    }
    const n = await noticeFor(r, origin, unsubscribe);
    if (!n) {
      skipped.push({ id: r.id, status: "dropped" });
      continue;
    }
    rows.push(r.id);
    updates.push(noticeItem(n));
  }

  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "short", day: "numeric" }).format(now);
  const mail = digestMail({ to, origin, settings, unsubscribe, day, waiting, due, cycles, finished, updates }, now);
  return { mail, empty: !waiting.length && !due.length && !cycles.length && !finished.length && !updates.length, rows, skipped };
}

async function weekly(userId: string, p: NotifyPrefs, origin: string, now: Date, timeZone: string, cache: Cache): Promise<Built> {
  const { to, ids, settings, unsubscribe } = await addressee(userId, p, origin);
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const cycles = ids.length
    ? await db
        .select({ name: cycle.name, key: project.key, summary: cycle.summary })
        .from(cycle)
        .innerJoin(project, eq(project.id, cycle.projectId))
        .where(and(inArray(cycle.workspaceId, ids), gte(cycle.completedAt, since)))
        .orderBy(asc(project.key), asc(cycle.number))
    : [];
  const done = (await Promise.all(ids.map((w) => completedIn(w, now, 7, cache)))).flat();
  const projects = ids.length ? await db.select({ id: project.id, key: project.key, name: project.name }).from(project).where(inArray(project.workspaceId, ids)) : [];
  const perProject = projects
    .map((x) => ({ key: x.key, name: x.name, done: new Set(done.filter((d) => d.projectId === x.id).map((d) => d.issueId)).size }))
    .filter((x) => x.done > 0)
    .sort((a, b) => b.done - a.done);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" });
  const mail = weeklyMail(
    {
      to,
      origin,
      settings,
      unsubscribe,
      range: `${fmt.format(new Date(now.getTime() - 7 * DAY_MS))} – ${fmt.format(new Date(now.getTime() - DAY_MS))}`,
      cycles: cycles.map((c) => ({ name: c.name, project: c.key, done: c.summary?.groups.completed ?? 0, open: c.summary?.open.length ?? 0 })),
      projects: perProject,
      agents: new Set(done.filter((d) => d.agent).map((d) => d.issueId)).size,
    },
    now,
  );
  return { mail, empty: false, rows: [], skipped: [] };
}

/**
 * "See an example" on the Email page: the person's digest as it would be now, in the browser; nothing is marked. A mail
 * has inline styles and no scripts, so its page says so in a policy of its own, which the server's default leaves be.
 */
export function registerDigestExample(app: FastifyInstance): void {
  app.get("/auth/notifications/digest-example", { preHandler: requireActor({ sessionOnly: true }) }, async (req, reply) => {
    const me = req.actor!.userId;
    const { prefs, timeZone } = (await prefsOf([me])).get(me)!;
    const tz = timeZone ?? "UTC";
    // Links point where the live mail's do; a local run has no public origin, so they point at this server.
    const origin = PUBLIC_ORIGIN ?? `http://${req.headers.host}`;
    const now = new Date();
    const { mail } = await daily(me, prefs, origin, now, wallClock(now, tz).date, tz, 1, new Map());
    return reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
      .send(mail.html);
  });
}
