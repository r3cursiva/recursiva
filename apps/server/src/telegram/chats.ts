// A linked chat's delivery state (PLNR-202): a refusal for good (the bot blocked, the chat gone) stops delivery until the
// person connects again, a test goes through or they unblock the bot (PLNR-204). What the notifier meanwhile sends by
// email instead counts from `errorAt`. Shared by the notifier, the settings page, sign-in codes and the webhook.
import { eq, gte, isNull, and, sql as dsql, type SQL } from "drizzle-orm";
import { db, schema, type Tx } from "../db.ts";

const { telegramChat, telegramCode, telegramGroup, telegramGroupCode } = schema;

/** `which`: the person's chat (by user id) or, from the webhook, every chat with that Telegram id. */
const where = (which: string | SQL) => (typeof which === "string" ? eq(telegramChat.userId, which) : which);

/** The first refusal sets the time: the banner says since when, and the email count starts there. */
export const chatFailed = (which: string | SQL, reason: string) =>
  db.update(telegramChat).set({ error: reason.slice(0, 300), errorAt: dsql`now()` }).where(and(where(which), isNull(telegramChat.error)));
export const chatWorks = (which: string | SQL) => db.update(telegramChat).set({ error: null, errorAt: null }).where(where(which));

/**
 * Whose chat it is: one account, none, or "shared". A chat can be linked to two accounts (two accounts of one person, or
 * a Start link someone else sent): notifications and replies tell them apart by the message, a command cannot.
 */
export async function userOf(chatId: number): Promise<string | null | "shared"> {
  const rows = await db.select({ userId: telegramChat.userId }).from(telegramChat).where(eq(telegramChat.chatId, chatId)).limit(2);
  return rows.length > 1 ? "shared" : (rows[0]?.userId ?? null);
}

/**
 * A linked chat that only gets notifications (RSVA-496): it neither presses, commands nor comments for anyone. A chat linked
 * to two accounts counts as one when either of them turned actions off. False for a chat nobody linked.
 */
export async function notificationsOnly(chatId: number): Promise<boolean> {
  const [row] = await db.select({ userId: telegramChat.userId }).from(telegramChat).where(and(eq(telegramChat.chatId, chatId), eq(telegramChat.actions, false))).limit(1);
  return !!row;
}

/** What the bot answers a command, a press or a message that would act, in a chat with notifications only. */
export const ACTIONS_OFF = "This chat gets notifications only: buttons, commands and replies are off. To use them, turn on Actions in Settings › Notifications › Telegram in recursiva.";

/**
 * Unlinks the person's chat and voids a link not used yet: Disconnect. With `since`, taking back an email change
 * (auth/email-change.ts): the groups they linked since then go too, so whoever changed the address gets neither sign-in
 * codes nor events in Telegram. With `onlyChat`, only if the account's chat is that one (a Not me button, PLNR-256: its
 * data can be forged, so the chat that pressed it must be the one linked); otherwise nothing goes, not even the code.
 * Returns how many chats and groups went.
 */
export async function unlinkChat(tx: Tx, userId: string, since?: string, onlyChat?: number): Promise<number> {
  const chats = await tx.delete(telegramChat).where(and(eq(telegramChat.userId, userId), onlyChat === undefined ? undefined : eq(telegramChat.chatId, onlyChat))).returning({ id: telegramChat.userId });
  if (onlyChat !== undefined && !chats.length) return 0;
  await tx.delete(telegramCode).where(eq(telegramCode.userId, userId));
  if (!since) return chats.length;
  await tx.delete(telegramGroupCode).where(eq(telegramGroupCode.userId, userId));
  const groups = await tx.delete(telegramGroup).where(and(eq(telegramGroup.linkedBy, userId), gte(telegramGroup.linkedAt, since))).returning({ id: telegramGroup.id });
  return chats.length + groups.length;
}
