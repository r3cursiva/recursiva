// The notifier's Telegram half (PLNR-202): sends the "telegram" rows of notify_outbox once they are due, as send.ts does
// email, with the same rules read again at sending time. A message in the person's quiet hours goes silently when they
// chose that (follow.ts let it through), unless the issue is urgent and urgent rings through.
//
// `/mute 2h` in the chat (PLNR-205, telegram/commands.ts) stops all but urgent issues until then: they are not sent later,
// the inbox has them.
//
// A chat that refuses for good (the bot blocked, the chat gone) is marked on telegram_chat: its rows become emails
// (PLNR-204, `fallback`), and follow.ts writes emails instead until the person connects again.
//
// A chat with notifications only (RSVA-496) gets Open alone under each message, as a group does.
//
// Group chats' rows ("group", PLNR-204) go to their group, checked again against what it takes now and against what its
// linker may read. A group that refuses (the bot removed) is marked and gets nothing more; one that became a supergroup
// is followed to its new id.
//
// Too many messages at once (429, RSVA-212): Telegram allows about one a second to a chat and twenty a minute to a group.
// The refusing chat's rows wait the `retry_after` it named, without spending a try, and the rest of its rows in the run are
// not sent to it. The Bot API's 30 a second across all chats is not counted here: rows go one at a time, 50 per run.
import { afterQuiet } from "@rsva/protocol";
import { inArray } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { TelegramError, type TelegramApi } from "../telegram/api.ts";
import { chatFailed } from "../telegram/chats.ts";
import { groupFailed, sendToGroup } from "../telegram/groups.ts";
import { muteRunning } from "../telegram/mute.ts";
import { noticeButtons } from "../telegram/snooze.ts";
import { groupMessage, telegramMessage, type GroupKind } from "../telegram/message.ts";
import { prefsOf } from "./prefs.ts";
import { failed, finish, issueFacts, putBack, stillDue, STALE_MS, take, type Outbox } from "./send.ts";

const { telegramChat, telegramGroup, notifyOutbox } = schema;

/** The row again as an email, due now: send.ts mails it while the Telegram cell is Instantly. */
async function byEmail(r: Outbox, now: Date): Promise<void> {
  const { userId, workspaceId, actionId, issueId, kind, event, byId, commentId, stateId } = r;
  await db
    .insert(notifyOutbox)
    .values({ userId, workspaceId, actionId, issueId, kind, event, byId, commentId, stateId, channel: "email", fallback: true, dueAt: now.toISOString() })
    .onConflictDoNothing();
}

/** The chats that answered 429 in this run, and until when they wait. */
function rateLimits(now: Date) {
  const until = new Map<string, Date>();
  return {
    /** Put back unsent when this chat is waiting out a 429 from earlier in the run. */
    async held(chat: string, r: Outbox): Promise<boolean> {
      const t = until.get(chat);
      if (t) await putBack(r, t);
      return !!t;
    },
    /** Whether `e` is a 429 that named its wait: then the chat waits it out and the row is put back. */
    async limited(chat: string, r: Outbox, e: unknown): Promise<boolean> {
      if (!(e instanceof TelegramError) || e.retryAfter === undefined) return false;
      const t = new Date(now.getTime() + e.retryAfter * 1000);
      until.set(chat, t);
      await putBack(r, t, e);
      return true;
    },
  };
}

/**
 * Sends what is due; returns how many rows it handled, sent or not. `workspaceId` is one workspace's rows only (a test's);
 * `null` is every workspace, which only the server's loop wants.
 */
export async function sendTelegramDue(api: TelegramApi, origin: string, now = new Date(), workspaceId: string | null): Promise<number> {
  const rows = await take(now, "telegram", workspaceId);
  if (!rows.length) return 0;
  const people = [...new Set(rows.map((r) => r.userId))];
  const [prefs, chats] = await Promise.all([prefsOf(people), db.select().from(telegramChat).where(inArray(telegramChat.userId, people))]);
  const chatOf = new Map(chats.map((c) => [c.userId, c]));
  // A chat that refused once is not tried again in this run.
  const refused = new Set<string>();
  const limits = rateLimits(now);
  for (const r of rows) {
    const chat = chatOf.get(r.userId);
    // Disconnected: nothing to send to, as the person chose.
    if (!chat) {
      await finish(r.id, "dropped");
      continue;
    }
    // Refusing since: by email instead.
    if (chat.error || refused.has(r.userId)) {
      await byEmail(r, now);
      await finish(r.id, "dropped");
      continue;
    }
    if (await limits.held(r.userId, r)) continue;
    try {
      const { prefs: p, timeZone } = prefs.get(r.userId)!;
      const facts = await stillDue(r, p, "telegram", origin, now);
      if (typeof facts === "string" || (muteRunning(chat.mutedUntil, now) && !facts.urgent)) {
        await finish(r.id, typeof facts === "string" ? facts : "dropped");
        continue;
      }
      const inQuiet = afterQuiet(now, p.quiet, timeZone).getTime() > now.getTime();
      const messageId = await api.send(chat.chatId, telegramMessage(facts, p.telegram.length), { silent: inQuiet && !(facts.urgent && p.urgent), buttons: noticeButtons(facts.link, chat.actions ? r.issueId : null) });
      await finish(r.id, "sent", { sent: { chatId: chat.chatId, messageId } });
    } catch (e) {
      if (e instanceof TelegramError && e.permanent) {
        refused.add(r.userId);
        await chatFailed(r.userId, e.reason);
        await finish(r.id, "failed", { error: e.message });
        await byEmail(r, now);
      } else if (!(await limits.limited(r.userId, r, e))) await failed([r], e);
    }
  }
  return rows.length;
}

/**
 * Sends the group chats' rows that are due; returns how many it handled. `workspaceId` is one workspace's rows only (a
 * test's); `null` is every workspace, which only the server's loop wants.
 */
export async function sendGroupsDue(api: TelegramApi, origin: string, now = new Date(), workspaceId: string | null): Promise<number> {
  const rows = await take(now, "group", workspaceId);
  if (!rows.length) return 0;
  const groups = await db.select().from(telegramGroup).where(inArray(telegramGroup.id, [...new Set(rows.map((r) => r.groupId!))]));
  const groupOf = new Map(groups.map((g) => [g.id, g]));
  const limits = rateLimits(now);
  for (const r of rows) {
    const g = groupOf.get(r.groupId!);
    if (await limits.held(r.groupId!, r)) continue;
    try {
      // Removed, refusing, or no longer given this event: not sent. The project is checked once the issue is read.
      const facts = g && !g.error && g.events.includes(r.event) && now.getTime() - Date.parse(r.createdAt) <= STALE_MS ? await issueFacts(r, origin) : null;
      if (!g || !facts || !g.projectIds.includes(facts.projectId)) {
        await finish(r.id, "dropped");
        continue;
      }
      const messageId = await sendToGroup(api, g, groupMessage(facts, r.kind as GroupKind), noticeButtons(facts.link, null));
      await finish(r.id, "sent", { sent: { chatId: g.chatId, messageId } });
    } catch (e) {
      if (g && e instanceof TelegramError && e.permanent) {
        g.error = e.reason;
        await groupFailed(g.chatId, e.reason);
        await finish(r.id, "failed", { error: e.message });
      } else if (!(await limits.limited(r.groupId!, r, e))) await failed([r], e);
    }
  }
  return rows.length;
}
