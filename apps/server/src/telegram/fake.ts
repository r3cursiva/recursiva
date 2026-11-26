// Telegram as the tests answer it (PLNR-202, PLNR-204, PLNR-205): what was sent, deleted and left, the buttons answered,
// the files a test put up for download, and a refusal when a test sets one. No test reaches the network.
import type { Picture, SendOptions, TelegramApi, TelegramError } from "./api.ts";

export function fakeTelegram() {
  const sent: { chatId: number; html: string; opts: SendOptions }[] = [];
  /** The pictures sent, each call with the ids it answered: numbered from 10 001, apart from the messages'. */
  const pictures: { chatId: number; pictures: Picture[]; replyTo: number; ids: number[] }[] = [];
  let pictureIds = 10_000;
  const deleted: { chatId: number; messageId: number }[] = [];
  const left: number[] = [];
  const answered: { callbackId: string; text?: string }[] = [];
  /** What `download` returns, by file id. */
  const files = new Map<string, Buffer>();
  /** Thrown by the next sends: once, or for every send while `always`. */
  const refusal: { error: TelegramError | null; always: boolean } = { error: null, always: true };
  const api: TelegramApi = {
    username: async () => "plnr_test_bot",
    send: async (chatId, html, opts = {}) => {
      const e = refusal.error;
      if (e) {
        if (!refusal.always) refusal.error = null;
        throw e;
      }
      sent.push({ chatId, html, opts });
      // The message's id in its chat, as Telegram numbers them: here, its place in the list.
      return sent.length;
    },
    sendPictures: async (chatId, list, replyTo) => {
      if (refusal.error) throw refusal.error;
      const ids = list.map(() => ++pictureIds);
      pictures.push({ chatId, pictures: list, replyTo, ids });
      return ids;
    },
    answerButton: async (callbackId, text) => void answered.push({ callbackId, ...(text ? { text } : {}) }),
    download: async (fileId) => files.get(fileId) ?? Promise.reject(new Error(`no file ${fileId}`)),
    setCommands: async () => {},
    deleteMessage: async (chatId, messageId) => void deleted.push({ chatId, messageId }),
    memberCount: async () => 4,
    leave: async (chatId) => void left.push(chatId),
    setWebhook: async () => {},
  };
  /** Telegram refuses while `run` runs (or only its first send, with `once`). */
  async function refusing<T>(error: TelegramError, run: () => Promise<T>, once = false): Promise<T> {
    Object.assign(refusal, { error, always: !once });
    try {
      return await run();
    } finally {
      refusal.error = null;
    }
  }
  return { api, sent, pictures, deleted, left, answered, files, refusing };
}
