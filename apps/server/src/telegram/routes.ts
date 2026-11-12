// Linking a Telegram chat (PLNR-202); group chats are groups.ts (PLNR-204), commands and buttons commands.ts (PLNR-205). The settings page asks for a start link (`t.me/<bot>?start=<code>`, ten minutes,
// with a QR code drawn here); the person presses Start, Telegram calls the webhook with `/start <code>`, and the chat is
// theirs. The page waits on a long request that this process answers the moment the chat is linked, and the reply to
// /start rides on the webhook's own response, so linking makes no call to Telegram at all.
//
// The webhook has no session: Telegram's secret header is its whole authentication, checked before the body is read.
//
// Sign-in codes go to the linked chat too (PLNR-215), so asking for a start link needs a fresh sign-in, as adding a
// passkey does, and the account's address hears of every chat linked (PLNR-223): a stolen cookie of any age must not
// give itself a way to sign in again.
import type { TelegramLink, TelegramView } from "@rsva/protocol";
import { settingsPath } from "@rsva/schema/models";
import { and, count, eq, gt, gte, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { encode } from "uqr";
import { z } from "zod";
import { workspacesOf } from "../auth/access.ts";
import { mailLater, PUBLIC_ORIGIN, type Mail, type Mailer } from "../auth/mail.ts";
import { freshBrowserMailed, requireActor } from "../auth/routes.ts";
import { sameSecret, sha256 } from "../auth/secret.ts";
import { db, schema } from "../db.ts";
import { telegramActionsMail, telegramLinkedMail } from "../mail/emails.ts";
import type { BlobStore } from "../files/store.ts";
import type { TelegramApi } from "./api.ts";
import { TelegramError } from "./api.ts";
import { reply } from "./answer.ts";
import { forwardDraft, joinAlbum } from "./capture.ts";
import { chatFailed, chatWorks, notificationsOnly, unlinkChat } from "./chats.ts";
import { freshCode } from "./code.ts";
import { keyCards, notificationsOnlyMessage, pressButton, runCommand, type ButtonPress, type CommandMessage } from "./commands.ts";
import { groupMessage, groupsOf, membershipChanged, registerTelegramGroups } from "./groups.ts";
import { maskEmail, testMessage } from "./message.ts";
import { muteRunning, setMute } from "./mute.ts";
import { notMeButton } from "./not-me.ts";
import { commentFromReply, type IncomingMessage } from "./reply.ts";
import { held, wake, wakeAll } from "./wait.ts";
import { errorText } from "@rsva/schema/util";
import { parse } from "../http.ts";

const { telegramChat, telegramCode, user, notifyOutbox } = schema;

export interface TelegramOptions {
  api: TelegramApi;
  /** What Telegram sends in X-Telegram-Bot-Api-Secret-Token (api.ts, webhookSecret). */
  secret: string;
}


/**
 * A QR code as one path of unit squares, row by row, a run of dark modules at a time: 4-6 KB for a t.me link
 * before compression (33 modules a side for a 12-letter bot name, measured 2026-11-03). Level Q
 * (a quarter may be lost) so the Telegram mark the page lays over its middle does not stop a camera reading it.
 */
export function qrPath(text: string): { size: number; path: string } {
  const { size, data } = encode(text, { ecc: "Q", border: 0 });
  let path = "";
  data.forEach((row, y) => {
    for (let x = 0; x < size; x++) {
      if (!row[x]) continue;
      let end = x;
      while (end < size && row[end]) end++;
      path += `M${x} ${y}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  });
  return { size, path };
}

/** The person's Telegram as the settings show it. `bot` is null when the server has no bot or cannot reach Telegram. */
export async function telegramView(userId: string, tg: TelegramOptions | null): Promise<TelegramView> {
  const [bot, [c], groups] = await Promise.all([tg ? tg.api.username().catch(() => null) : null, db.select().from(telegramChat).where(eq(telegramChat.userId, userId)), groupsOf(userId)]);
  // The emails sent instead since the chat stopped (notify/telegram.ts), for the banner.
  const [sentInstead] =
    c?.errorAt ? await db.select({ n: count() }).from(notifyOutbox).where(and(eq(notifyOutbox.userId, userId), eq(notifyOutbox.fallback, true), eq(notifyOutbox.status, "sent"), gte(notifyOutbox.createdAt, c.errorAt))) : [];
  return { bot, chat: c ? { username: c.username, name: c.name, linkedAt: c.linkedAt, error: c.error, errorAt: c.errorAt, fallbacks: sentInstead?.n ?? 0, actions: c.actions, mutedUntil: muteRunning(c.mutedUntil, new Date())?.toISOString() ?? null } : null, groups };
}

/** Where a person changes their notifications: the settings of their first workspace, or the app's root. */
async function settingsLink(userId: string): Promise<string> {
  const origin = PUBLIC_ORIGIN ?? "";
  const [w] = await workspacesOf(userId);
  return w ? `${origin}${settingsPath(w.slug, "notifications")}` : `${origin}/`;
}

interface Update {
  message?: IncomingMessage & CommandMessage & {
    from?: { is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
    chat: { title?: string };
    migrate_to_chat_id?: number;
    new_chat_title?: string;
  };
  my_chat_member?: { chat: { id: number; type: string }; new_chat_member?: { status?: string } };
  callback_query?: ButtonPress;
}

/**
 * `/start <code>` in a private chat: links the chat to whoever asked for the code, if it is theirs and fresh, and tells
 * their address. The answer does not wait for the mail.
 */
async function start(u: NonNullable<Update["message"]>, code: string | undefined, notify: (m: Mail) => void) {
  if (!code) return reply(u.chat.id, "To get notifications here, open Settings › Notifications › Telegram in recursiva and press Connect Telegram.");
  const [row] = await db
    .delete(telegramCode)
    .where(and(eq(telegramCode.id, sha256(code)), gt(telegramCode.expiresAt, dsql`now()`)))
    .returning({ userId: telegramCode.userId });
  if (!row) return reply(u.chat.id, "This link has expired or was already used. Open Settings › Notifications › Telegram in recursiva for a new one.");
  const name = [u.from?.first_name, u.from?.last_name].filter(Boolean).join(" ").slice(0, 120) || "Telegram";
  // Linked again, too, it starts with notifications only (RSVA-496): the chat may be another account's now.
  const chat = { chatId: u.chat.id, username: u.from?.username?.slice(0, 64) ?? null, name, linkedAt: new Date().toISOString(), error: null, errorAt: null, actions: false };
  await db.insert(telegramChat).values({ userId: row.userId, ...chat }).onConflictDoUpdate({ target: telegramChat.userId, set: chat });
  wake(row.userId);
  const [me] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, row.userId));
  if (me) notify(telegramLinkedMail({ to: me.email, chatName: name, username: chat.username, origin: PUBLIC_ORIGIN ?? "" }));
  return reply(u.chat.id, testMessage(me?.name ?? "you", maskEmail(me?.email ?? ""), await settingsLink(row.userId), false), undefined, notMeButton(row.userId));
}

/** Sends the test message; a chat that refuses it is marked, as a notification it refused would be. */
async function sendTest(api: TelegramApi, userId: string): Promise<void> {
  const [[c], [me]] = await Promise.all([db.select().from(telegramChat).where(eq(telegramChat.userId, userId)), db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, userId))]);
  if (!c) throw Object.assign(new Error("Telegram is not connected."), { statusCode: 404 });
  try {
    await api.send(c.chatId, testMessage(me?.name ?? "you", maskEmail(me?.email ?? ""), await settingsLink(userId), c.actions));
    if (c.error) await chatWorks(userId);
  } catch (e) {
    if (e instanceof TelegramError && e.permanent) await chatFailed(userId, e.reason);
    throw Object.assign(new Error(errorText(e)), { statusCode: 502 });
  }
}


export function registerTelegram(app: FastifyInstance, tg: TelegramOptions | null, mailer: Mailer, files: BlobStore): void {
  const session = { preHandler: requireActor({ sessionOnly: true }) };
  const noBot = () => Object.assign(new Error("Telegram is not set up on this server."), { statusCode: 503 });

  if (tg)
    app.post<{ Body: Update }>("/api/telegram/webhook", {
      bodyLimit: 64 * 1024,
      // Before the body is parsed: a stranger's request costs nothing.
      onRequest: async (req, reply) => {
        const header = req.headers["x-telegram-bot-api-secret-token"];
        if (typeof header !== "string" || !sameSecret(header, tg.secret)) return reply.code(401).send({ error: "unauthorized" });
      },
    }, async (req) => {
      const u = req.body;
      if (u?.my_chat_member?.chat) {
        await membershipChanged(u.my_chat_member);
        return {};
      }
      if (u?.callback_query) return pressButton(u.callback_query, { api: tg.api, files });
      const m = u?.message;
      if (!m?.chat || m.from?.is_bot) return {};
      const notify = (mail: Mail) => mailLater(mailer, mail, req.log, "Telegram link notice");
      if (m.chat.type === "group" || m.chat.type === "supergroup") return groupMessage(m, tg.api, notify);
      // A channel or anything else is taken and ignored, so Telegram does not resend it.
      if (m.chat.type !== "private") return {};
      const [command, code] = (m.text ?? "").trim().split(/\s+/, 2);
      if (command === "/start") return start(m, code?.slice(0, 64), notify);
      // Notifications only (RSVA-496): nothing below acts for anyone.
      if (await notificationsOnly(m.chat.id)) return notificationsOnlyMessage(m, { api: tg.api, files });
      // A file of an album, kept for its /new (capture.ts); a forwarded message gets a draft of an issue.
      if (await joinAlbum(m)) return {};
      const draft = await forwardDraft(m);
      if (draft) return draft;
      // Any other command, also as a photo's caption (commands.ts); anything else may be a reply to a notification.
      const done = await runCommand(m, { api: tg.api, files });
      if (done) return done;
      // Issue keys alone: their cards (card.ts).
      const cards = await keyCards(m, tg.api);
      if (cards) return cards;
      const answer = await commentFromReply(m);
      return answer ? reply(m.chat.id, answer, m.message_id) : {};
    });

  // A page still waiting does not hold a restart for its 25 seconds: it is answered now and asks the new process.
  app.addHook("preClose", async () => wakeAll());
  registerTelegramGroups(app, tg, (userId) => telegramView(userId, tg));

  app.post("/auth/telegram/link", session, async (req, reply): Promise<TelegramLink | typeof reply> => {
    if (!tg) throw noBot();
    freshBrowserMailed(req, "connect Telegram");
    const { bot, code, id, createdAt, expiresAt } = await freshCode(tg.api);
    const userId = req.actor!.userId;
    await db.insert(telegramCode).values({ id, userId, expiresAt }).onConflictDoUpdate({ target: telegramCode.userId, set: { id, expiresAt } });
    const url = `https://t.me/${bot}?start=${code}`;
    return { code, url, createdAt, expiresAt, qr: qrPath(url) };
  });

  // Held until the chat is linked or WAIT_MS pass, then answered with the person's Telegram either way.
  app.get("/auth/telegram/wait", session, async (req, reply): Promise<TelegramView> => {
    const userId = req.actor!.userId;
    await held(userId, reply);
    return telegramView(userId, tg);
  });

  app.post("/auth/telegram/test", session, async (req, reply) => {
    if (!tg) throw noBot();
    await sendTest(tg.api, req.actor!.userId);
    return reply.code(204).send();
  });

  // Actions in the chat on or off (RSVA-496). On lets the chat change things for the person after this session ends, so it
  // needs a fresh sign-in, as linking does, and the account's address hears of it; off is protection and open to any session.
  app.patch<{ Body: unknown }>("/auth/telegram", session, async (req, reply) => {
    const { actions } = parse(z.object({ actions: z.boolean() }).strict(), req.body);
    const userId = req.actor!.userId;
    if (actions) freshBrowserMailed(req, "turn on actions from Telegram");
    const [c] = await db.update(telegramChat).set({ actions }).where(and(eq(telegramChat.userId, userId), eq(telegramChat.actions, !actions))).returning({ name: telegramChat.name, username: telegramChat.username });
    if (c && actions) {
      const [me] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
      if (me) mailLater(mailer, telegramActionsMail({ to: me.email, chatName: c.name, username: c.username, origin: PUBLIC_ORIGIN ?? "" }), req.log, "Telegram actions notice");
    }
    return reply.code(204).send();
  });

  // Resume (RSVA-255): ends a /mute from the page, as `/mute off` does in the chat; answered with the fresh view.
  app.delete("/auth/telegram/mute", session, async (req): Promise<TelegramView> => {
    const userId = req.actor!.userId;
    await setMute(userId, null);
    return telegramView(userId, tg);
  });

  // Disconnect: the chat ID is deleted, and a link not used yet stops working.
  app.delete("/auth/telegram", session, async (req, reply) => {
    const userId = req.actor!.userId;
    await db.transaction((tx) => unlinkChat(tx, userId));
    wake(userId);
    return reply.code(204).send();
  });
}
