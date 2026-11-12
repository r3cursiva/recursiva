import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTIFY_DEFAULTS } from "@rsva/protocol";
import { eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { TelegramError } from "../telegram/api.ts";
import { fakeTelegram } from "../telegram/fake.ts";
import { addMember } from "../test/helpers.ts";
import { collect, notifyFixture } from "./fixture.ts";
import { sendMornings } from "./morning.ts";

const { accountSettings, telegramChat } = schema;
const ORIGIN = "https://plan.example.test";
const log = { error: (e: unknown) => assert.fail(String(e)) };

const { f, newIssue, person, newCycle } = notifyFixture();
const { api, sent, refusing } = fakeTelegram();


test("due today and the cycles of the day set to Instantly: one mail at the digest time, once a day", async () => {
  const me = await person({ rules: { due: { email: "now" } } });
  const other = await addMember(f.ws.workspaceId, "member");
  await newIssue(f.ws.ownerId, { title: "Renew the certificate", assigneeIds: [me.id], dueDate: "2026-11-10" });
  await newIssue(f.ws.ownerId, { title: "Not yet", assigneeIds: [me.id], dueDate: "2026-11-11" });
  const done = f.refs.states.find((s) => s.group === "completed")!;
  await newIssue(f.ws.ownerId, { title: "Already done", assigneeIds: [me.id], dueDate: "2026-11-10", stateId: done.id });
  const starts = await newCycle({ leadId: me.id, startDate: "2026-11-10", endDate: "2026-11-23" });
  const ends = await newCycle({ leadId: me.id, startDate: "2026-10-27", endDate: "2026-11-10" });
  const notMine = await newCycle({ leadId: other.id, startDate: "2026-11-10", endDate: "2026-11-23" });
  const completed = await newCycle({ leadId: me.id, startDate: "2026-10-27", endDate: "2026-11-10", completedAt: "2026-11-09T18:00:00Z" });

  const { mails, mailer } = collect();
  const mine = () => mails.filter((m) => m.to === me.email);
  await sendMornings(mailer, ORIGIN, log, null, new Date("2026-11-10T07:59:00Z"));
  assert.equal(mine().length, 0, "not before the digest time");
  await sendMornings(mailer, ORIGIN, log, null, new Date("2026-11-10T08:00:00Z"));
  assert.equal(mine().length, 1);
  const m = mine()[0]!;
  assert.equal(m.subject, "Tuesday, Nov 10: 1 issue due today, 2 cycles starting or ending");
  assert.match(m.text, /Due today\n- \S+ Renew the certificate\n/);
  assert.doesNotMatch(m.text, /Not yet|Already done/);
  assert.match(m.text, new RegExp(`- ${starts} Sprint \\d+ \\(Starts today, ends Nov 23\\)\n  ${ORIGIN}/${f.ws.slug}/projects/${f.refs.project.key}/cycles/\\d+`));
  assert.match(m.text, new RegExp(`- ${ends} Sprint \\d+ \\(Ends today\\)`));
  assert.ok(!m.text.includes(`${notMine} `) && !m.text.includes(`${completed} `), "only cycles the person leads and not completed");
  assert.match(m.headers!["List-Unsubscribe"]!, /\/notify\/unsubscribe\?u=/);

  await sendMornings(mailer, ORIGIN, log, null, new Date("2026-11-10T15:00:00Z"));
  assert.equal(mine().length, 1, "once a day");
});

test("Telegram set to Instantly gets one message; a chat that refuses for good is marked and its part goes by email", async () => {
  const me = await person({ rules: { due: { telegram: "now" } } });
  const chatId = 700_000_000 + Math.floor(Math.random() * 1_000_000);
  await db.insert(telegramChat).values({ userId: me.id, chatId, name: "Ann" });
  await newIssue(f.ws.ownerId, { title: "Call the registrar", assigneeIds: [me.id], dueDate: "2026-11-13" });

  const { mails, mailer } = collect();
  await sendMornings(mailer, ORIGIN, log, api, new Date("2026-11-13T09:00:00Z"));
  const msg = sent.filter((s) => s.chatId === chatId);
  assert.equal(msg.length, 1);
  assert.match(msg[0]!.html, /^<b>Due today<\/b>\n<code>\S+<\/code> <a href="[^"]+\/browse\/\S+">Call the registrar<\/a>$/);
  assert.equal(mails.filter((m) => m.to === me.email).length, 0, "email stays Digest");

  // The next day the person has blocked the bot.
  await newIssue(f.ws.ownerId, { title: "Sign the lease", assigneeIds: [me.id], dueDate: "2026-11-14" });
  await refusing(new TelegramError(403, "Forbidden: bot was blocked by the user"), () => sendMornings(mailer, ORIGIN, log, api, new Date("2026-11-14T09:00:00Z")));
  const [chat] = await db.select({ error: telegramChat.error }).from(telegramChat).where(eq(telegramChat.userId, me.id));
  assert.equal(chat!.error, "Bot blocked");
  const mine = mails.filter((m) => m.to === me.email);
  assert.equal(mine.length, 1);
  assert.match(mine[0]!.text, /Due today\n- \S+ Sign the lease/);
});

test("a workspace on Only about me, or a person met for the first time, gets no morning notice", async () => {
  const me = await person({ rules: { due: { email: "now" } }, workspaces: { [f.ws.workspaceId]: "me" } });
  const fresh = await addMember(f.ws.workspaceId, "member");
  await db.insert(accountSettings).values({ userId: fresh.id, timeZone: "UTC", notifications: { ...NOTIFY_DEFAULTS, rules: { due: { email: "now" } } } });
  await newIssue(f.ws.ownerId, { title: "Rotate the keys", assigneeIds: [me.id, fresh.id], dueDate: "2026-11-15" });
  const { mails, mailer } = collect();
  await sendMornings(mailer, ORIGIN, log, null, new Date("2026-11-15T08:30:00Z"));
  assert.equal(mails.filter((m) => m.to === me.email).length, 0);
  assert.equal(mails.filter((m) => m.to === fresh.email).length, 0, "first meeting: today counts as sent");
});
