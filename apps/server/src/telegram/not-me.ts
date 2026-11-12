// "Not me" under the reply to /start (PLNR-256): a Start link sent by someone else links the presser's chat to the
// sender's account, and the sender chooses the name the reply shows, so the reply also names the account by its masked
// address, and this button unlinks the chat again. One tap undoes it; the normal case needs none.
import { UUID } from "@rsva/schema/models";
import { and, eq, lte } from "drizzle-orm";
import { db, schema } from "../db.ts";
import type { TelegramApi } from "./api.ts";
import { redraw } from "./answer.ts";
import { unlinkChat } from "./chats.ts";
import { maskEmail } from "./message.ts";
import { dropTelegramCode } from "./sign-in.ts";
import { html } from "../mail/template.ts";
import { wake } from "./wait.ts";

/** The button under the reply to /start: `nm:<user id>`, well under Telegram's 64 bytes. */
export const notMeButton = (userId: string) => [[{ text: "Not me", data: `nm:${userId}` }]];

/**
 * A pressed Not me, from a private chat: unlinks the account's chat if it is this one, and redraws the message without
 * the button. Another account's id or another chat's press unlinks nothing and says the chat is not connected.
 */
export async function pressNotMe(api: TelegramApi, callbackId: string, chatId: number, messageId: number, userId: string) {
  // The column is a uuid: a forged id that is not one would make Postgres throw, and Telegram resend the update.
  const gone = UUID.test(userId) ? await db.transaction((tx) => unlinkChat(tx, userId, undefined, chatId)) : 0;
  if (!gone) {
    await api.answerButton(callbackId, "This chat is not connected to that account.").catch(() => {});
    return {};
  }
  wake(userId);
  const [me] = await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, userId));
  await api.answerButton(callbackId, "Disconnected").catch(() => {});
  return redraw(chatId, messageId, html`Disconnected. This chat no longer gets anything from ${maskEmail(me?.email ?? "")}.`.value, []);
}

/**
 * A pressed Not me under "Sign-in asked from a new browser" (RSVA-464, telegram/sign-in.ts): voids the code it was about
 * if this chat is that account's and the code is still live. A code asked after the notice was drawn is someone's next
 * try, maybe the person's own, and stays. Another chat's press, or a second one, voids nothing.
 */
export async function pressNotMyCode(api: TelegramApi, callbackId: string, chatId: number, messageId: number, userId: string, drawnAt: Date) {
  const [me] = UUID.test(userId)
    ? await db
        .select({ email: schema.user.email })
        .from(schema.user)
        .innerJoin(schema.telegramChat, eq(schema.telegramChat.userId, schema.user.id))
        .where(and(eq(schema.user.id, userId), eq(schema.telegramChat.chatId, chatId)))
    : [];
  if (!me) {
    await api.answerButton(callbackId, "This chat is not connected to that account.").catch(() => {});
    return {};
  }
  const email = me.email.toLowerCase();
  // The message's date is in whole seconds; the code is written before it is sent.
  const voided = await db
    .delete(schema.loginCode)
    .where(and(eq(schema.loginCode.email, email), lte(schema.loginCode.createdAt, new Date(drawnAt.getTime() + 1000).toISOString())))
    .returning({ email: schema.loginCode.email });
  if (voided.length) dropTelegramCode(email);
  await api.answerButton(callbackId, voided.length ? "The code no longer works" : "That code is already gone").catch(() => {});
  const text = voided.length
    ? "Not me: that code no longer works. Without your email nobody can sign in with a code; if your email may be in other hands, secure it and sign out other devices in Settings › Security."
    : "That code already does not work: it was used, replaced or expired. If you did not sign in, look at Settings › Security and sign out what you don’t know.";
  return redraw(chatId, messageId, html`${text}`.value, []);
}
