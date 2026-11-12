// New waitlist requests in Telegram (RSVA-553): the people in RSVA_WORKSPACE_CREATORS whose personal chat with the bot
// works hear of each new address, with its note and how many are waiting. At most one message a minute: requests that
// come in between go together in the next. No buttons: letting people in stays the server's command (cli/waitlist.ts,
// ADR 0054). Muted chats (/mute) get it silently.
import { and, count, inArray, isNull, sql as dsql } from "drizzle-orm";
import { mailText } from "../auth/mail.ts";
import { db, schema } from "../db.ts";
import { html, type Part } from "../mail/template.ts";
import { TelegramError, type TelegramApi } from "./api.ts";
import { chatFailed } from "./chats.ts";
import { muteRunning } from "./mute.ts";

const { telegramChat, user, waitlist } = schema;

export interface Request {
  email: string;
  note: string;
}

/** The message for these new requests, `waiting` in all. */
export function waitlistMessage(requests: Request[], waiting: number): string {
  const head = requests.length > 1 ? `Waitlist · ${requests.length} new · ${waiting} waiting` : `Waitlist · ${waiting} waiting`;
  const lines: Part[] = [html`<b>${head}</b>`];
  for (const r of requests) lines.push(r.note ? html`<code>${r.email}</code> — ${mailText(r.note)}` : html`<code>${r.email}</code>`);
  return html`${lines.map((l, i) => [i ? "\n" : "", l])}`.value;
}

/** Sends the requests to every listed creator with a working chat. */
async function notify(api: TelegramApi, requests: Request[], log: { error(e: unknown, msg: string): void }, now: Date): Promise<void> {
  const creators = (process.env.RSVA_WORKSPACE_CREATORS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!creators.length) return;
  const chats = await db
    .select({ userId: telegramChat.userId, chatId: telegramChat.chatId, mutedUntil: telegramChat.mutedUntil })
    .from(telegramChat)
    .innerJoin(user, dsql`${user.id} = ${telegramChat.userId}`)
    .where(and(inArray(dsql`lower(${user.email})`, creators), isNull(telegramChat.error)));
  if (!chats.length) return;
  const [w] = await db.select({ n: count() }).from(waitlist).where(isNull(waitlist.admittedAt));
  const text = waitlistMessage(requests, w?.n ?? 0);
  for (const c of chats) {
    try {
      await api.send(c.chatId, text, { silent: !!muteRunning(c.mutedUntil, now) });
    } catch (e) {
      if (e instanceof TelegramError && e.permanent) await chatFailed(c.userId, e.reason);
      log.error(e, "waitlist notice not sent to Telegram");
    }
  }
}

/** Gathers new requests and sends them at most once every `everyMs`. */
export class WaitlistNotifier {
  private pending: Request[] = [];
  private last = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | null = null;
  /** The send under way, for the tests and for closing the server. */
  sending: Promise<void> = Promise.resolve();

  private readonly api: TelegramApi;
  private readonly log: { error(e: unknown, msg: string): void };
  private readonly everyMs: number;

  constructor(api: TelegramApi, log: { error(e: unknown, msg: string): void }, everyMs = 60_000) {
    this.api = api;
    this.log = log;
    this.everyMs = everyMs;
  }

  add(r: Request): void {
    this.pending.push(r);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), Math.max(0, this.last + this.everyMs - Date.now()));
    this.timer.unref();
  }

  private flush(): void {
    this.timer = null;
    const batch = this.pending.splice(0);
    if (!batch.length) return;
    this.last = Date.now();
    this.sending = notify(this.api, batch, this.log, new Date()).catch((e: unknown) => this.log.error(e, "waitlist notice failed"));
  }

  /** Stops the timer: what waits for it is dropped (the list itself is in the database). */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
