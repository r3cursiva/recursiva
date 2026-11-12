import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { guardConfig } from "../guard.ts";
import { delay, startServer } from "../test/helpers.ts";
import { TelegramError } from "./api.ts";
import { fakeTelegram } from "./fake.ts";
import { WaitlistNotifier, waitlistMessage } from "./waitlist.ts";

const { telegramChat, user } = schema;
const LANDING = "https://rsva.dev";
const quiet = { error: () => {} };
const keep = process.env.RSVA_WORKSPACE_CREATORS;
afterEach(() => {
  if (keep === undefined) delete process.env.RSVA_WORKSPACE_CREATORS;
  else process.env.RSVA_WORKSPACE_CREATORS = keep;
});

/** A person with a linked chat; listed as a creator when `creator`. */
async function personWithChat(creator: boolean, chat: Partial<typeof telegramChat.$inferInsert> = {}) {
  const email = `${creator ? "creator" : "member"}-${randomUUID().slice(0, 8)}@example.test`;
  const [u] = await db.insert(user).values({ email, name: "Ann", kind: "human" }).returning({ id: user.id });
  const chatId = randomInt(1, 2 ** 40);
  await db.insert(telegramChat).values({ userId: u!.id, chatId, name: "Ann", ...chat });
  if (creator) process.env.RSVA_WORKSPACE_CREATORS = [process.env.RSVA_WORKSPACE_CREATORS, email].filter(Boolean).join(",");
  return { id: u!.id, chatId };
}
const address = () => `asks-${randomUUID().slice(0, 8)}@example.test`;

test("the message names each new address with its note and how many wait", () => {
  const one = waitlistMessage([{ email: "a@x.test", note: "boats & <sails>" }], 12);
  assert.equal(one, "<b>Waitlist · 12 waiting</b>\n<code>a@x.test</code> — boats &amp; &lt;sails&gt;");
  const two = waitlistMessage([{ email: "a@x.test", note: "" }, { email: "b@x.test", note: "shop" }], 13);
  assert.match(two, /^<b>Waitlist · 2 new · 13 waiting<\/b>\n<code>a@x.test<\/code>\n<code>b@x.test<\/code> — shop$/);
});

test("new requests go to the listed creators' chats, at most one message a window; muted chats get it silently", async () => {
  const tg = fakeTelegram();
  const creator = await personWithChat(true);
  const muted = await personWithChat(true, { mutedUntil: new Date(Date.now() + 3_600_000).toISOString() });
  const member = await personWithChat(false);
  const n = new WaitlistNotifier(tg.api, quiet, 300);
  const [a, b, c] = [address(), address(), address()];

  n.add({ email: a, note: "first" });
  await delay(20);
  await n.sending;
  const first = tg.sent.filter((m) => m.html.includes(a));
  assert.deepEqual(first.map((m) => m.chatId).toSorted(), [creator.chatId, muted.chatId].toSorted(), "creators only, not other members");
  assert.equal(first.find((m) => m.chatId === muted.chatId)?.opts.silent, true);
  assert.equal(first.find((m) => m.chatId === creator.chatId)?.opts.silent, false);
  assert.equal(tg.sent.some((m) => m.chatId === member.chatId), false);

  // Within the window: gathered, not sent yet; then one message with both.
  n.add({ email: b, note: "" });
  n.add({ email: c, note: "third" });
  await delay(50);
  assert.equal(tg.sent.some((m) => m.html.includes(b)), false);
  await delay(350);
  await n.sending;
  const both = tg.sent.filter((m) => m.chatId === creator.chatId && m.html.includes(b));
  assert.equal(both.length, 1);
  assert.match(both[0]!.html, new RegExp(`2 new[\\s\\S]*${b}[\\s\\S]*${c}`));
  n.stop();
});

test("a chat Telegram refuses for good is marked, as for any notification", async () => {
  const tg = fakeTelegram();
  const creator = await personWithChat(true);
  const n = new WaitlistNotifier(tg.api, quiet, 300);
  await tg.refusing(new TelegramError(403, "Forbidden: bot was blocked by the user"), async () => {
    n.add({ email: address(), note: "" });
    await delay(20);
    await n.sending;
  });
  const [row] = await db.select({ error: telegramChat.error }).from(telegramChat).where(eq(telegramChat.userId, creator.id));
  assert.equal(row?.error, "Bot blocked");
  n.stop();
});

let server: Awaited<ReturnType<typeof startServer>>;
const tg = fakeTelegram();
before(async () => {
  server = await startServer({ telegram: { api: tg.api, secret: "s" }, guard: guardConfig({ RSVA_WAITLIST_ORIGINS: LANDING }) });
});
after(() => server.close());

test("a request from the landing reaches the creator's chat once; asking again sends nothing", async () => {
  const creator = await personWithChat(true);
  const email = address();
  const ask = () => fetch(`${server.url}/api/waitlist`, { method: "POST", headers: { "content-type": "application/json", origin: LANDING }, body: JSON.stringify({ email, note: "we build boats" }) });
  assert.equal((await ask()).status, 204);
  for (let i = 0; i < 50 && !tg.sent.some((m) => m.html.includes(email)); i++) await delay(10);
  assert.equal(tg.sent.filter((m) => m.chatId === creator.chatId && m.html.includes(email)).length, 1);
  assert.match(tg.sent.find((m) => m.html.includes(email))!.html, /we build boats/);
  assert.equal((await ask()).status, 204);
  await delay(100);
  assert.equal(tg.sent.filter((m) => m.html.includes(email)).length, 1, "the same address again: nothing new to tell");
});
