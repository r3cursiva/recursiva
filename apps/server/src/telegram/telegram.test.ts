import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { NOTIFY_DEFAULTS, type NotifyPrefs, type NotifySettingsView, type TelegramLink, type TelegramView } from "@rsva/protocol";
import { ISSUE_KEY } from "@rsva/schema/models";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { follow as followAll } from "../notify/follow.ts";
import { notifyFixture, quietAround, setPrefs } from "../notify/fixture.ts";
import { sendTelegramDue } from "../notify/telegram.ts";
import { forgetRoles } from "../auth/access.ts";
import { DAILY_FAILURES } from "../auth/codes.ts";
import { randomSecret, sha256 } from "../auth/secret.ts";
import type { Mail } from "../auth/mail.ts";
import { addMember, agedSession, asUser, fetchAs, startServer, tenThenLimited } from "../test/helpers.ts";
import { TelegramError, webhookSecret } from "./api.ts";
import { fakeTelegram } from "./fake.ts";
import { maskEmail } from "./message.ts";
import { qrPath } from "./routes.ts";
import { codeToTelegram, dropTelegramCode } from "./sign-in.ts";

const { notifyOutbox, telegramChat, telegramCode, comment, member, loginFailure, loginCode, signInDevice } = schema;
const ORIGIN = "https://plan.example.test";
const SECRET = webhookSecret("123:test");

const { api, sent, deleted, answered, refusing } = fakeTelegram();
const mails: Mail[] = [];

const { f, tx, newIssue, mentionedInThread } = notifyFixture();
let server: Awaited<ReturnType<typeof startServer>>;
before(async () => void (server = await startServer({ telegram: { api, secret: SECRET }, signInTelegram: api, mailer: async (m) => void mails.push(m) })));
after(() => server.close());

const post = (body: unknown, secret = SECRET) =>
  fetch(`${server.url}/api/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(body) });
const start = (chatId: number, text: string) => post({ update_id: 1, message: { message_id: 1, text, chat: { id: chatId, type: "private" }, from: { id: chatId, is_bot: false, first_name: "Ann", username: "ann_t" } } });
let chats = 1000;
/** The notifier of a server with a bot. */
const follow = (ws: string, now = new Date()) => followAll(ws, now, true);

/** A new member whose chat is linked through the page's flow: a link, Start in Telegram, the page's wait answered. */
async function linked() {
  const me = await addMember(f.ws.workspaceId, "member");
  const as = fetchAs(await asUser(me.id));
  const link = (await (await as(`${server.url}/auth/telegram/link`, { method: "POST" })).json()) as TelegramLink;
  const chatId = ++chats;
  const waited = as(`${server.url}/auth/telegram/wait`).then((r) => r.json() as Promise<TelegramView>);
  const answer = (await (await start(chatId, `/start ${link.code}`)).json()) as { method: string; chat_id: number; text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } };
  return { me, as, link, chatId, answer, view: await waited };
}

test("a start link: the bot's t.me address with a ten-minute code, and its QR code", async () => {
  const { link } = await linked();
  assert.match(link.url, /^https:\/\/t\.me\/plnr_test_bot\?start=[2-9a-zA-Z]{10}$/);
  assert.ok(Date.parse(link.expiresAt) - Date.now() > 9 * 60_000);
  assert.ok(link.qr.size >= 21 && link.qr.path.startsWith("M"));
  assert.deepEqual(qrPath("x"), qrPath("x"), "the same text, the same code");
});

test("Start links the chat, answers on the webhook's response and wakes the waiting page", async () => {
  const { me, chatId, answer, view } = await linked();
  assert.equal(answer.method, "sendMessage");
  assert.equal(answer.chat_id, chatId);
  assert.match(answer.text, /recursiva is connected/);
  assert.equal(view.bot, "plnr_test_bot");
  assert.deepEqual({ ...view.chat, linkedAt: "" }, { username: "ann_t", name: "Ann", linkedAt: "", error: null, errorAt: null, fallbacks: 0, actions: false, mutedUntil: null });
  const [row] = await db.select().from(telegramChat).where(eq(telegramChat.userId, me.id));
  assert.equal(row!.chatId, chatId);
});

/** The HTTP status of each Not me press, in order. */
const pressStatus: number[] = [];
const pressNotMe = (chatId: number, data: string, inChat = chatId, type = "private", date = Math.floor(Date.now() / 1000)) =>
  post({ update_id: 2, callback_query: { id: `nm-${data}`, from: { id: chatId }, data, message: { message_id: 40, date, chat: { id: inChat, type } } } }).then(async (r) => {
    pressStatus.push(r.status);
    return (await r.json()) as { method?: string; text?: string; reply_markup?: { inline_keyboard: unknown[] } };
  });

test("a masked address: the first character, three dots, the domain (PLNR-256)", () => {
  assert.equal(maskEmail("ann@example.com"), "a•••@example.com");
  assert.equal(maskEmail("a@example.com"), "a•••@example.com");
  assert.equal(maskEmail("ann.o'neil+x@mail.example.com"), "a•••@mail.example.com");
  assert.equal(maskEmail("Éva@example.com"), "É•••@example.com", "a whole character, not half of one");
  assert.equal(maskEmail("nobody"), "•••");
});

test("the Start reply names the account by its masked address and offers Not me (PLNR-256)", async () => {
  const { me, answer } = await linked();
  assert.ok(answer.text.includes(`(${maskEmail(me.email)})`), answer.text);
  assert.ok(!answer.text.includes(me.email), "never the whole address");
  assert.deepEqual(answer.reply_markup?.inline_keyboard, [[{ text: "Not me", callback_data: `nm:${me.id}` }]]);
  assert.ok(Buffer.byteLength(`nm:${me.id}`) <= 64);
});

test("Send a test says the same, without the button (PLNR-256)", async () => {
  const { me, as } = await linked();
  assert.equal((await as(`${server.url}/auth/telegram/test`, { method: "POST" })).status, 204);
  const last = sent.at(-1)!;
  assert.ok(last.html.includes(`(${maskEmail(me.email)})`), last.html);
  assert.equal(last.opts.buttons, undefined);
});

test("Not me unlinks the chat, redraws the message without buttons and updates the page (PLNR-256)", async () => {
  const { me, as, chatId } = await linked();
  const waited = as(`${server.url}/auth/telegram/wait`).then((r) => r.json() as Promise<TelegramView>);
  const res = await pressNotMe(chatId, `nm:${me.id}`);
  assert.equal(res.method, "editMessageText");
  assert.equal(res.text, `Disconnected. This chat no longer gets anything from ${maskEmail(me.email)}.`);
  assert.deepEqual(res.reply_markup?.inline_keyboard, []);
  assert.deepEqual(await db.select().from(telegramChat).where(eq(telegramChat.userId, me.id)), []);
  assert.equal((await waited).chat, null, "an open settings page is woken");
  assert.equal(((await (await as(`${server.url}/auth/notifications`)).json()) as { telegram: TelegramView }).telegram.chat, null);
  assert.equal(answered.at(-1)?.callbackId, `nm-nm:${me.id}`);
  // Pressed again: nothing is connected, nothing breaks.
  const again = await pressNotMe(chatId, `nm:${me.id}`);
  assert.equal(again.method, undefined);
  assert.match(answered.at(-1)?.text ?? "", /not connected/);
});

test("Not me voids a start link not used yet (PLNR-256)", async () => {
  const { me, as, chatId } = await linked();
  await as(`${server.url}/auth/telegram/link`, { method: "POST" });
  assert.equal((await db.select().from(telegramCode).where(eq(telegramCode.userId, me.id))).length, 1);
  await pressNotMe(chatId, `nm:${me.id}`);
  assert.deepEqual(await db.select().from(telegramCode).where(eq(telegramCode.userId, me.id)), []);
});

test("Not me with another account's id, from another chat or in a group unlinks nothing (PLNR-256)", async () => {
  const mine = await linked();
  const theirs = await linked();
  const kept = async (id: string) => (await db.select().from(telegramChat).where(eq(telegramChat.userId, id))).length;
  // My chat names their account: it is not theirs to undo.
  assert.equal((await pressNotMe(mine.chatId, `nm:${theirs.me.id}`)).method, undefined);
  assert.match(answered.at(-1)?.text ?? "", /not connected/);
  // Their chat names my account.
  assert.equal((await pressNotMe(theirs.chatId, `nm:${mine.me.id}`)).method, undefined);
  // A press from a chat that is not the linked one, and from a group.
  assert.equal((await pressNotMe(mine.chatId + 5000, `nm:${mine.me.id}`)).method, undefined);
  assert.equal((await pressNotMe(mine.chatId, `nm:${mine.me.id}`, mine.chatId, "supergroup")).method, undefined);
  assert.equal((await pressNotMe(mine.chatId, "nm:")).method, undefined);
  // Not a uuid, or a uuid of nobody: the webhook still answers 200 (a 500 would be resent), with the same toast.
  for (const data of ["nm:abc", `nm:${randomUUID()}`]) {
    const before = answered.length;
    assert.equal((await pressNotMe(mine.chatId, data)).method, undefined, data);
    assert.equal(pressStatus.at(-1), 200, data);
    assert.equal(answered.length, before + 1);
    assert.match(answered.at(-1)?.text ?? "", /not connected/);
  }
  assert.equal(await kept(mine.me.id), 1);
  assert.equal(await kept(theirs.me.id), 1);
  assert.equal(((await (await mine.as(`${server.url}/auth/notifications`)).json()) as { telegram: TelegramView }).telegram.chat?.name, "Ann");
});

test("Not me works in a chat linked to two accounts, and undoes only the one named (PLNR-256)", async () => {
  const a = await linked();
  const b = await addMember(f.ws.workspaceId, "member");
  await db.insert(telegramChat).values({ userId: b.id, chatId: a.chatId, name: "Ann" });
  const res = await pressNotMe(a.chatId, `nm:${b.id}`);
  assert.equal(res.method, "editMessageText");
  assert.equal((await db.select().from(telegramChat).where(eq(telegramChat.userId, a.me.id))).length, 1);
  assert.equal((await db.select().from(telegramChat).where(eq(telegramChat.userId, b.id))).length, 0);
});

test("a start link needs a fresh sign-in, and a linked chat is mailed to the account (PLNR-223)", async () => {
  const me = await addMember(f.ws.workspaceId, "member");
  const stale = await fetchAs(await agedSession(await asUser(me.id)))(`${server.url}/auth/telegram/link`, { method: "POST" });
  assert.equal(stale.status, 403);
  assert.equal(((await stale.json()) as { error: string }).error, "reauth_required");
  assert.deepEqual(await db.select().from(telegramCode).where(eq(telegramCode.userId, me.id)), [], "no code was made");

  // A session signed in a moment ago, as after "Confirm it's you".
  const { me: fresh, view } = await linked();
  assert.ok(view.chat);
  const notices = mails.filter((m) => m.to === fresh.email);
  assert.deepEqual(notices.map((m) => m.subject), ["Telegram was connected to your recursiva account"]);
  assert.match(notices[0]!.text, /The Telegram chat of Ann \(@ann_t\) was connected/);
});

test("ten start links a person may ask for in an hour; the last one under the limit still links and is mailed (RSVA-249)", async () => {
  const me = await addMember(f.ws.workspaceId, "member");
  const as = fetchAs(await asUser(me.id));
  const link = (await (await tenThenLimited(() => as(`${server.url}/auth/telegram/link`, { method: "POST" }))).json()) as TelegramLink;

  // Start is never limited: the chat is linked and the account hears of it, once.
  await start(++chats, `/start ${link.code}`);
  assert.equal((await db.select().from(telegramChat).where(eq(telegramChat.userId, me.id))).length, 1);
  assert.deepEqual(mails.filter((m) => m.to === me.email).map((m) => m.subject), ["Telegram was connected to your recursiva account"]);
});

test("a used, wrong or missing code links nothing; a wrong secret is refused before the body", async () => {
  const { link, chatId } = await linked();
  const again = (await (await start(chatId + 500, `/start ${link.code}`)).json()) as { text: string };
  assert.match(again.text, /expired or was already used/);
  assert.match(((await (await start(chatId + 501, "/start nope")).json()) as { text: string }).text, /expired/);
  assert.match(((await (await start(chatId + 502, "/start")).json()) as { text: string }).text, /Connect Telegram/);
  assert.equal((await post({ message: { text: "/start x", chat: { id: 1, type: "private" } } }, "wrong")).status, 401);
  assert.match(((await (await post({ message: { text: "/start x", chat: { id: 1, type: "group" } } })).json()) as { text: string }).text, /expired/, "a group's wrong code links nothing");
});

test("a code past its ten minutes links nothing", async () => {
  const me = await addMember(f.ws.workspaceId, "member");
  const link = (await (await fetchAs(await asUser(me.id))(`${server.url}/auth/telegram/link`, { method: "POST" })).json()) as TelegramLink;
  await db.update(telegramCode).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(telegramCode.userId, me.id));
  assert.match(((await (await start(++chats, `/start ${link.code}`)).json()) as { text: string }).text, /expired/);
  assert.deepEqual(await db.select().from(telegramChat).where(eq(telegramChat.userId, me.id)), []);
});

test("after Disconnect, what was on its way to the chat is dropped", async () => {
  const { me, as, chatId } = await linked();
  await setPrefs(me.id, { ...NOTIFY_DEFAULTS, seen: false, quiet: null, rules: { assigned: { telegram: "now" } } });
  const id = await newIssue(f.ws.ownerId);
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [me.id] } }]);
  const now = new Date();
  await follow(f.ws.workspaceId, now);
  await as(`${server.url}/auth/telegram`, { method: "DELETE" });
  const before = sent.length;
  await sendTelegramDue(api, ORIGIN, now, f.ws.workspaceId);
  assert.equal(sent.filter((s, i) => i >= before && s.chatId === chatId).length, 0);
  const [row] = await db.select().from(notifyOutbox).where(and(eq(notifyOutbox.userId, me.id), eq(notifyOutbox.issueId, id), eq(notifyOutbox.channel, "telegram")));
  assert.equal(row!.status, "dropped");
});

test("a server without a bot writes no Telegram rows", async () => {
  const { me } = await linked();
  await setPrefs(me.id, { ...NOTIFY_DEFAULTS, rules: { assigned: { telegram: "now" } } });
  const id = await newIssue(f.ws.ownerId);
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [me.id] } }]);
  await followAll(f.ws.workspaceId, new Date());
  assert.deepEqual(await db.select().from(notifyOutbox).where(and(eq(notifyOutbox.userId, me.id), eq(notifyOutbox.issueId, id), eq(notifyOutbox.channel, "telegram"))), []);
});

test("the settings carry the chat; Send a test reaches it; Disconnect deletes it", async () => {
  const { me, as, chatId } = await linked();
  const view = (await (await as(`${server.url}/auth/notifications`)).json()) as NotifySettingsView;
  assert.equal(view.telegram.chat?.username, "ann_t");
  assert.equal((await as(`${server.url}/auth/telegram/test`, { method: "POST" })).status, 204);
  assert.equal(sent.at(-1)!.chatId, chatId);
  assert.equal((await as(`${server.url}/auth/telegram`, { method: "DELETE" })).status, 204);
  assert.deepEqual(await db.select().from(telegramChat).where(eq(telegramChat.userId, me.id)), []);
  assert.equal((await as(`${server.url}/auth/telegram/test`, { method: "POST" })).status, 404);
});

test("the page sees a running /mute and Resume ends it; a mute that has run out is not shown (RSVA-255)", async () => {
  const { me, as } = await linked();
  const settings = async () => ((await (await as(`${server.url}/auth/notifications`)).json()) as NotifySettingsView).telegram.chat!;
  const until = new Date(Date.now() + 2 * 3_600_000).toISOString();
  await db.update(telegramChat).set({ mutedUntil: until }).where(eq(telegramChat.userId, me.id));
  assert.equal((await settings()).mutedUntil, until);
  await db.update(telegramChat).set({ mutedUntil: new Date(Date.now() - 60_000).toISOString() }).where(eq(telegramChat.userId, me.id));
  assert.equal((await settings()).mutedUntil, null, "run out");
  await db.update(telegramChat).set({ mutedUntil: until }).where(eq(telegramChat.userId, me.id));
  assert.equal((await fetch(`${server.url}/auth/telegram/mute`, { method: "DELETE" })).status, 401, "a session only");
  const resumed = await as(`${server.url}/auth/telegram/mute`, { method: "DELETE" });
  assert.equal(resumed.status, 200);
  assert.equal(((await resumed.json()) as TelegramView).chat!.mutedUntil, null);
  const [row] = await db.select({ mutedUntil: telegramChat.mutedUntil }).from(telegramChat).where(eq(telegramChat.userId, me.id));
  assert.equal(row!.mutedUntil, null);
});

test("a mention goes to the chat ten minutes later; the Telegram column decides, not email's", async () => {
  const { me, chatId } = await linked();
  // Email off for mentions: Telegram follows its own column.
  await setPrefs(me.id, { ...NOTIFY_DEFAULTS, rules: { mention: { email: "off" } }, telegram: { silent: true, length: "full" } });
  const id = await newIssue(f.ws.ownerId);
  await tx(f.ws.ownerId, [{ op: "create", m: "Comment", id: randomUUID(), set: { issueId: id, body: `Look at this [@x](mention:${me.id})` } }]);
  const now = new Date();
  await follow(f.ws.workspaceId, now);
  const rows = await db.select().from(notifyOutbox).where(and(eq(notifyOutbox.userId, me.id), eq(notifyOutbox.issueId, id)));
  assert.deepEqual(rows.map((r) => r.channel), ["telegram"]);
  assert.equal(await sendTelegramDue(api, ORIGIN, now, f.ws.workspaceId), 0, "not before it is due");
  await sendTelegramDue(api, ORIGIN, new Date(now.getTime() + 11 * 60_000), f.ws.workspaceId);
  const msg = sent.filter((s) => s.chatId === chatId).at(-1)!;
  assert.match(msg.html, new RegExp(`<code>${f.refs.project.key}-\\d+</code> · Mentioned`));
  assert.match(msg.html, new RegExp(`<a href="https://plan\\.example\\.test/[^"]+/browse/${ISSUE_KEY}">Rotate the edge nodes</a>`));
  assert.match(msg.html, /<blockquote>Look at this @x<\/blockquote>/, "with the comment");
  assert.equal(msg.opts.silent, false);
});

/** A new issue assigned to `userId`; its id. */
async function assignNew(userId: string) {
  const id = await newIssue(f.ws.ownerId);
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [userId] } }]);
  return id;
}

test("in quiet hours it goes silently, or waits for their end; a blocked bot stops the chat", async () => {
  const { me, chatId } = await linked();
  const now = new Date();
  const quiet = (silent: boolean): NotifyPrefs => ({ ...NOTIFY_DEFAULTS, seen: false, quiet: quietAround(now), urgent: false, telegram: { silent, length: "short" } });
  const assign = () => assignNew(me.id);
  await setPrefs(me.id, { ...quiet(true), rules: { assigned: { telegram: "now" } } }, "UTC");
  await assign();
  await follow(f.ws.workspaceId, now);
  await sendTelegramDue(api, ORIGIN, now, f.ws.workspaceId);
  const msg = sent.filter((s) => s.chatId === chatId).at(-1)!;
  assert.equal(msg.opts.silent, true);
  assert.doesNotMatch(msg.html, /blockquote/, "short");

  await setPrefs(me.id, { ...quiet(false), rules: { assigned: { telegram: "now" } } }, "UTC");
  const held = await assign();
  await follow(f.ws.workspaceId, now);
  const [row] = await db.select().from(notifyOutbox).where(and(eq(notifyOutbox.userId, me.id), eq(notifyOutbox.issueId, held), eq(notifyOutbox.channel, "telegram")));
  assert.ok(Date.parse(row!.dueAt) > now.getTime(), "held until quiet hours end");

  await refusing(new TelegramError(403, "Forbidden: bot was blocked by the user"), async () => {
    await sendTelegramDue(api, ORIGIN, new Date(Date.parse(row!.dueAt) + 1000), f.ws.workspaceId);
  });
  const [chat] = await db.select().from(telegramChat).where(eq(telegramChat.userId, me.id));
  assert.match(chat!.error!, /blocked/);
  const [failed] = await db.select().from(notifyOutbox).where(eq(notifyOutbox.id, row!.id));
  assert.equal(failed!.status, "failed");
  // No new rows for a chat that refuses.
  const next = await assign();
  await follow(f.ws.workspaceId, now);
  assert.deepEqual(await db.select().from(notifyOutbox).where(and(eq(notifyOutbox.userId, me.id), eq(notifyOutbox.issueId, next), eq(notifyOutbox.channel, "telegram"))), []);
});

test("a 429 holds the chat for its retry_after without spending a try; another refusal waits for the lease (RSVA-212)", async () => {
  const { me, chatId } = await linked();
  await setPrefs(me.id, { ...NOTIFY_DEFAULTS, seen: false, quiet: null, rules: { assigned: { telegram: "now" } } });
  const assign = () => assignNew(me.id);
  const issues = [await assign(), await assign()];
  const now = new Date();
  await follow(f.ws.workspaceId, now);
  const rows = async () => (await db.select().from(notifyOutbox).where(and(eq(notifyOutbox.userId, me.id), eq(notifyOutbox.channel, "telegram")))).filter((r) => issues.includes(r.issueId));
  assert.equal((await rows()).length, 2);
  await refusing(new TelegramError(429, "Too Many Requests: retry after 7", { retry_after: 7 }), () => sendTelegramDue(api, ORIGIN, now, f.ws.workspaceId), true);
  assert.equal(sent.filter((s) => s.chatId === chatId).length, 0, "the second is not sent to a chat that asked to wait");
  const held = await rows();
  assert.deepEqual(
    held.map((r) => [r.status, Date.parse(r.dueAt), r.attempts]),
    held.map(() => ["pending", now.getTime() + 7000, 0]),
    "both due once the wait is over, no try spent",
  );

  // Not a rate limit: the lease of take() and one try spent, as before.
  const later = new Date(now.getTime() + 7000);
  await refusing(new TelegramError(500, "Internal Server Error"), () => sendTelegramDue(api, ORIGIN, later, f.ws.workspaceId));
  const leased = await rows();
  assert.deepEqual(
    leased.map((r) => [r.status, Date.parse(r.dueAt), r.attempts]),
    leased.map(() => ["pending", later.getTime() + 5 * 60_000, 1]),
  );
});

/** Turns actions in the person's chat on or off, as the Telegram page does (RSVA-496). */
const setActions = (as: ReturnType<typeof fetchAs>, actions: boolean) =>
  as(`${server.url}/auth/telegram`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ actions }) });

/** A person's chat, a comment that mentions them and the Telegram message about it, as the notifier sends it. */
async function mentionedInTelegram(actions = true) {
  const { me, as, chatId } = await linked();
  if (actions) assert.equal((await setActions(as, true)).status, 204);
  await setPrefs(me.id, { ...NOTIFY_DEFAULTS, seen: false, quiet: null });
  const { id, root, now } = await mentionedInThread(me.id, true);
  await sendTelegramDue(api, ORIGIN, now, f.ws.workspaceId);
  const messageId = sent.findLastIndex((s) => s.chatId === chatId) + 1;
  assert.ok(messageId > 0, "the mention went to the chat");
  return { me, as, chatId, id, root, messageId };
}
const say = async (chatId: number, text: string | undefined, replyTo?: number) =>
  (await (
    await post({ message: { message_id: 9000, ...(text === undefined ? {} : { text }), chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "Ann" }, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) } })
  ).json()) as { text?: string; reply_parameters?: { message_id: number } };

test("a reply to a notification posts as the person's comment, in the thread it was about", async () => {
  const { me, chatId, id, root, messageId } = await mentionedInTelegram();
  const answer = await say(chatId, "Works for me, ship it", messageId);
  assert.match(answer.text!, new RegExp(`Posted to <code>${ISSUE_KEY}</code> as your comment`));
  assert.equal(answer.reply_parameters?.message_id, 9000, "the answer sits under the reply");
  const [c] = await db.select().from(comment).where(and(eq(comment.issueId, id), eq(comment.authorId, me.id)));
  assert.equal(c!.body, "Works for me, ship it");
  assert.equal(c!.parentId, root, "in the mention's thread");
});

test("a message that is no reply, or a reply to something else, posts nothing and says how", async () => {
  const { chatId, messageId } = await mentionedInTelegram();
  assert.match((await say(chatId, "hello")).text!, /reply to its notification/);
  assert.match((await say(chatId, "hello", messageId + 999)).text!, /not about an issue/);
  assert.match((await say(chatId, undefined, messageId)).text!, /Only text replies/);
  assert.equal((await say(424242, "hello", messageId)).text, undefined, "a chat nobody linked gets nothing");
});

test("a person who lost access to the workspace cannot comment from Telegram", async () => {
  const { me, chatId, id, messageId } = await mentionedInTelegram();
  await db.update(member).set({ role: "guest" }).where(and(eq(member.workspaceId, f.ws.workspaceId), eq(member.userId, me.id)));
  forgetRoles();
  assert.match((await say(chatId, "still here?", messageId)).text!, /no longer have access/);
  assert.deepEqual(await db.select().from(comment).where(and(eq(comment.issueId, id), eq(comment.authorId, me.id))), []);
});

test("after moving to another chat, a reply there to the same message number posts nothing", async () => {
  const { me, as, id, messageId } = await mentionedInTelegram();
  // Message ids are counted per chat: the new chat has its own message with this number.
  const link = (await (await as(`${server.url}/auth/telegram/link`, { method: "POST" })).json()) as TelegramLink;
  const other = ++chats;
  await start(other, `/start ${link.code}`);
  assert.equal((await setActions(as, true)).status, 204);
  assert.match((await say(other, "wrong place", messageId)).text!, /not about an issue/);
  assert.deepEqual(await db.select().from(comment).where(and(eq(comment.issueId, id), eq(comment.authorId, me.id))), []);
});

// ── Sign-in codes (PLNR-215) ─────────────────────────────────────────────────────────────────────────────────────────

/** Asks for a code, from the browser holding this device token if one is given (both cookie names: http or https). */
const askCode = (email: string, device?: string) =>
  fetch(`${server.url}/auth/code`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(device ? { cookie: `rsva_device=${device}; __Host-rsva_device=${device}` } : {}) },
    body: JSON.stringify({ email }),
  });
/** A browser this person has signed in from: its device token (auth/devices.ts). */
async function knownBrowser(userId: string): Promise<string> {
  const token = randomSecret();
  await db.insert(signInDevice).values({ userId, id: sha256(token) });
  return token;
}
const verify = (email: string, code: string) => fetch(`${server.url}/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
/** Waits for `check` to hold: codes go out after the answer to /auth/code. */
async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  return assert.fail(`never: ${what}`);
}
/** Makes the address's live code a minute old: a younger one is kept, not replaced, by a new request (RSVA-600). */
const aged = (email: string) => db.update(loginCode).set({ createdAt: new Date(Date.now() - 61_000).toISOString() }).where(eq(loginCode.email, email.toLowerCase()));
const codeMail = (email: string) => until(() => mails.findLast((m) => m.to === email && /recursiva code/.test(m.subject)), "the code mail");
const codeIn = (html: string) => /<code>(\d{6})<\/code>/.exec(html)![1]!;
const messagesTo = (chatId: number) => sent.flatMap((s, i) => (s.chatId === chatId ? [{ ...s, messageId: i + 1 }] : []));

test("a sign-in code goes to the linked chat too, and the message goes once the code is used", async () => {
  const { me, chatId } = await linked();
  const browser = await knownBrowser(me.id);
  const before = messagesTo(chatId).length;
  assert.equal((await askCode(me.email, browser)).status, 204);
  const mail = await codeMail(me.email);
  const msg = await until(() => messagesTo(chatId)[before], "the Telegram message");
  const code = codeIn(msg.html);
  assert.match(mail.text, new RegExp(`code: ${code}`), "the same code as the mail's");
  assert.deepEqual(msg.opts, { protect: true }, "rings in quiet hours, cannot be forwarded");
  assert.match(msg.html, /Your recursiva sign-in code/);
  assert.equal((await verify(me.email, code)).status, 200);
  assert.deepEqual(deleted.at(-1), { chatId, messageId: msg.messageId }, "a used code's message is deleted");
});

test("a new code deletes the last one's message; so does the fifth wrong guess", async () => {
  const { me, chatId } = await linked();
  const browser = await knownBrowser(me.id);
  await askCode(me.email, browser);
  const first = await until(() => messagesTo(chatId).find((m) => /sign-in code/.test(m.html)), "the first code");
  mails.length = 0;
  await aged(me.email);
  await askCode(me.email, browser);
  await codeMail(me.email);
  const second = await until(() => messagesTo(chatId).findLast((m) => m.messageId !== first.messageId && /sign-in code/.test(m.html)), "the second code");
  assert.ok(deleted.some((d) => d.chatId === chatId && d.messageId === first.messageId), "the replaced code's message is deleted");
  const wrong = codeIn(second.html) === "000000" ? "111111" : "000000";
  for (let i = 0; i < 4; i++) await verify(me.email, wrong);
  assert.equal(deleted.some((d) => d.messageId === second.messageId), false, "four wrong guesses leave the code alive");
  await verify(me.email, wrong);
  assert.ok(deleted.some((d) => d.chatId === chatId && d.messageId === second.messageId), "out of guesses: deleted");
});

test("no chat, or a chat that refuses: the mail alone; a refusal for good marks the chat", async () => {
  const lone = await addMember(f.ws.workspaceId, "member");
  const before = sent.length;
  await askCode(lone.email);
  await codeMail(lone.email);
  assert.equal(sent.length, before, "no chat linked, nothing sent");

  const { me, chatId } = await linked();
  const browser = await knownBrowser(me.id);
  await refusing(new TelegramError(403, "Forbidden: bot was blocked by the user"), async () => {
    await askCode(me.email, browser);
    await codeMail(me.email);
    const error = await until(async () => (await db.select().from(telegramChat).where(eq(telegramChat.userId, me.id)))[0]?.error ?? undefined, "the chat marked");
    assert.match(error, /blocked/);
  });
  // A chat marked as refusing is not tried again.
  mails.length = 0;
  await aged(me.email);
  const count = messagesTo(chatId).length;
  await askCode(me.email, browser);
  await codeMail(me.email);
  assert.equal(messagesTo(chatId).length, count);
});

test("past the daily cap the link goes by email only", async () => {
  const { me, chatId } = await linked();
  await db.insert(loginFailure).values(Array.from({ length: DAILY_FAILURES }, () => ({ email: me.email })));
  const count = messagesTo(chatId).length;
  await askCode(me.email, await knownBrowser(me.id));
  await until(() => mails.find((m) => m.to === me.email && /sign-in link/.test(m.subject)), "the link mail");
  assert.equal(messagesTo(chatId).length, count);
});

test("the message goes when the code expires, even if nobody uses it", async () => {
  const { me, chatId } = await linked();
  await codeToTelegram(api, me.id, me.email, "123456", new Date(Date.now() + 30));
  const msg = messagesTo(chatId).at(-1)!;
  await until(() => deleted.some((d) => d.messageId === msg.messageId), "the expired code's message deleted");
  dropTelegramCode(me.email);
  assert.equal(deleted.filter((d) => d.messageId === msg.messageId).length, 1, "deleted once");
});

// ── A code asked from a browser the account does not know (RSVA-464) ─────────────────────────────────────────────────

const notice = (chatId: number, after: number) => until(() => messagesTo(chatId).slice(after).find((m) => /new browser/.test(m.html)), "the new-browser notice");

test("a browser the account does not know: the code by email only, the chat a notice without it (RSVA-464)", async () => {
  const { me, chatId } = await linked();
  const someoneElse = await knownBrowser((await addMember(f.ws.workspaceId, "member")).id);
  // No device cookie; another person's known browser; a token nobody has (a forgotten browser's is swept so).
  for (const device of [undefined, someoneElse, randomSecret()]) {
    mails.length = 0;
    await aged(me.email);
    const before = messagesTo(chatId).length;
    assert.equal((await askCode(me.email, device)).status, 204, "the same answer");
    const code = /code: (\d{6})/.exec((await codeMail(me.email)).text)![1]!;
    const msg = await notice(chatId, before);
    assert.ok(!msg.html.includes(code) && !/<code>/.test(msg.html), "no code in the chat");
    assert.match(msg.html, /went to your email only/);
    assert.deepEqual(msg.opts, { buttons: [[{ text: "Not me", data: `nc:${me.id}` }]] }, "rings, with Not me");
    assert.equal(messagesTo(chatId).slice(before).filter((m) => /sign-in code/.test(m.html)).length, 0);
  }
  // The mail's code signs in, and the browser it gives a cookie to gets codes in the chat from then on.
  mails.length = 0;
  await aged(me.email);
  await askCode(me.email);
  const res = await verify(me.email, /code: (\d{6})/.exec((await codeMail(me.email)).text)![1]!);
  assert.equal(res.status, 200);
  const device = /rsva_device=([A-Za-z0-9_-]{43})/.exec(res.headers.getSetCookie().join("\n"))![1]!;
  const before = messagesTo(chatId).length;
  await askCode(me.email, device);
  await until(() => messagesTo(chatId).slice(before).find((m) => /sign-in code/.test(m.html)), "the code in the chat");
});

test("Not me under the notice voids the code; again, from another chat or for a newer code it voids nothing (RSVA-464)", async () => {
  const { me, chatId } = await linked();
  const theirs = await linked();
  const live = async () => (await db.select().from(loginCode).where(eq(loginCode.email, me.email.toLowerCase()))).length;
  const before = messagesTo(chatId).length;
  await askCode(me.email);
  await notice(chatId, before);
  assert.equal(await live(), 1);
  // Their chat names my account: not theirs to void.
  await pressNotMe(theirs.chatId, `nc:${me.id}`);
  assert.match(answered.at(-1)?.text ?? "", /not connected/);
  assert.equal(await live(), 1);
  // A code asked after the notice was drawn stays: it is the next try, maybe the person's own.
  await pressNotMe(chatId, `nc:${me.id}`, chatId, "private", Math.floor(Date.now() / 1000) - 60);
  assert.equal(await live(), 1);
  const res = await pressNotMe(chatId, `nc:${me.id}`);
  assert.equal(res.method, "editMessageText");
  assert.match(res.text ?? "", /no longer works/);
  assert.deepEqual(res.reply_markup?.inline_keyboard, []);
  assert.equal(await live(), 0);
  assert.equal((await verify(me.email, "123456")).status, 400);
  const again = await pressNotMe(chatId, `nc:${me.id}`);
  assert.match(again.text ?? "", /already does not work/);
  assert.equal((await pressNotMe(chatId, "nc:not-a-uuid")).method, undefined, "a forged id is not looked up");
});

test("a linked chat gets notifications only: a reply posts nothing, the test message says so (RSVA-496)", async () => {
  const { me, as, chatId, id, messageId } = await mentionedInTelegram(false);
  assert.match((await say(chatId, "Works for me", messageId)).text!, /notifications only/);
  assert.deepEqual(await db.select().from(comment).where(and(eq(comment.issueId, id), eq(comment.authorId, me.id))), []);
  assert.equal((await as(`${server.url}/auth/telegram/test`, { method: "POST" })).status, 204);
  assert.match(sent.at(-1)!.html, /Notifications only/);
});

test("Actions on needs a fresh sign-in and mails the account; off does not; Start again turns them off (RSVA-496)", async () => {
  const { me, as, chatId } = await linked();
  const stale = fetchAs(await agedSession(await asUser(me.id)));
  const refused = await setActions(stale, true);
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { error: string }).error, "reauth_required");
  const actionsOf = async () => (await db.select({ a: telegramChat.actions }).from(telegramChat).where(eq(telegramChat.userId, me.id)))[0]!.a;
  assert.equal(await actionsOf(), false);

  assert.equal((await setActions(as, true)).status, 204);
  assert.equal(await actionsOf(), true);
  assert.equal(((await (await as(`${server.url}/auth/notifications`)).json()) as { telegram: TelegramView }).telegram.chat?.actions, true);
  // Turned on again while on: no second notice.
  assert.equal((await setActions(as, true)).status, 204);
  assert.deepEqual(mails.filter((m) => m.to === me.email).map((m) => m.subject), ["Telegram was connected to your recursiva account", "Telegram can now act for your recursiva account"]);

  assert.equal((await setActions(stale, false)).status, 204, "off from any session");
  assert.equal(await actionsOf(), false);
  assert.equal((await setActions(as, true)).status, 204);
  const link = (await (await as(`${server.url}/auth/telegram/link`, { method: "POST" })).json()) as TelegramLink;
  await start(chatId, `/start ${link.code}`);
  assert.equal(await actionsOf(), false, "linked again, it starts with notifications only");
  assert.equal((await setActions(as, "yes" as unknown as boolean)).status, 400);
});
