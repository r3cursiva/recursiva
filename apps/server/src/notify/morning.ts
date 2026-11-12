// The morning pass (PLNR-206): "Due today" and "Cycle starts or ends" are days, not log actions, so follow.ts never
// meets them. At the person's digest time, in their zone, on any day, this sends what those two rows set to Instantly:
// one email and one Telegram message with both lists. Set to Digest, the digest lists them instead (digest.ts).
//
// Once a day at most, kept as the digest keeps its day (notify_digest, kind "morning"), and the first day it meets a
// person counts as sent. Nothing goes when both lists are empty. A chat that refuses for good is marked as follow.ts
// would have it, and what was for Telegram goes by email in the same mail.
//
// Why a pass of its own and not rows in notify_outbox: an outbox row is one log action on one issue, and these have
// neither; and one mail a morning listing the day beats a mail per issue at 08:00.
//
// Group chats given "Cycle starts or ends" (PLNR-253) get the cycles of their projects that start or end that day, one
// message at GROUP_CYCLES_TIME (sendGroupCycles).
import { afterQuiet, delivery, GROUP_CYCLES_TIME, wallClock, type Channel, type NotifyEvent, type NotifyPrefs } from "@rsva/protocol";
import { settingsPath } from "@rsva/schema/models";
import { and, arrayContains, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { Mailer } from "../auth/mail.ts";
import { db, schema } from "../db.ts";
import { morningMail, type DigestItem } from "../mail/emails.ts";
import { TelegramError, type TelegramApi } from "../telegram/api.ts";
import { chatFailed } from "../telegram/chats.ts";
import { groupFailed, sendToGroup } from "../telegram/groups.ts";
import { morningMessage } from "../telegram/message.ts";
import { allowing, cyclesOn, dueOn, mailedWorkspaces, notYet, onceOn, people } from "./digest.ts";
import { prefsOf } from "./prefs.ts";
import { forPerson, unsubscribeLink } from "./unsubscribe.ts";
import { mayRead } from "@rsva/policy";

const { telegramChat, telegramGroup, member, accountSettings, user } = schema;
type Log = { error: (e: unknown, msg: string) => void };
type Chat = { chatId: number; error: string | null };

const EVENTS = ["due", "cycle"] as const satisfies readonly NotifyEvent[];
const instantly = (p: NotifyPrefs, event: NotifyEvent, channel: Channel) => delivery(p, event, channel) === "now";

/** Sends the mornings that are due now; returns how many people got something. */
export async function sendMornings(mailer: Mailer, origin: string, log: Log, tg: TelegramApi | null, now = new Date()): Promise<number> {
  const ids = await people();
  const prefs = await prefsOf(ids);
  const due: { userId: string; kind: "morning"; date: string; prefs: NotifyPrefs; timeZone: string }[] = [];
  for (const userId of ids) {
    const { prefs: p, timeZone } = prefs.get(userId)!;
    // Telegram's cells count only on a server with a bot; whether the person has a chat is read once it is their turn.
    if (!timeZone || !EVENTS.some((e) => instantly(p, e, "email") || (tg && instantly(p, e, "telegram")))) continue;
    const t = wallClock(now, timeZone);
    if (t.time >= p.digest.time) due.push({ userId, kind: "morning", date: t.date, prefs: p, timeZone });
  }
  const todo = await notYet(due);
  const chats = todo.length && tg ? await db.select({ userId: telegramChat.userId, chatId: telegramChat.chatId, error: telegramChat.error }).from(telegramChat).where(inArray(telegramChat.userId, todo.map((d) => d.userId))) : [];
  const chatOf = new Map(chats.map((c) => [c.userId, c]));
  let sent = 0;
  for (const d of todo) {
    try {
      sent += await onceOn(d, () => morning(d, origin, now, mailer, log, tg ? { api: tg, chat: chatOf.get(d.userId) } : null));
    } catch (e) {
      log.error(e, `morning of ${d.userId} not built`);
    }
  }
  return sent;
}

async function morning(
  d: { userId: string; date: string; prefs: NotifyPrefs; timeZone: string },
  origin: string,
  now: Date,
  mailer: Mailer,
  log: Log,
  tg: { api: TelegramApi; chat: Chat | undefined } | null,
): Promise<number> {
  const p = d.prefs;
  const ws = await mailedWorkspaces(d.userId, p);
  const want = (channel: Channel) => EVENTS.filter((e) => instantly(p, e, channel));
  const telegram = tg?.chat ? want("telegram") : [];
  let byEmail = want("email");
  // Each list read once, for whichever channels want it; a workspace on "Only about me" gives neither (allowing).
  const needed = new Set([...byEmail, ...telegram]);
  const due = needed.has("due") ? await dueOn(d.userId, allowing(ws, p, "due"), d.date, origin) : [];
  const cycles = needed.has("cycle") ? await cyclesOn({ leadId: d.userId, workspaceIds: allowing(ws, p, "cycle") }, d.date, origin) : [];
  const of = (events: NotifyEvent[]) => ({ due: events.includes("due") ? due : [], cycles: events.includes("cycle") ? cycles : [] });
  const any = (l: { due: DigestItem[]; cycles: DigestItem[] }) => l.due.length + l.cycles.length > 0;
  const toEmail = () => (byEmail = [...new Set([...byEmail, ...telegram])]);

  let went = false;
  if (tg?.chat && any(of(telegram))) {
    if (tg.chat.error) toEmail();
    else
      try {
        // In quiet hours it goes silently: a morning notice held until they end would no longer be the morning's.
        const quiet = afterQuiet(now, p.quiet, d.timeZone).getTime() > now.getTime();
        await tg.api.send(tg.chat.chatId, morningMessage(of(telegram)), { silent: quiet });
        went = true;
      } catch (e) {
        // A chat that will not take messages is marked, and its part goes by email; anything else waits for tomorrow.
        if (e instanceof TelegramError && e.permanent) {
          await chatFailed(d.userId, e.reason);
          toEmail();
        } else log.error(e, `morning message to ${d.userId} not sent`);
      }
  }
  const mail = of(byEmail);
  if (any(mail)) {
    const [me] = await db.select({ email: user.email }).from(user).where(eq(user.id, d.userId));
    const unsubscribe = await unsubscribeLink(d.userId, origin);
    const day = new Intl.DateTimeFormat("en-US", { timeZone: d.timeZone, weekday: "long", month: "short", day: "numeric" }).format(now);
    const settings = `${origin}${settingsPath(ws[0]?.slug ?? "", "notifications/email")}`;
    try {
      await mailer(forPerson(morningMail({ to: me!.email, origin, settings, unsubscribe: unsubscribe.link, day, ...mail }, now), p, unsubscribe.headers));
      went = true;
    } catch (e) {
      log.error(e, `morning mail to ${d.userId} not sent`);
    }
  }
  return went ? 1 : 0;
}

/**
 * The cycles of the day for the group chats given "Cycle starts or ends" (PLNR-253): those of the group's projects that
 * start or end on that day, one message at GROUP_CYCLES_TIME. A group has no zone, digest time or quiet hours of its
 * own, so the day and the hour are its linker's, as what it gets is what they may read. The day is taken on the group's
 * row before the cycles are read: a day with none costs one look, and two passes do not both send. A send that fails
 * waits for tomorrow, as a person's morning does. Returns how many groups got a message; `workspaceId` keeps a test to
 * its own workspace; `null` is every workspace, which only the server's loop wants.
 */
export async function sendGroupCycles(api: TelegramApi, origin: string, log: Log, now = new Date(), workspaceId: string | null): Promise<number> {
  const groups = await db
    .select({ id: telegramGroup.id, chatId: telegramGroup.chatId, projectIds: telegramGroup.projectIds, sentOn: telegramGroup.cyclesSentOn, role: member.role, timeZone: accountSettings.timeZone })
    .from(telegramGroup)
    .leftJoin(member, and(eq(member.workspaceId, telegramGroup.workspaceId), eq(member.userId, telegramGroup.linkedBy)))
    .leftJoin(accountSettings, eq(accountSettings.userId, telegramGroup.linkedBy))
    .where(and(isNull(telegramGroup.error), arrayContains(telegramGroup.events, ["cycle"]), workspaceId ? eq(telegramGroup.workspaceId, workspaceId) : undefined));
  let sent = 0;
  for (const g of groups) {
    // Without a zone the linker has no morning yet; one who lost access to the workspace gives the group nothing.
    if (!g.timeZone || !mayRead(g.role)) continue;
    const { date, time } = wallClock(now, g.timeZone);
    if (time < GROUP_CYCLES_TIME || (g.sentOn && g.sentOn >= date)) continue;
    const [taken] = await db
      .update(telegramGroup)
      .set({ cyclesSentOn: date })
      .where(and(eq(telegramGroup.id, g.id), or(isNull(telegramGroup.cyclesSentOn), lt(telegramGroup.cyclesSentOn, date))))
      .returning({ id: telegramGroup.id });
    if (!taken) continue;
    try {
      const cycles = await cyclesOn({ projectIds: g.projectIds }, date, origin);
      if (!cycles.length) continue;
      await sendToGroup(api, g, morningMessage({ due: [], cycles }));
      sent++;
    } catch (e) {
      if (e instanceof TelegramError && e.permanent) await groupFailed(g.chatId, e.reason);
      else log.error(e, `cycles of the day for group ${g.id} not sent`);
    }
  }
  return sent;
}
