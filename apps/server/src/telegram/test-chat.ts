// A linked Telegram chat as the bot's test files drive it: a server with a fake Telegram (fake.ts), the notifier's
// workspace (notify/fixture.ts), and helpers that post updates to the webhook as Telegram would — a message, a pressed
// button — and read the bot's answer. Each file gets its own workspace and its own range of chat ids.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { db, schema } from "../db.ts";
import { DiskBlobStore } from "../files/store.ts";
import { follow } from "../notify/follow.ts";
import { notifyFixture } from "../notify/fixture.ts";
import { sendTelegramDue } from "../notify/telegram.ts";
import { addMember, startServer } from "../test/helpers.ts";
import { webhookSecret } from "./api.ts";
import { fakeTelegram } from "./fake.ts";

/** The bot's answer, as the webhook returns it for Telegram to run. */
export interface Answer {
  method: string;
  text: string;
  message_id?: number;
  reply_markup?: { inline_keyboard: { text: string; callback_data: string; url?: string }[][] };
}

const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

export function chatHarness() {
  const SECRET = webhookSecret("123:test");
  const tg = fakeTelegram();
  const fx = notifyFixture();
  const { f } = fx;
  let server: Awaited<ReturnType<typeof startServer>>;
  before(async () => void (server = await startServer({ telegram: { api: tg.api, secret: SECRET }, blobs: new DiskBlobStore(await mkdtemp(join(tmpdir(), "rsva-tg-"))) })));
  after(() => server.close());

  const post = async (body: unknown) =>
    (await (await fetch(`${server.url}/api/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify(body) })).json()) as Answer;
  const say = (chatId: number, message: Record<string, unknown>) => post({ update_id: 1, message: { message_id: 7, chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "Ann" }, ...message } });
  /** Presses a button of a message sent at `drawnAt`, or sent earlier and last redrawn then (`edit_date`); `text` is the message's plain text. */
  const press = (chatId: number, data: string, drawnAt = new Date(), redrawn = false, text?: string) =>
    post({
      update_id: 2,
      callback_query: {
        id: `q${data}`,
        from: { id: chatId },
        data,
        message: { message_id: 40, ...(text === undefined ? {} : { text }), ...(redrawn ? { date: seconds(drawnAt) - 3600, edit_date: seconds(drawnAt) } : { date: seconds(drawnAt) }), chat: { id: chatId, type: "private" } },
      },
    });
  const buttons = (a: Answer) => a.reply_markup?.inline_keyboard.flat() ?? [];

  let chats = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
  /** A member of the fixture's workspace with a linked chat; with actions on unless `actions` is false (RSVA-496). */
  async function person(role: "member" | "admin" = "member", actions = true) {
    const me = await addMember(f.ws.workspaceId, role);
    const chatId = ++chats;
    await db.insert(schema.telegramChat).values({ userId: me.id, chatId, name: "Ann", actions });
    return { me, chatId };
  }

  /** Follows the fixture's events and sends what is due to Telegram; what went to `chatId`. */
  async function deliver(chatId: number) {
    const now = new Date();
    await follow(f.ws.workspaceId, now, true);
    const before = tg.sent.length;
    await sendTelegramDue(tg.api, "https://plan.example.test", now, f.ws.workspaceId);
    return tg.sent.slice(before).filter((s) => s.chatId === chatId);
  }

  return { ...tg, ...fx, post, say, press, buttons, person, deliver };
}
