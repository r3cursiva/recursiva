// The notifier's second half (PLNR-200): sends what follow.ts put in notify_outbox once it is due. Rows are taken with
// SKIP LOCKED and leased (5 minutes, longer with each try) before the mail goes, so two processes never take the same row and a crash in the
// middle sends it again after the lease (once more at worst) rather than never.
//
// At sending time the rules are read again (the person may have turned the row off since) and so is the inbox mark:
// with "already seen" on, a notification the person read or archived in the app meanwhile is not mailed.
import { delivery, plainMentions, workspaceAllows, type NotifyEvent, type NotifyPrefs } from "@rsva/protocol";
import { issueKey, issuePath, settingsPath, URGENT } from "@rsva/schema/models";
import { and, asc, eq, gte, lt, lte, sql as dsql } from "drizzle-orm";
import type { Mailer } from "../auth/mail.ts";
import { db, schema } from "../db.ts";
import { bundleMail, issueMail, type IssueNotice } from "../mail/emails.ts";
import { replyAddress } from "../mail/inbound.ts";
import { forPerson, unsubscribeLink } from "./unsubscribe.ts";
import { prefsOf } from "./prefs.ts";
import { errorText } from "@rsva/schema/util";
import { mayRead } from "@rsva/policy";

const { notifyOutbox, inboxMark, issue, project, workspace, user, comment, workflowState, member } = schema;

/** Actions older than this are not sent (follow.ts), and outbox rows twice as old are dropped here. */
export const MAX_AGE_MS = 24 * 3_600_000;
/** Rows sent per run. */
const BATCH = 50;
/** How long a taken row waits before another run may take it again: 5 minutes, doubled with each try, at most 2 hours. */
const lease = (attempts: number) => Math.min(5 * 60_000 * 2 ** attempts, 2 * 3_600_000);
/** Tries before a row is given up as failed: about seven hours of a mail service being down. */
const TRIES = 8;
/** A row this old is not sent: a restored copy of the database or a long stop brings no stale mail. */
export const STALE_MS = 2 * MAX_AGE_MS;

export type Outbox = typeof notifyOutbox.$inferSelect;

/**
 * Claims the channel's rows due by `now`: their due time moves on by the lease, so no other run takes them meanwhile.
 * `workspaceId` narrows it to one workspace: the tests', whose files run side by side against one database and would
 * otherwise send each other's rows. It has no default, so a call cannot forget it; `null` is every workspace, which only
 * the server's loop (run.ts) wants.
 */
export async function take(now: Date, channel: "email" | "telegram" | "group", workspaceId: string | null): Promise<Outbox[]> {
  return db.transaction(async (tx) => {
    // A row whose process died while sending it every time ends here, not in a loop.
    await tx
      .update(notifyOutbox)
      .set({ status: "failed", doneAt: dsql`now()`, error: dsql`coalesce(${notifyOutbox.error}, 'gave up')` })
      .where(and(eq(notifyOutbox.status, "pending"), gte(notifyOutbox.attempts, TRIES)));
    const rows = await tx
      .select()
      .from(notifyOutbox)
      .where(
        and(
          eq(notifyOutbox.status, "pending"),
          eq(notifyOutbox.channel, channel),
          lte(notifyOutbox.dueAt, now.toISOString()),
          lt(notifyOutbox.attempts, TRIES),
          workspaceId ? eq(notifyOutbox.workspaceId, workspaceId) : undefined,
        ),
      )
      .orderBy(asc(notifyOutbox.dueAt))
      .limit(BATCH)
      .for("update", { skipLocked: true });
    for (const r of rows)
      await tx
        .update(notifyOutbox)
        .set({ dueAt: new Date(now.getTime() + lease(r.attempts)).toISOString(), attempts: r.attempts + 1 })
        .where(eq(notifyOutbox.id, r.id));
    return rows;
  });
}

/** Ends a row: with the refusal's text when it failed, with the Telegram message's chat and id when one went. */
export const finish = (id: string, status: "sent" | "seen" | "dropped" | "failed", more: { error?: string; sent?: { chatId: number; messageId: number } } = {}) =>
  db
    .update(notifyOutbox)
    .set({ status, doneAt: dsql`now()`, ...(more.error ? { error: more.error.slice(0, 500) } : {}), ...more.sent })
    .where(eq(notifyOutbox.id, id));

/**
 * Sends what is due; returns how many rows it handled, sent or not. With `replyDomain` (the server takes replies,
 * mail/inbound.ts) a single notification gets its own reply address, unless the person turned replying off.
 * `workspaceId` is one workspace's rows only (a test's); `null` is every workspace, which only the server's loop wants.
 */
export async function sendDue(mailer: Mailer, origin: string, now = new Date(), workspaceId: string | null, replyDomain: string | null = null): Promise<number> {
  const rows = await take(now, "email", workspaceId);
  if (!rows.length) return 0;
  const prefs = await prefsOf([...new Set(rows.map((r) => r.userId))]);
  // What is still to go, by person: a bundle is one mail for all of theirs.
  const ready = new Map<string, { row: Outbox; notice: IssueNotice }[]>();
  const links = new Map<string, Awaited<ReturnType<typeof unsubscribeLink>>>();
  for (const id of new Set(rows.map((r) => r.userId))) links.set(id, await unsubscribeLink(id, origin));
  for (const r of rows) {
    try {
      const outcome = await check(r, prefs.get(r.userId)!.prefs, origin, links.get(r.userId)!.link, now);
      if (typeof outcome === "string") await finish(r.id, outcome);
      else ready.set(r.userId, [...(ready.get(r.userId) ?? []), { row: r, notice: outcome }]);
    } catch (e) {
      await failed([r], e);
    }
  }
  for (const [userId, list] of ready) {
    const p = prefs.get(userId)!.prefs;
    const bundled = p.email.bundle && list.length > 1;
    const mails = bundled ? [{ rows: list.map((x) => x.row), notice: null }] : list.map((x) => ({ rows: [x.row], notice: x.notice }));
    for (const m of mails) {
      try {
        // A bundle is about several issues: a reply to it would have no one place to go.
        const replyTo = m.notice && replyDomain && p.email.reply ? await replyAddress(m.rows[0]!, m.notice.issueKey, replyDomain) : undefined;
        const mail = m.notice ? issueMail({ ...m.notice, ...(replyTo ? { replyTo } : {}) }, now) : bundleMail(list.map((x) => x.notice), now);
        await mailer(forPerson(mail, p, links.get(userId)!.headers));
        for (const r of m.rows) await finish(r.id, "sent");
      } catch (e) {
        await failed(m.rows, e);
      }
    }
  }
  return rows.length;
}

/** Left pending: the lease set their next try. The last try gives up. */
export async function failed(rows: Outbox[], e: unknown): Promise<void> {
  const message = errorText(e);
  for (const r of rows) {
    if (r.attempts + 1 >= TRIES) await finish(r.id, "failed", { error: message });
    else await db.update(notifyOutbox).set({ error: message.slice(0, 500) }).where(eq(notifyOutbox.id, r.id));
  }
}

/**
 * Back to pending until `until`, with the try take() counted handed back: the row was not refused, only held off (a
 * Telegram 429, RSVA-212). `e` is kept as its last error when there was one.
 */
export const putBack = (r: Outbox, until: Date, e?: unknown) =>
  db
    .update(notifyOutbox)
    .set({ dueAt: until.toISOString(), attempts: r.attempts, ...(e === undefined ? {} : { error: errorText(e).slice(0, 500) }) })
    .where(eq(notifyOutbox.id, r.id));

/** The notice to send, or why the row ends without one. */
async function check(r: Outbox, p: NotifyPrefs, origin: string, unsubscribe: string, now: Date): Promise<IssueNotice | "dropped" | "seen"> {
  // An email in place of a Telegram message goes while the Telegram cell is still Instantly.
  const facts = await stillDue(r, p, r.fallback ? "telegram" : "email", origin, now);
  return typeof facts === "string" ? facts : { ...facts, ...mailExtras(r, origin, unsubscribe), ...(r.fallback ? { instead: true } : {}) };
}

/**
 * Whether a row still goes, read again at sending time: not too old, the cell still Instantly, the workspace still
 * allowed, not seen in the app meanwhile, and the issue and comment still there. Its facts if it goes.
 */
export async function stillDue(r: Outbox, p: NotifyPrefs, channel: "email" | "telegram", origin: string, now: Date): Promise<IssueFacts | "dropped" | "seen"> {
  if (now.getTime() - Date.parse(r.createdAt) > STALE_MS) return "dropped";
  const event = r.event as NotifyEvent;
  if (delivery(p, event, channel) !== "now" || !workspaceAllows(p, r.workspaceId, event)) return "dropped";
  if (p.seen && (await seenInApp(r))) return "seen";
  return (await issueFacts(r, origin)) ?? "dropped";
}

export async function seenInApp(r: Outbox): Promise<boolean> {
  const [m] = await db
    .select({ readId: inboxMark.readId, archivedId: inboxMark.archivedId })
    .from(inboxMark)
    .where(and(eq(inboxMark.userId, r.userId), eq(inboxMark.workspaceId, r.workspaceId), eq(inboxMark.issueId, r.issueId)));
  return !!m && (m.readId >= r.actionId || m.archivedId >= r.actionId);
}

/** A comment's Markdown with mentions as their names: `[@Ann](mention:<id>)` reads "@Ann". */

/** What a notification says on any channel, whether its issue is urgent (it rings through quiet hours), and its project. */
export type IssueFacts = Omit<IssueNotice, "unsubscribe" | "messageId" | "threadId"> & { urgent: boolean; projectId: string };

/** What only a mail carries: the way out and the thread headers. */
function mailExtras(r: Outbox, origin: string, unsubscribe: string): Pick<IssueNotice, "unsubscribe" | "messageId" | "threadId"> {
  const host = new URL(origin).host;
  return { unsubscribe, messageId: `<rsva.${r.id}@${host}>`, threadId: `<rsva.issue.${r.issueId}@${host}>` };
}

/** Everything the mail says, read now: names and titles as they are when it goes. Null when it should not go. */
export async function noticeFor(r: Outbox, origin: string, unsubscribe: string): Promise<IssueNotice | null> {
  const facts = await issueFacts(r, origin);
  return facts && { ...facts, ...mailExtras(r, origin, unsubscribe) };
}

/** A notification's facts, read now. Null when it should not go: the person lost access, the issue or comment is gone. */
export async function issueFacts(r: Outbox, origin: string): Promise<IssueFacts | null> {
  const [row] = await db
    .select({
      email: user.email,
      number: issue.number,
      title: issue.title,
      priority: issue.priority,
      deletedAt: issue.deletedAt,
      projectId: issue.projectId,
      key: project.key,
      slug: workspace.slug,
      workspace: workspace.name,
      member: member.role,
    })
    .from(issue)
    .innerJoin(project, eq(project.id, issue.projectId))
    .innerJoin(workspace, eq(workspace.id, issue.workspaceId))
    .innerJoin(user, eq(user.id, r.userId))
    .leftJoin(member, and(eq(member.workspaceId, issue.workspaceId), eq(member.userId, r.userId)))
    .where(eq(issue.id, r.issueId));
  // Gone from the workspace or no longer allowed to read it, or the issue went to the trash: nothing to open.
  if (!row || !mayRead(row.member) || row.deletedAt) return null;
  const [[actor], [c], [state]] = await Promise.all([
    r.byId ? db.select({ name: user.name, kind: user.kind }).from(user).where(eq(user.id, r.byId)) : Promise.resolve([]),
    r.commentId ? db.select({ body: comment.body, deletedAt: comment.deletedAt }).from(comment).where(eq(comment.id, r.commentId)) : Promise.resolve([]),
    r.stateId ? db.select({ name: workflowState.name }).from(workflowState).where(eq(workflowState.id, r.stateId)) : Promise.resolve([]),
  ]);
  // A comment deleted before the mail went is not quoted, and the mail about it does not go.
  if (r.commentId && (!c || c.deletedAt)) return null;
  const key = issueKey(row.key, row.number);
  return {
    to: row.email,
    kind: r.kind as IssueNotice["kind"],
    byAgent: r.event === "plan",
    actor: actor?.name ?? "Someone",
    issueKey: key,
    issueTitle: row.title,
    ...(state ? { stateName: state.name } : {}),
    ...(c ? { comment: plainMentions(c.body) } : {}),
    workspace: row.workspace,
    link: `${origin}${issuePath(row.slug, key)}`,
    settings: `${origin}${settingsPath(row.slug, "notifications")}`,
    origin,
    urgent: row.priority === URGENT,
    projectId: row.projectId,
  };
}
