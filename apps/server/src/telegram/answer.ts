// What the bot says back, as the webhook's response: Telegram runs it as the method it names, so an answer costs no call.
import { replyMarkup, type Buttons } from "./api.ts";

const html = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;

/** A message in the chat; `to` puts it under the person's own message, so it reads as about it. */
export const reply = (chatId: number, text: string, to?: number, buttons?: Buttons) => ({
  method: "sendMessage",
  chat_id: chatId,
  text,
  ...html,
  ...(to ? { reply_parameters: { message_id: to, allow_sending_without_reply: true } } : {}),
  ...(buttons?.length ? { reply_markup: replyMarkup(buttons) } : {}),
});

/** HTML the bot would send (a refusal of the write path) as plain text, for a toast or to be escaped again. */
export const plain = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&(lt|gt|quot|#39|amp);/g, (_, e: string) => ({ lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" })[e]!);

/** The bot's own message drawn again, with its buttons: a page turned, a line marked read. */
export const redraw = (chatId: number, messageId: number, text: string, buttons: Buttons) => ({
  method: "editMessageText",
  chat_id: chatId,
  message_id: messageId,
  text,
  ...html,
  reply_markup: replyMarkup(buttons),
});

/** Only the buttons of the bot's own message drawn again; its text stays. */
export const redrawButtons = (chatId: number, messageId: number, buttons: Buttons) => ({
  method: "editMessageReplyMarkup",
  chat_id: chatId,
  message_id: messageId,
  reply_markup: replyMarkup(buttons),
});
