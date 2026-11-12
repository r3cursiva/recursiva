// The Telegram Bot API (PLNR-202): the few methods the notifier, the link flows (group chats: PLNR-204), sign-in codes (PLNR-215) and the
// commands with their buttons (PLNR-205) use. TELEGRAM_BOT_TOKEN turns it on;
// without it Telegram is "not set up on this server" and nothing here runs. `fetch` is a parameter, so tests answer as
// Telegram would and no test reaches the network.
import { createHmac } from "node:crypto";

/** The part of a refusal's `parameters` the server reads, as the Bot API names it (ResponseParameters). */
interface ResponseParameters {
  migrate_to_chat_id?: number;
  retry_after?: number;
}

/**
 * A refusal from Telegram. `permanent`: the chat will not take messages (bot blocked, removed from a group, chat gone);
 * anything else is tried again. `migrateTo`: the group became a supergroup, which has a new id; the message goes there.
 * `retryAfter`: too many messages (429), seconds to wait before this chat takes another (RSVA-212).
 */
export class TelegramError extends Error {
  readonly code: number;
  readonly permanent: boolean;
  readonly migrateTo: number | undefined;
  readonly retryAfter: number | undefined;
  /** What the settings page says about it: the words of the NotifTgError artboard, not Telegram's. */
  readonly reason: string;
  constructor(code: number, description: string, parameters: ResponseParameters = {}) {
    super(`Telegram answered ${code}: ${description}`);
    const migrateTo = parameters.migrate_to_chat_id;
    this.code = code;
    this.migrateTo = migrateTo;
    this.retryAfter = typeof parameters.retry_after === "number" && parameters.retry_after >= 0 ? parameters.retry_after : undefined;
    // 403: the person blocked the bot or deleted the account, or the bot was removed from the group; 400 "chat not
    // found": the chat is gone. None heals by retrying.
    this.permanent = !migrateTo && (code === 403 || (code === 400 && /chat not found|user is deactivated|not a member/i.test(description)));
    this.reason = /blocked/i.test(description) ? "Bot blocked" : /kicked|not a member/i.test(description) ? "Bot removed" : /deactivated/i.test(description) ? "Account deleted" : "Chat not found";
  }
}

/** A button under a message: pressing it sends `data` back (a callback_query), at most 64 bytes; or opens `url`. */
type Button = { text: string; data: string } | { text: string; url: string };

/** Rows of buttons, as Telegram's inline_keyboard. */
export type Buttons = Button[][];

/** Buttons as the Bot API takes them; none is an empty keyboard, which takes away the ones a message had. */
export const replyMarkup = (buttons: Buttons = []) => ({
  // Telegram refuses the whole message for a link it does not take (a server without PUBLIC_ORIGIN, a dev host): such a
  // button is left out instead.
  inline_keyboard: buttons
    .map((row) => row.flatMap((b): ({ text: string; url: string } | { text: string; callback_data: string })[] => ("url" in b ? (/^https:\/\/[^/]+\.[^/]+/.test(b.url) ? [{ text: b.text, url: b.url }] : []) : [{ text: b.text, callback_data: b.data }])))
    .filter((row) => row.length),
});

export interface SendOptions {
  /** No sound or vibration: quiet hours with "deliver silently" on. */
  silent?: boolean;
  /** No forwarding or saving: a sign-in code, so it cannot be passed on from the chat in two taps. */
  protect?: boolean;
  /** Buttons under the message. */
  buttons?: Buttons;
}

/** The most the Bot API lets a bot download (getFile). */
export const DOWNLOAD_MAX = 20 * 2 ** 20;

/** What the server asks Telegram. Tests pass their own. */
export interface TelegramApi {
  /** The bot's @username, without the @: the t.me link is built from it. */
  username(): Promise<string>;
  /** Sends a message; its id in the chat, which a reply to it carries. */
  send(chatId: number, html: string, opts?: SendOptions): Promise<number>;
  /** Answers a pressed button: Telegram shows `text`, if any, for a moment, and stops the button's spinner. */
  answerButton(callbackId: string, text?: string): Promise<void>;
  /** The bytes of a file someone sent the bot (a photo, a document), DOWNLOAD_MAX at most. */
  download(fileId: string): Promise<Buffer>;
  /** The command menu Telegram shows in private chats with the bot. */
  setCommands(commands: readonly { command: string; description: string }[]): Promise<void>;
  /** Deletes the bot's own message: Telegram allows it in a private chat for 48 hours. */
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  /** How many are in a group, the bot included. */
  memberCount(chatId: number): Promise<number>;
  /** The bot leaves a group: a group removed in the settings does not keep it. */
  leave(chatId: number): Promise<void>;
  setWebhook(url: string, secret: string): Promise<void>;
}

const API = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;
/** How long a failed getMe is answered from memory. */
const FAILED_MS = 60_000;

/**
 * The secret Telegram sends back in X-Telegram-Bot-Api-Secret-Token with every update: derived from the token, so there
 * is no second variable to keep. 43 characters of base64url, within Telegram's alphabet (A-Z, a-z, 0-9, _ and -).
 */
export const webhookSecret = (token: string): string => createHmac("sha256", token).update("rsva telegram webhook").digest("base64url");

export function telegramApi(token: string, fetchFn: typeof fetch = fetch): TelegramApi {
  async function method<T>(name: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetchFn(`${API}/bot${token}/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: ResponseParameters };
    if (!data.ok) throw new TelegramError(data.error_code ?? res.status, data.description ?? `HTTP ${res.status}`, data.parameters);
    return data.result as T;
  }
  let me: Promise<string> | null = null;
  return {
    username() {
      // Asked once. A failure is kept for a minute: the settings ask on every load, and each would wait for the timeout.
      me ??= method<{ username: string }>("getMe", {}).then(
        (r) => r.username,
        (e: unknown) => {
          setTimeout(() => (me = null), FAILED_MS).unref();
          throw e;
        },
      );
      return me;
    },
    async send(chatId, html, opts = {}) {
      const sent = await method<{ message_id: number }>("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, disable_notification: !!opts.silent, ...(opts.protect ? { protect_content: true } : {}), ...(opts.buttons?.length ? { reply_markup: replyMarkup(opts.buttons) } : {}) });
      return sent.message_id;
    },
    async answerButton(callbackId, text) {
      await method("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
    },
    async download(fileId) {
      const f = await method<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
      if (!f.file_path || (f.file_size ?? 0) > DOWNLOAD_MAX) throw new TelegramError(400, "Bad Request: file is too big");
      const res = await fetchFn(`${API}/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(TIMEOUT_MS * 6) });
      if (!res.ok) throw new TelegramError(res.status, `file download: HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > DOWNLOAD_MAX) throw new TelegramError(400, "Bad Request: file is too big");
      return bytes;
    },
    async setCommands(commands) {
      await method("setMyCommands", { commands: commands.map(({ command, description }) => ({ command, description })), scope: { type: "all_private_chats" } });
    },
    async deleteMessage(chatId, messageId) {
      await method("deleteMessage", { chat_id: chatId, message_id: messageId });
    },
    async memberCount(chatId) {
      return method<number>("getChatMemberCount", { chat_id: chatId });
    },
    async leave(chatId) {
      await method("leaveChat", { chat_id: chatId });
    },
    async setWebhook(url, secret) {
      // Only what the server handles: messages, pressed buttons, and the bot's own membership (blocked, removed from a group). Updates
      // already queued for an older address are dropped.
      await method("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query", "my_chat_member"], drop_pending_updates: true });
    },
  };
}

export const telegramFromEnv = (env: NodeJS.ProcessEnv = process.env): { api: TelegramApi; secret: string } | null => {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  return token ? { api: telegramApi(token), secret: webhookSecret(token) } : null;
};
