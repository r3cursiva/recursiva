import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { NOTIFY_DEFAULTS, type Op, type TelegramGroupLink, type TelegramView } from "@rsva/protocol";
import { ISSUE_KEY } from "@rsva/schema/models";
import { and, eq } from "drizzle-orm";
import { forgetRoles } from "../auth/access.ts";
import type { Mail } from "../auth/mail.ts";
import { db, schema } from "../db.ts";
import { follow as followAll } from "../notify/follow.ts";
import { notifyFixture, setPrefs } from "../notify/fixture.ts";
import { sendGroupCycles } from "../notify/morning.ts";
import { sendDue } from "../notify/send.ts";
import { sendGroupsDue, sendTelegramDue } from "../notify/telegram.ts";
import { addMember, agedSession, asUser, fetchAs, startServer, tenThenLimited } from "../test/helpers.ts";
import { TelegramError, webhookSecret } from "./api.ts";
import { fakeTelegram } from "./fake.ts";

const { notifyOutbox, telegramGroup, telegramGroupCode, telegramChat, member } = schema;
const ORIGIN = "https://plan.example.test";
const SECRET = webhookSecret("123:test");
const { api, sent, left, refusing } = fakeTelegram();
const notices: Mail[] = [];

const { f, tx, newIssue, newCycle } = notifyFixture();
let server: Awaited<ReturnType<typeof startServer>>;
before(async () => void (server = await startServer({ telegram: { api, secret: SECRET }, mailer: async (m) => void notices.push(m) })));
after(() => server.close());

const post = (body: unknown) => fetch(`${server.url}/api/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify(body) });
const inGroup = async (chatId: number, text: string, title = "Ops alerts") =>
  (await (await post({ message: { message_id: 7, text, chat: { id: chatId, type: "group", title }, from: { id: 5, is_bot: false, first_name: "Ann" } } })).json()) as { text?: string; chat_id?: number };
const json = <T>(r: Response) => r.json() as Promise<T>;
const follow = (now = new Date()) => followAll(f.ws.workspaceId, now, true);
let chats = -1000;
const started = () => f.refs.states.filter((s) => s.group === "started");

/** A member who links a new group through the page's flow: a code, the code in the group, the page's wait answered. */
async function linkedGroup(role = "member", send = (chatId: number, code: string) => inGroup(chatId, `/start@plnr_test_bot ${code}`)) {
  const me = await addMember(f.ws.workspaceId, role);
  const headers = await asUser(me.id);
  const as = fetchAs(headers);
  const link = await json<TelegramGroupLink>(await askCode(as));
  const chatId = --chats;
  const waited = as(`${server.url}/auth/telegram/groups/wait`).then((r) => json<TelegramView>(r));
  const answer = await send(chatId, link.code);
  const view = await waited;
  const group = view.groups.find((g) => g.linkedByMe && Date.parse(g.linkedAt) >= Date.parse(link.createdAt))!;
  const patch = (body: unknown, by = as) => by(`${server.url}/auth/telegram/groups/${group.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { me, headers, as, link, chatId, answer, view, group, patch };
}

const askCode = (as: ReturnType<typeof fetchAs>) =>
  as(`${server.url}/auth/telegram/groups/link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: f.ws.workspaceId }) });

/** The workspace's only group, given its first project and both events: the groups of earlier tests would get its events too. */
async function deliveringGroup() {
  await db.delete(telegramGroup).where(eq(telegramGroup.workspaceId, f.ws.workspaceId));
  const g = await linkedGroup();
  assert.equal((await g.patch({ projectIds: [f.refs.project.id], events: ["urgent", "plan"] })).status, 204);
  return g;
}
const toGroup = (chatId: number) => sent.filter((s) => s.chatId === chatId);

test("a group code: the startgroup link and the /link command, ten minutes", async () => {
  const { link } = await linkedGroup();
  assert.match(link.url, /^https:\/\/t\.me\/plnr_test_bot\?startgroup=[2-9a-zA-Z]{10}$/);
  assert.equal(link.command, `/link@plnr_test_bot ${link.code}`);
  assert.ok(Date.parse(link.expiresAt) - Date.now() > 9 * 60_000);
});

test("the code in the group links it with nothing picked, says so there, and wakes the waiting page", async () => {
  const { chatId, answer, group } = await linkedGroup();
  assert.equal(answer.chat_id, chatId);
  assert.match(answer.text!, /recursiva is connected/);
  assert.deepEqual({ ...group, id: "", linkedAt: "", linkedBy: "" }, { id: "", workspaceId: f.ws.workspaceId, title: "Ops alerts", members: 4, linkedBy: "", linkedByMe: true, linkedAt: "", projectIds: [], events: [], error: null, errorAt: null });
});

test("/link works too; a used code, another bot's command or no code links nothing", async () => {
  const { link, chatId, group } = await linkedGroup("member", (id, code) => inGroup(id, `/link ${code}`));
  assert.ok(group, "linked by /link");
  assert.match((await inGroup(chatId - 500, `/link ${link.code}`)).text!, /expired or was already used/);
  assert.deepEqual(await inGroup(chatId - 501, `/link@other_bot ${link.code}`), {}, "not ours");
  assert.match((await inGroup(chatId - 502, "/link")).text!, /Add a group chat/);
  assert.deepEqual(await inGroup(chatId - 503, "hello all"), {}, "talk in the group is not for the bot");
});

test("a group code and a wider group need a fresh sign-in; narrowing does not (PLNR-246)", async () => {
  const old = await addMember(f.ws.workspaceId, "member");
  const refused = await askCode(fetchAs(await agedSession(await asUser(old.id))));
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { error: string }).error, "reauth_required");
  assert.deepEqual(await db.select().from(telegramGroupCode).where(eq(telegramGroupCode.userId, old.id)), [], "no code was made");

  // Linked and set up from a fresh session, as after "Confirm it's you"; then the cookie grows old.
  const { headers, group, patch } = await linkedGroup();
  assert.equal((await patch({ projectIds: [f.refs.project.id], events: ["urgent", "plan"] })).status, 204, "a fresh session widens");
  await agedSession(headers);
  const read = async () => (await db.select().from(telegramGroup).where(eq(telegramGroup.id, group.id)))[0]!;
  for (const body of [{ events: ["urgent", "plan", "cycle"] }, { projectIds: [f.refs.project.id, f.refs.other.id] }, { projectIds: [f.refs.other.id], events: ["urgent"] }]) {
    const res = await patch(body);
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.equal(((await res.json()) as { error: string }).error, "reauth_required");
  }
  assert.deepEqual((await read()).events, ["urgent", "plan"], "nothing was widened");
  assert.equal((await patch({ events: ["plan"] })).status, 204, "an old session may narrow");
  assert.equal((await patch({ projectIds: [], events: ["urgent", "plan", "cycle"] })).status, 204, "more events of no project reach nothing more");
  assert.deepEqual([(await read()).projectIds, (await read()).events], [[], ["urgent", "plan", "cycle"]]);
  const admin = fetchAs(await agedSession(await asUser((await addMember(f.ws.workspaceId, "admin")).id)));
  assert.equal((await patch({ projectIds: [f.refs.project.id] }, admin)).status, 403, "an admin's old session widens no one's group");
});

test("a linked group is mailed to its linker, naming the group and the workspace (PLNR-246)", async () => {
  const { me } = await linkedGroup("member", (id, code) => inGroup(id, `/link ${code}`, "Night shift"));
  const [ws] = await db.select({ name: schema.workspace.name }).from(schema.workspace).where(eq(schema.workspace.id, f.ws.workspaceId));
  const mine = notices.filter((m) => m.to === me.email);
  assert.deepEqual(mine.map((m) => m.subject), [`A Telegram group was linked to "${ws!.name}"`]);
  assert.ok(mine[0]!.text.startsWith(`The Telegram group "Night shift" was linked to "${ws!.name}" from your recursiva account`), mine[0]!.text);
  assert.match(mine[0]!.text, /remove the group in Settings › Notifications › Telegram, sign out your other devices in Settings › Security/);
});

test("ten group links a person may ask for in an hour; the last one under the limit still links and is mailed (RSVA-249)", async () => {
  const me = await addMember(f.ws.workspaceId, "member");
  const as = fetchAs(await asUser(me.id));
  const link = await json<TelegramGroupLink>(await tenThenLimited(() => askCode(as)));

  // The code in the group is never limited: the group is linked and its linker hears of it, once.
  await inGroup(--chats, `/start@plnr_test_bot ${link.code}`);
  assert.equal((await db.select().from(telegramGroup).where(eq(telegramGroup.linkedBy, me.id))).length, 1);
  assert.equal(notices.filter((m) => m.to === me.email).length, 1);
});

test("only its linker or an admin changes a group; projects must be the workspace's", async () => {
  const { patch } = await linkedGroup();
  const other = fetchAs(await asUser((await addMember(f.ws.workspaceId, "member")).id));
  assert.equal((await patch({ events: ["plan"] }, other)).status, 404);
  const admin = fetchAs(await asUser((await addMember(f.ws.workspaceId, "admin")).id));
  assert.equal((await patch({ events: ["plan"] }, admin)).status, 204);
  assert.equal((await patch({ projectIds: [randomUUID()] })).status, 400);
  assert.equal((await patch({ events: ["stuck"] })).status, 400, "no such event yet");
});

test("an urgent issue, a priority raised to urgent and an agent's plan reach the group; other projects do not", async () => {
  const { chatId } = await deliveringGroup();
  const created = await newIssue(f.ws.ownerId, { priority: 1 });
  const raised = await newIssue(f.ws.ownerId, { priority: 3 });
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id: raised, set: { priority: 1 } }]);
  const plan = await newIssue(f.ws.ownerId);
  await tx(f.ws.agentId, [{ op: "update", m: "Issue", id: plan, set: { stateId: started()[1]!.id } }]);
  const human = await newIssue(f.ws.ownerId);
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id: human, set: { stateId: started()[1]!.id } }]);
  await tx(f.ws.ownerId, [{ op: "create", m: "Issue", id: randomUUID(), projectId: f.refs.other.id, set: { title: "Elsewhere", stateId: f.refs.otherStates[0]!.id, priority: 1 } } as Op]);
  const now = new Date();
  await follow(now);
  await sendGroupsDue(api, ORIGIN, now, f.ws.workspaceId);
  const lines = toGroup(chatId).map((s) => s.html.split("\n")[0]!.replace(new RegExp(`<code>${ISSUE_KEY}</code> · `), ""));
  assert.deepEqual(lines, ["New urgent issue", "Raised to urgent", "Plan waiting for approval"], "at once, in order; a person's review and another project are not the group's");
  const { number } = (await db.select({ number: schema.issue.number }).from(schema.issue).where(eq(schema.issue.id, created)))[0]!;
  const key = `${f.refs.project.key}-${number}`;
  assert.match(toGroup(chatId)[0]!.html, new RegExp(`<b>.+ created ${key} as urgent</b>\\n<a href="https://plan\\.example\\.test/[^"]+/browse/${key}">Rotate the edge nodes</a>`), "the created issue's own key");
  assert.equal(toGroup(chatId)[0]!.opts.silent, undefined, "a group has no quiet hours");
});

test("an event the group was not given, or a group whose linker lost access, gets nothing", async () => {
  const { me, chatId, patch } = await deliveringGroup();
  await patch({ events: ["plan"] });
  await newIssue(f.ws.ownerId, { priority: 1 });
  const now = new Date();
  await follow(now);
  await sendGroupsDue(api, ORIGIN, now, f.ws.workspaceId);
  assert.equal(toGroup(chatId).length, 0, "urgent is not this group's");

  await patch({ events: ["urgent"] });
  await newIssue(f.ws.ownerId, { priority: 1 });
  await follow(now);
  await db.update(member).set({ role: "guest" }).where(and(eq(member.workspaceId, f.ws.workspaceId), eq(member.userId, me.id)));
  forgetRoles();
  await sendGroupsDue(api, ORIGIN, now, f.ws.workspaceId);
  assert.equal(toGroup(chatId).length, 0, "the group reads only what its linker may");
});

test("removed from the group, the bot marks it; linked again, it keeps what it was given", async () => {
  const { as, link, chatId, group } = await deliveringGroup();
  await post({ my_chat_member: { chat: { id: chatId, type: "group" }, new_chat_member: { status: "kicked" } } });
  const [marked] = await db.select().from(telegramGroup).where(eq(telegramGroup.id, group.id));
  assert.equal(marked!.error, "Bot removed");
  await newIssue(f.ws.ownerId, { priority: 1 });
  await follow();
  assert.deepEqual(await db.select().from(notifyOutbox).where(eq(notifyOutbox.groupId, group.id)), [], "no rows for a group that stopped");

  const again = await json<TelegramGroupLink>(await askCode(as));
  assert.notEqual(again.code, link.code);
  await inGroup(chatId, `/start ${again.code}`);
  const [back] = await db.select().from(telegramGroup).where(eq(telegramGroup.id, group.id));
  assert.equal(back!.error, null);
  assert.deepEqual(back!.events, ["urgent", "plan"]);
});

test("another member who links a set-up group takes it over with nothing picked; an admin keeps what it had", async () => {
  const { chatId, group } = await deliveringGroup();
  const codeOf = async (role: string) => {
    const as = fetchAs(await asUser((await addMember(f.ws.workspaceId, role)).id));
    return (await json<TelegramGroupLink>(await askCode(as))).code;
  };
  const read = async () => (await db.select().from(telegramGroup).where(eq(telegramGroup.id, group.id)))[0]!;
  await inGroup(chatId, `/link ${await codeOf("admin")}`);
  assert.deepEqual((await read()).events, ["urgent", "plan"], "an admin keeps its projects and events");
  await inGroup(chatId, `/link ${await codeOf("member")}`);
  const taken = await read();
  assert.deepEqual([taken.projectIds, taken.events], [[], []], "a member starts from nothing");
});

test("a group that became a supergroup is followed to its new id", async () => {
  const { chatId, group } = await deliveringGroup();
  await newIssue(f.ws.ownerId, { priority: 1 });
  const now = new Date();
  await follow(now);
  const moved = chatId - 1_000_000;
  await refusing(new TelegramError(400, "Bad Request: group chat was upgraded to a supergroup chat", { migrate_to_chat_id: moved }), () => sendGroupsDue(api, ORIGIN, now, f.ws.workspaceId), true);
  assert.equal(toGroup(moved).length, 1, "sent to the supergroup");
  const [row] = await db.select().from(telegramGroup).where(eq(telegramGroup.id, group.id));
  assert.equal(row!.chatId, moved);
  // The service message in the old group says the same.
  const other = await linkedGroup();
  await post({ message: { message_id: 8, chat: { id: other.chatId, type: "group" }, migrate_to_chat_id: other.chatId - 5, from: { id: 5, first_name: "Ann" } } });
  const [followed] = await db.select().from(telegramGroup).where(eq(telegramGroup.id, other.group.id));
  assert.equal(followed!.chatId, other.chatId - 5);
});

test("a 429 holds the group for its retry_after without spending a try (RSVA-212)", async () => {
  const { chatId, group } = await deliveringGroup();
  await newIssue(f.ws.ownerId, { priority: 1 });
  await newIssue(f.ws.ownerId, { priority: 1 });
  const now = new Date();
  await follow(now);
  await refusing(new TelegramError(429, "Too Many Requests: retry after 7", { retry_after: 7 }), () => sendGroupsDue(api, ORIGIN, now, f.ws.workspaceId), true);
  assert.equal(toGroup(chatId).length, 0, "the second is not sent to a group that asked to wait");
  const rows = await db.select().from(notifyOutbox).where(eq(notifyOutbox.groupId, group.id));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.status, Date.parse(r.dueAt), r.attempts]),
    rows.map(() => ["pending", now.getTime() + 7000, 0]),
  );
  await sendGroupsDue(api, ORIGIN, new Date(now.getTime() + 7000), f.ws.workspaceId);
  assert.equal(toGroup(chatId).length, 2, "both go once the wait is over");
});

test("Remove: the group is gone with what was on its way, and the bot leaves it", async () => {
  const { as, chatId, group } = await deliveringGroup();
  await newIssue(f.ws.ownerId, { priority: 1 });
  await follow();
  assert.equal((await as(`${server.url}/auth/telegram/groups/${group.id}`, { method: "DELETE" })).status, 204);
  assert.deepEqual(await db.select().from(telegramGroup).where(eq(telegramGroup.id, group.id)), []);
  assert.deepEqual(await db.select().from(notifyOutbox).where(eq(notifyOutbox.groupId, group.id)), []);
  assert.ok(left.includes(chatId));
});

// ── Cycle starts or ends (PLNR-253) ───────────────────────────────────────────────────────────────────────────────

const log = { error: (e: unknown) => assert.fail(String(e)) };
/** The cycles pass at that moment, for this file's workspace only. */
const cyclesAt = (iso: string) => sendGroupCycles(api, ORIGIN, log, new Date(iso), f.ws.workspaceId);

/** The workspace's only group, given its first project and the cycles; its linker's zone is Bangkok (UTC+7). */
async function cyclesGroup(timeZone: string | null = "Asia/Bangkok") {
  const g = await deliveringGroup();
  assert.equal((await g.patch({ events: ["cycle"] })).status, 204);
  await setPrefs(g.me.id, NOTIFY_DEFAULTS, timeZone);
  return g;
}

test("Cycle starts or ends: the cycles of the group's projects on their first and last day, once, at 09:00 its linker's time", async () => {
  const { chatId } = await cyclesGroup();
  const starts = await newCycle({ startDate: "2026-12-01", endDate: "2026-12-14" });
  const ends = await newCycle({ startDate: "2026-11-17", endDate: "2026-12-01" });
  const later = await newCycle({ startDate: "2026-12-02", endDate: "2026-12-15" });
  const completed = await newCycle({ startDate: "2026-11-17", endDate: "2026-12-01", completedAt: "2026-11-30T18:00:00Z" });
  const elsewhere = await newCycle({ projectId: f.refs.other.id, startDate: "2026-12-01", endDate: "2026-12-14" });

  // 08:59 and 09:00 in Bangkok on Dec 1.
  assert.equal(await cyclesAt("2026-12-01T01:59:00Z"), 0, "not before 09:00 in the linker's zone");
  assert.equal(await cyclesAt("2026-12-01T02:00:00Z"), 1);
  const msg = toGroup(chatId);
  assert.equal(msg.length, 1);
  const [head, ...lines] = msg[0]!.html.split("\n");
  assert.equal(head, "<b>Cycles</b>");
  const line = (key: string) => lines.find((l) => l.startsWith(`<code>${key}</code> `));
  assert.match(line(starts)!, new RegExp(`<a href="${ORIGIN}/${f.ws.slug}/projects/${f.refs.project.key}/cycles/\\d+">Sprint \\d+</a> · Starts today, ends Dec 14$`));
  assert.match(line(ends)!, / · Ends today$/);
  assert.equal(lines.length, 2, `only the group's project, not completed, on the day: not ${[later, completed, elsewhere].join(", ")}`);
  assert.equal(msg[0]!.opts.silent, undefined, "a group has no quiet hours");

  assert.equal(await cyclesAt("2026-12-01T10:00:00Z"), 0, "once a day");
  assert.equal(await cyclesAt("2026-12-01T17:30:00Z"), 0, "Dec 2 in Bangkok, before 09:00");
  assert.equal(await cyclesAt("2026-12-03T02:00:00Z"), 0, "a day without cycles sends nothing");
  assert.equal(toGroup(chatId).length, 1);
});

test("Cycle starts or ends: a group not given it, whose linker has no zone or lost access, or that stopped, gets nothing", async () => {
  await newCycle({ startDate: "2026-12-05", endDate: "2026-12-18" });
  const urgentOnly = await deliveringGroup();
  await setPrefs(urgentOnly.me.id, NOTIFY_DEFAULTS, "UTC");
  assert.equal(await cyclesAt("2026-12-05T09:00:00Z"), 0, "the event is not this group's");

  await cyclesGroup(null);
  assert.equal(await cyclesAt("2026-12-05T09:00:00Z"), 0, "a linker without a zone has no morning yet");

  const { me } = await cyclesGroup("UTC");
  await db.update(member).set({ role: "guest" }).where(and(eq(member.workspaceId, f.ws.workspaceId), eq(member.userId, me.id)));
  assert.equal(await cyclesAt("2026-12-05T09:00:00Z"), 0, "the group reads only what its linker may");

  const { chatId, group } = await cyclesGroup("UTC");
  await refusing(new TelegramError(403, "Forbidden: bot was kicked from the group chat"), () => cyclesAt("2026-12-05T09:00:00Z"));
  const [row] = await db.select().from(telegramGroup).where(eq(telegramGroup.id, group.id));
  assert.equal(row!.error, "Bot removed", "a group that refuses is marked");
  assert.equal(toGroup(chatId).length, 0);
});

// ── The personal chat stops (NotifTgError) ───────────────────────────────────────────────────────────────────────────

test("a blocked bot: what was set to Telegram goes by email, counted on the page; unblocked, Telegram again", async () => {
  const me = await addMember(f.ws.workspaceId, "member");
  const as = fetchAs(await asUser(me.id));
  const chatId = 777_000 + Math.floor(Math.random() * 1000);
  await db.insert(telegramChat).values({ userId: me.id, chatId, name: "Ann" });
  // A mention: Telegram at once, email off.
  await setPrefs(me.id, { ...NOTIFY_DEFAULTS, seen: false, quiet: null, rules: { mention: { email: "off", telegram: "now" } } });
  const mention = async () => {
    const id = await newIssue(f.ws.ownerId);
    await tx(f.ws.ownerId, [{ op: "create", m: "Comment", id: randomUUID(), set: { issueId: id, body: `Look [@x](mention:${me.id})` } }]);
    return id;
  };
  const mails: Mail[] = [];
  const mailer = async (m: Mail) => void mails.push(m);
  const now = new Date();

  // Refused while sending: that message is mailed in its place.
  const first = await mention();
  await follow(now);
  await refusing(new TelegramError(403, "Forbidden: bot was blocked by the user"), () => sendTelegramDue(api, ORIGIN, now, f.ws.workspaceId));
  const [chat] = await db.select().from(telegramChat).where(eq(telegramChat.userId, me.id));
  assert.equal(chat!.error, "Bot blocked");
  // Blocked since: the next is written as an email straight away.
  const second = await mention();
  await follow(now);
  const rows = await db.select().from(notifyOutbox).where(and(eq(notifyOutbox.userId, me.id), eq(notifyOutbox.issueId, second)));
  assert.deepEqual(rows.map((r) => [r.channel, r.fallback]), [["email", true]]);
  await sendDue(mailer, ORIGIN, now, f.ws.workspaceId);
  assert.equal(mails.filter((m) => m.to === me.email).length, 2, "both by email");
  assert.match(mails.at(-1)!.text, /Telegram stopped delivering to your chat/);
  const view = await json<{ telegram: TelegramView }>(await as(`${server.url}/auth/notifications`));
  assert.equal(view.telegram.chat!.fallbacks, 2);
  assert.ok(view.telegram.chat!.errorAt);
  assert.ok(first);

  await post({ my_chat_member: { chat: { id: chatId, type: "private" }, new_chat_member: { status: "member" } } });
  const [healed] = await db.select().from(telegramChat).where(eq(telegramChat.userId, me.id));
  assert.equal(healed!.error, null, "unblocking the bot heals the chat");
  await post({ my_chat_member: { chat: { id: chatId, type: "private" }, new_chat_member: { status: "kicked" } } });
  const [blocked] = await db.select().from(telegramChat).where(eq(telegramChat.userId, me.id));
  assert.equal(blocked!.error, "Bot blocked", "blocking is known at once, not at the next message");
});

test("a group's message carries Open alone, no Snooze (PLNR-361)", async () => {
  const { chatId } = await deliveringGroup();
  await newIssue(f.ws.ownerId, { priority: 1 });
  const now = new Date();
  await follow(now);
  await sendGroupsDue(api, ORIGIN, now, f.ws.workspaceId);
  const [m] = toGroup(chatId);
  assert.equal(m!.opts.buttons!.length, 1);
  assert.equal(m!.opts.buttons![0]!.length, 1);
  assert.match((m!.opts.buttons![0]![0] as { text: string; url: string }).url, new RegExp(`^https://plan\\.example\\.test/.+/browse/${ISSUE_KEY}$`));
  assert.equal(m!.opts.buttons![0]![0]!.text, "Open");
});

test("/help in a group: what it gets and who linked it; not linked, how to; another bot's /help is not ours", async () => {
  const { chatId, patch } = await linkedGroup();
  assert.match((await inGroup(chatId, "/help")).text!, /nothing is picked for it yet[\s\S]*your own chat with the bot/);
  assert.equal((await patch({ projectIds: [f.refs.project.id], events: ["urgent"] })).status, 204);
  assert.match((await inGroup(chatId, "/help@plnr_test_bot")).text!, new RegExp(`gets New urgent issue of ${f.refs.project.key}\\. Linked by`));
  assert.match((await inGroup(chatId - 700, "/help")).text!, /not linked to recursiva/);
  assert.deepEqual(await inGroup(chatId, "/help@other_bot"), {});
});
