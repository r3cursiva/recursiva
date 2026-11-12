// A reply in Telegram becomes a comment (PLNR-203). The person replies to a notification in their chat with the bot; the
// message they replied to is a sent row of notify_outbox (its messageId), which names the person, the issue and the
// comment it was about. Posting is notify/reply.ts, shared with replies by email.
//
// Who replies is proven by Telegram: the webhook is authenticated (routes.ts), and a chat is the person's only after
// they pressed Start on their own link. The answer to the reply rides on the webhook's response, as /start's does.
import { ISSUE_KEY, UUID_PATTERN } from "@rsva/schema/models";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { html } from "../mail/template.ts";
import { postReply } from "../notify/reply.ts";
import { findIssue } from "./card.ts";
import type { Forward, Media } from "./new-issue.ts";

const { telegramChat, notifyOutbox } = schema;

export interface IncomingMessage {
  message_id?: number;
  text?: string;
  chat: { id: number; type: string };
  reply_to_message?: RepliedTo;
}

/** The message a reply answers, as Telegram sends it along: its id, its plain text, and who sent it. */
export interface RepliedTo extends Media, Forward {
  message_id: number;
  text?: string;
  caption?: string;
  from?: { is_bot?: boolean };
  /** The bot's buttons on it: a card's carry its issue's id (card.ts). */
  reply_markup?: { inline_keyboard?: { callback_data?: string }[][] };
}

/** The issue id at the end of a card button's callback data ("c:s:<id>", "sn:<id>"). */
const BUTTON_ID = new RegExp(`:(${UUID_PATTERN})$`, "i");
/** The key a card begins with: "PLNR-12 · In Progress · High". */
const CARD_KEY = new RegExp(`^(${ISSUE_KEY}) · `);

/**
 * The issue a reply is about: a notification's (its notify_outbox row, sent to this chat for a person it is still linked
 * to), or a card's — the bot's own message, by the issue id its buttons carry or the key it begins with (card.ts). The
 * row, or an id or key in `key`; null for neither.
 */
export async function aboutIssue(chatId: number, to: RepliedTo | undefined): Promise<{ row: typeof notifyOutbox.$inferSelect } | { key: string } | null> {
  if (!to) return null;
  const chats = await db.select({ userId: telegramChat.userId }).from(telegramChat).where(eq(telegramChat.chatId, chatId));
  if (!chats.length) return null;
  // A message id is unique in its chat: the row sent to this chat with that id, and to a person this chat is still linked
  // to (one who moved to another chat or disconnected no longer comments from here).
  const [row] = await db
    .select()
    .from(notifyOutbox)
    .where(and(eq(notifyOutbox.channel, "telegram"), eq(notifyOutbox.chatId, chatId), eq(notifyOutbox.messageId, to.message_id), inArray(notifyOutbox.userId, chats.map((c) => c.userId))))
    .limit(1);
  if (row) return { row };
  if (!to.from?.is_bot) return null;
  // A card's buttons name its issue by id: a key alone may be a project key of two workspaces. A card that lost its
  // buttons (the end of /triage) is found by the key it begins with.
  const id = to.reply_markup?.inline_keyboard
    ?.flat()
    .map((b) => BUTTON_ID.exec(b.callback_data ?? "")?.[1])
    .find(Boolean);
  const key = id ?? CARD_KEY.exec(to.text ?? "")?.[1];
  return key ? { key } : null;
}

const HOW = "To comment on an issue, reply to its notification here: swipe it left, or press and hold it and choose Reply.";

/** What the bot answers a message in a linked chat that is not a command: the comment it posted, or why not. */
export async function commentFromReply(m: IncomingMessage): Promise<string | null> {
  const chats = await db.select({ userId: telegramChat.userId }).from(telegramChat).where(eq(telegramChat.chatId, m.chat.id));
  // Not linked: the bot does not talk to strangers beyond /start.
  if (!chats.length) return null;
  if (!m.reply_to_message) return HOW;
  const about = await aboutIssue(m.chat.id, m.reply_to_message);
  if (!about) return `That message is not about an issue. ${HOW}`;
  const body = m.text?.trim();
  if (!body) return "Only text replies become comments for now.";
  // A card's issue, for the chat's person: one account (a chat linked to two cannot tell whose reply it is).
  const row = "row" in about ? about.row : await cardRow(chats.map((c) => c.userId), about.key);
  if (!row) return chats.length > 1 ? "This chat is connected to more than one recursiva account: reply to a notification instead." : "You cannot see this issue any more.";
  const r = await postReply(row, body, "telegram");
  if ("posted" in r) return html`Posted to <code>${r.posted}</code> as your comment.`.value;
  if (r.refused === "access") return "You no longer have access to this issue.";
  if (r.refused === "trash") return html`${r.key} is in the trash: nothing was posted.`.value;
  return r.why;
}

/** What postReply needs for a card's issue, or null when the chat is shared or the person cannot see the issue. */
async function cardRow(people: string[], key: string) {
  if (people.length !== 1) return null;
  const f = await findIssue(people[0]!, key);
  return f ? { workspaceId: f.workspaceId, userId: people[0]!, issueId: f.issue.id, commentId: null } : null;
}
