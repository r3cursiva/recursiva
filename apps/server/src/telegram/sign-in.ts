// Sign-in codes in Telegram too (PLNR-215): a member with a linked chat gets the six-digit code there as well as by
// email, from the live server's bot only (main.ts, as notifications). The mail stays: a chat may be refusing, muted, or
// on a phone left elsewhere. The past-the-cap link (auth/codes.ts) goes by email only.
//
// Only to a browser the account knows (RSVA-464, docs/research/telegram-security-2026-11-07.md): a code asked from any
// other browser goes by email alone, and the chat hears that one was asked, with Not me. Otherwise whoever holds the
// Telegram account (a re-issued SIM, a forgotten Telegram Web session, a phone in other hands) signs in without the
// mailbox. Considered: no codes in Telegram at all (as safe, loses the quick sign-in on one's own browser); a Telegram
// button that confirms a new browser (the stolen chat is a sign-in again); half the code in each channel (both channels
// at every sign-in). The device cookie (auth/devices.ts) is HttpOnly and 256 bits, so the chat alone does not have it.
//
// The message rings even in quiet hours (the person is waiting for it), cannot be forwarded (protect_content: "send me
// the code" is the usual trick), and is deleted once the code is dead: used, replaced by a new one, out of guesses, or
// expired. So the chat does not keep a pile of codes.
//
// Which message to delete is kept in this process's memory, not in login_code. Considered (2026-11-03): two columns on
// login_code would survive a restart, but need a migration and a sweep that knows Telegram, for one thing only: a code
// sent just before a deploy then stays in the chat, dead, after its ten minutes. In memory it is one map, and the timer
// deletes it on the minute rather than at the next hourly sweep.
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { NOT_YOU } from "../mail/emails.ts";
import { html } from "../mail/template.ts";
import { TelegramError, type SendOptions, type TelegramApi } from "./api.ts";
import { chatFailed } from "./chats.ts";

const { telegramChat } = schema;

/** The live code messages, by lower-cased email: one per address, as there is one live code. */
const live = new Map<string, { api: TelegramApi; chatId: number; messageId: number; timer: NodeJS.Timeout }>();

function signInMessage(code: string): string {
  // <code>: a tap copies it in Telegram's apps.
  return html`<b>Your recursiva sign-in code</b>\n<code>${code}</code>\nType it in the tab where you asked for it. It works once, for 10 minutes; then this message goes.\n\n${NOT_YOU}`.value;
}

/**
 * Sends to the member's chat, if they linked one that still takes messages; null with no such chat. A chat that refuses
 * for good is marked, as the notifier marks it, and the error goes on to the caller's log.
 */
async function toChat(api: TelegramApi, userId: string, text: string, opts: SendOptions): Promise<{ chatId: number; messageId: number } | null> {
  const [chat] = await db
    .select({ chatId: telegramChat.chatId })
    .from(telegramChat)
    .where(and(eq(telegramChat.userId, userId), isNull(telegramChat.error)));
  if (!chat) return null;
  try {
    return { chatId: chat.chatId, messageId: await api.send(chat.chatId, text, opts) };
  } catch (e) {
    if (e instanceof TelegramError && e.permanent) await chatFailed(userId, e.reason);
    throw e;
  }
}

/** Sends the code to the member's chat: only for a browser they have signed in from (auth/codes.ts checks). */
export async function codeToTelegram(api: TelegramApi, userId: string, email: string, code: string, expiresAt: Date): Promise<void> {
  const sent = await toChat(api, userId, signInMessage(code), { protect: true });
  if (!sent) return;
  dropTelegramCode(email);
  const timer = setTimeout(() => dropTelegramCode(email), Math.max(0, expiresAt.getTime() - Date.now()));
  timer.unref();
  live.set(email, { api, ...sent, timer });
}

/** Who asked for a code, as the request showed it: what the notice names. */
export interface Asker {
  /** The browser's cookie token (auth/devices.ts), if it sent one. */
  device: string | undefined;
  /** deviceName() of its User-Agent. */
  browser: string;
  ip: string;
}

/** The Not me button under the notice: `nc:<user id>`, well under Telegram's 64 bytes. */
const notMyCodeButton = (userId: string) => [[{ text: "Not me", data: `nc:${userId}` }]];

/**
 * A code asked from a browser this member has not signed in from: the chat hears of it, without the code, and can void
 * it. Rings in quiet hours, as the code does. Stays in the chat: it is a record, not a secret.
 */
export async function newBrowserToTelegram(api: TelegramApi, userId: string, asker: Asker): Promise<void> {
  const text = html`<b>Sign-in asked from a new browser</b>\n${asker.browser}, IP ${asker.ip}\n\nThe code went to your email only: this browser has not signed in to your recursiva account before. If it was you, take the code from there.\n\nIf it was not, press Not me and the code stops working. Without your email they can’t get in.`.value;
  await toChat(api, userId, text, { buttons: notMyCodeButton(userId) });
}

/** Deletes the address's code message, if one is out: its code is dead. Waits for nothing; a failure changes nothing. */
export function dropTelegramCode(email: string): void {
  const sent = live.get(email);
  if (!sent) return;
  live.delete(email);
  clearTimeout(sent.timer);
  // Already deleted by the person, or Telegram is down: the code it shows does not work either way.
  sent.api.deleteMessage(sent.chatId, sent.messageId).catch(() => {});
}
