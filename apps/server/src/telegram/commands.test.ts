import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTIFY_DEFAULTS, TELEGRAM_COMMANDS } from "@rsva/protocol";
import { ISSUE_KEY } from "@rsva/schema/models";
import { and, eq } from "drizzle-orm";
import { forgetRoles } from "../auth/access.ts";
import { db, schema } from "../db.ts";
import { setPrefs } from "../notify/fixture.ts";
import { addMember } from "../test/helpers.ts";
import { parseCommand } from "./commands.ts";
import { muteFor } from "./mute.ts";
import { chatHarness, type Answer } from "./test-chat.ts";

const { telegramChat, issue, attachment, blob, inboxMark, notifyOutbox } = schema;
const { answered, files, f, tx, newIssue, say, press, buttons, person, deliver } = chatHarness();
const stateOf = (group: string) => f.refs.states.find((s) => s.group === group)!.id;

test("a command and what follows it; a duration for /mute", () => {
  assert.deepEqual(parseCommand("/new  Fix the login "), { name: "new", args: "Fix the login" });
  assert.deepEqual(parseCommand("/MY@plnr_test_bot"), { name: "my", args: "" });
  assert.equal(parseCommand("hello /my"), null);
  assert.equal(muteFor(""), null, "no default: /mute alone shows the state");
  assert.equal(muteFor("30m"), 30 * 60_000);
  assert.equal(muteFor("1d"), 86_400_000);
  assert.equal(muteFor("8d"), null, "a week at most");
  assert.equal(muteFor("soon"), null);
});

test("a chat nobody linked is told how to link it, /help with the commands", async () => {
  const help = await say(424_242, { text: "/help" });
  for (const c of TELEGRAM_COMMANDS) assert.ok(help.text.includes(`/${c.command}`), c.command);
  assert.match(help.text, /not connected to recursiva/);
  assert.match((await say(424_242, { text: "/my" })).text, /not connected to recursiva/);
  assert.match((await say(424_242, { text: "/nope" })).text, /not connected/);
});

test("/help and an unknown command in a linked chat", async () => {
  const { chatId } = await person();
  const help = await say(chatId, { text: "/help" });
  assert.doesNotMatch(help.text, /not connected/);
  assert.match(help.text, /\/new Title — New issue in your last project/);
  assert.match((await say(chatId, { text: "/what" })).text, /No such command/);
});

test("/my: My work five at a time, More and Previous turn the page", async () => {
  const { me, chatId } = await person();
  for (let i = 0; i < 4; i++) await newIssue(f.ws.ownerId, { title: `Next ${i}`, stateId: stateOf("unstarted"), assigneeIds: [me.id] });
  for (let i = 0; i < 3; i++) await newIssue(f.ws.ownerId, { title: `Doing ${i}`, stateId: stateOf("started"), assigneeIds: [me.id] });
  await newIssue(f.ws.ownerId, { title: "Someone else's", stateId: stateOf("started") });
  const first = await say(chatId, { text: "/my" });
  assert.equal(first.method, "sendMessage");
  assert.match(first.text, /<b>My work<\/b> · 1–5 of 7/);
  assert.match(first.text, /<b>You’re doing<\/b>[\s\S]*<b>Up next<\/b>/, "in the groups' order");
  assert.equal((first.text.match(/<code>/g) ?? []).length, 5);
  assert.doesNotMatch(first.text, /Someone else/);
  assert.deepEqual(buttons(first), [{ text: "More", callback_data: "my:5" }]);
  const second = await press(chatId, "my:5");
  assert.equal(second.method, "editMessageText");
  assert.equal(second.message_id, 40);
  assert.match(second.text, /6–7 of 7/);
  assert.deepEqual(buttons(second), [{ text: "Previous", callback_data: "my:0" }]);
  assert.equal(answered.at(-1)!.callbackId, "qmy:5", "the button is answered");
});

test("/inbox: unread lines with Read buttons; Read marks the line, Mark all read only what the message showed", async () => {
  const { me, chatId } = await person();
  const a = await newIssue(f.ws.ownerId, { title: "Assigned A" });
  const b = await newIssue(f.ws.ownerId, { title: "Assigned B" });
  for (const id of [a, b]) await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [me.id] } }]);
  const list = await say(chatId, { text: "/inbox" });
  assert.match(list.text, /<b>Inbox<\/b> · 2 unread/);
  assert.match(list.text, new RegExp(`assigned ${ISSUE_KEY} to you`));
  const read = buttons(list).filter((x) => x.text.startsWith("Read "));
  assert.equal(read.length, 2);
  assert.ok(buttons(list).some((x) => x.callback_data === "ra"));

  const one = await press(chatId, read[0]!.callback_data);
  assert.match(one.text, /1 unread/);
  assert.equal(answered.at(-1)!.text, "Marked as read");
  const [mark] = await db.select().from(inboxMark).where(and(eq(inboxMark.userId, me.id), eq(inboxMark.issueId, b)));
  assert.ok(mark && mark.readId > 0, "the newest line was the first");

  // Drawn before anything happened: nothing on it to mark.
  const stale = await press(chatId, "ra", new Date(Date.now() - 3_600_000));
  assert.match(stale.text, /1 unread/);
  assert.equal(answered.at(-1)!.text, "Nothing new to mark");
  const all = await press(chatId, "ra");
  assert.match(all.text, /Nothing unread/);
});

test("Read marks a line up to the message's time: what came after keeps it unread", async () => {
  const { me, chatId } = await person();
  const id = await newIssue(f.ws.ownerId, { title: "Twice" });
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [me.id] } }]);
  // The message was last redrawn before the second event: `edit_date` is the cut.
  const drawn = new Date();
  await new Promise((r) => setTimeout(r, 1100));
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { stateId: stateOf("started") } }]);
  const answer = await press(chatId, `r:0:${id}`, drawn, true);
  assert.match(answer.text, /1 unread/, "the newer event keeps the line");
  const [mark] = await db.select().from(inboxMark).where(and(eq(inboxMark.userId, me.id), eq(inboxMark.issueId, id)));
  assert.ok(mark && mark.readId > 0, "read up to the first event");
  const now = await press(chatId, `r:0:${id}`);
  assert.match(now.text, /Nothing unread/);
});

test("a chat linked to two accounts takes no commands and no buttons", async () => {
  const { chatId } = await person();
  const other = await addMember(f.ws.workspaceId, "member");
  await db.insert(telegramChat).values({ userId: other.id, chatId, name: "Ann", actions: true });
  await newIssue(other.id, { title: "Theirs" });
  assert.match((await say(chatId, { text: "/new Whose is it" })).text, /more than one recursiva account/);
  assert.deepEqual(await db.select().from(issue).where(eq(issue.title, "Whose is it")), []);
  assert.deepEqual(await press(chatId, "my:0"), {});
  assert.match(answered.at(-1)!.text!, /more than one recursiva account/);
});

test("/new: an issue in the project of the person's last one; a photo as its caption is attached", async () => {
  const { me, chatId } = await person();
  assert.match((await say(chatId, { text: "/new Something" })).text, /Which project\? Name it with #: #/);
  await newIssue(me.id, { title: "Mine" });
  assert.match((await say(chatId, { text: "/new" })).text, /Write the title/);

  const made = await say(chatId, { text: "/new Fix the sign-in page" });
  const key = new RegExp(`<code>(${ISSUE_KEY})</code>`).exec(made.text)![1]!;
  assert.ok(key.startsWith(`${f.refs.project.key}-`));
  const [row] = await db.select().from(issue).where(and(eq(issue.createdById, me.id), eq(issue.title, "Fix the sign-in page")));
  assert.equal(row!.projectId, f.refs.project.id);

  assert.match((await say(chatId, { caption: "/new Lost photo", photo: [{ file_id: "missing", file_size: 30 }] })).text, /did not give the file/);
  assert.deepEqual(await db.select().from(issue).where(eq(issue.title, "Lost photo")), [], "no issue without its file");

  files.set("ph-1", Buffer.from("\x89PNG\r\n\x1a\n not really a picture"));
  const withPhoto = await say(chatId, { caption: "/new Broken button", photo: [{ file_id: "ph-0", file_size: 10 }, { file_id: "ph-1", file_size: 30 }] });
  assert.match(withPhoto.text, /with the file attached/);
  const [p] = await db.select().from(issue).where(and(eq(issue.createdById, me.id), eq(issue.title, "Broken button")));
  const [att] = await db.select().from(attachment).where(eq(attachment.issueId, p!.id));
  assert.equal(att!.kind, "file");
  assert.equal(att!.title, "photo.jpg");
  const [stored] = await db.select().from(blob).where(and(eq(blob.workspaceId, f.ws.workspaceId), eq(blob.sha256, att!.sha256!)));
  assert.equal(stored!.size, 30);

  await db.update(schema.member).set({ role: "guest" }).where(and(eq(schema.member.workspaceId, f.ws.workspaceId), eq(schema.member.userId, me.id)));
  forgetRoles();
  assert.match((await say(chatId, { text: "/new Not allowed" })).text, /cannot create issues in any project/, "no project the person may write in");
});

test("/mute: only urgent issues come until then; /mute off ends it", async () => {
  const { me, chatId } = await person();
  await setPrefs(me.id, { ...NOTIFY_DEFAULTS, seen: false, quiet: null, rules: { assigned: { telegram: "now" } } }, "UTC");
  assert.match((await say(chatId, { text: "/mute 2h" })).text, /Muted until \d\d:\d\d|Muted until \w{3} \d\d:\d\d/);
  const [c] = await db.select().from(telegramChat).where(eq(telegramChat.userId, me.id));
  assert.ok(Math.abs(Date.parse(c!.mutedUntil!) - Date.now() - 2 * 3_600_000) < 60_000);
  assert.match((await say(chatId, { text: "/mute forever" })).text, /how long/);

  const quiet = await newIssue(f.ws.ownerId, { title: "Quiet one" });
  const loud = await newIssue(f.ws.ownerId, { title: "Loud one", priority: 1 });
  for (const id of [quiet, loud]) await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [me.id] } }]);
  const got = await deliver(chatId);
  assert.equal(got.length, 1);
  assert.match(got[0]!.html, /urgent/);
  const [dropped] = await db.select().from(notifyOutbox).where(and(eq(notifyOutbox.userId, me.id), eq(notifyOutbox.issueId, quiet), eq(notifyOutbox.channel, "telegram")));
  assert.equal(dropped!.status, "dropped");

  assert.match((await say(chatId, { text: "/mute off" })).text, /on again/);
  const [after] = await db.select().from(telegramChat).where(eq(telegramChat.userId, me.id));
  assert.equal(after!.mutedUntil, null);
});

test("/new reads #project @who !priority +label and long keys; lines after the first are the description (PLNR-359)", async () => {
  const { me, chatId } = await person();
  await newIssue(me.id, { title: "Mine" });
  const { other, otherLabels } = f.refs;
  const made = async (title: string) => (await db.select().from(issue).where(and(eq(issue.createdById, me.id), eq(issue.title, title))))[0];

  const one = await say(chatId, { text: `/new Rotate the keys #${other.key.toLowerCase()} !high +"${otherLabels[0]!.name}" due:tomorrow\nOld ones expire on Friday.\nCheck the backups too.` });
  assert.match(one.text, new RegExp(`<code>${other.key}-\\d+</code>`));
  const row = (await made("Rotate the keys"))!;
  assert.equal(row.projectId, other.id);
  assert.equal(row.priority, 2);
  assert.deepEqual(row.labelIds, [otherLabels[0]!.id]);
  assert.deepEqual(row.assigneeIds, [me.id], "the author when no @");
  assert.ok(row.dueDate);
  const [doc] = await db.select().from(schema.document).where(eq(schema.document.id, row.id));
  assert.match(JSON.stringify(doc!.doc), /Old ones expire on Friday/);

  await say(chatId, { text: '/new "Fix !important handling" @none' });
  assert.deepEqual((await made("Fix !important handling"))!.assigneeIds, [], "@none leaves it unassigned; quotes keep text");
  assert.equal((await made("Fix !important handling"))!.projectId, other.id, "no #: the project of the person's last issue");

  const typo = await say(chatId, { text: "/new Typo !urgnt" });
  assert.equal(typo.text, "No priority named &quot;urgnt&quot;. Did you mean !urgent? Nothing was created.");
  assert.match((await say(chatId, { text: "/new Typo priority:urgnt" })).text, /Did you mean priority:urgent\?/);
  assert.match((await say(chatId, { text: "/new Typo group:started" })).text, /narrows a list/);
  assert.match((await say(chatId, { text: "/new Typo #nope" })).text, /No project &quot;nope&quot;\. Name it with #/);
  assert.match((await say(chatId, { text: "/new Typo !high !low" })).text, /One priority only/);
  assert.equal(await made("Typo"), undefined, "nothing created on an error");
});

test("/mute alone: the state, and buttons that change it", async () => {
  const { me, chatId } = await person();
  await setPrefs(me.id, { ...NOTIFY_DEFAULTS, seen: false, quiet: null, rules: {} }, "UTC");
  const mutedUntil = async () => (await db.select().from(telegramChat).where(eq(telegramChat.userId, me.id)))[0]!.mutedUntil;

  const on = await say(chatId, { text: "/mute" });
  assert.equal(on.text, "Notifications are on.");
  assert.deepEqual(buttons(on).map((b) => [b.text, b.callback_data]), [["1h", "mu:60"], ["2h", "mu:120"], ["Until 09:00", "mu:am"]], "no Off while on");
  assert.equal(await mutedUntil(), null, "asking does not mute");

  const hour = await press(chatId, "mu:60");
  assert.equal(hour.method, "editMessageText");
  assert.equal(hour.message_id, 40);
  assert.match(hour.text, /Muted until \d\d:\d\d|Muted until \w{3} \d\d:\d\d/);
  assert.match(hour.text, /Urgent issues still come/);
  assert.ok(Math.abs(Date.parse((await mutedUntil())!) - Date.now() - 3_600_000) < 60_000);
  assert.deepEqual(buttons(hour).map((b) => b.callback_data), ["mu:60", "mu:120", "mu:am", "mu:off"]);
  assert.match((await say(chatId, { text: "/mute" })).text, /^Muted until/);

  await press(chatId, "mu:120");
  assert.ok(Math.abs(Date.parse((await mutedUntil())!) - Date.now() - 2 * 3_600_000) < 60_000);

  const morning = await press(chatId, "mu:am");
  const until = new Date((await mutedUntil())!);
  assert.equal(until.getUTCHours(), 9);
  assert.equal(until.getUTCMinutes(), 0);
  assert.ok(until.getTime() > Date.now() && until.getTime() - Date.now() <= 86_400_000, "the next 09:00");
  assert.match(morning.text, /Muted until/);

  const off = await press(chatId, "mu:off");
  assert.equal(off.text, "Notifications are on.");
  assert.equal(buttons(off).some((b) => b.callback_data === "mu:off"), false);
  assert.equal(await mutedUntil(), null);

  await press(chatId, "mu:30");
  assert.ok(Math.abs(Date.parse((await mutedUntil())!) - Date.now() - 30 * 60_000) < 60_000);
  await press(chatId, "mu:99999");
  assert.ok(Math.abs(Date.parse((await mutedUntil())!) - Date.now() - 30 * 60_000) < 60_000, "an out-of-range choice changes nothing");
  assert.match((await say(chatId, { text: "/mute off" })).text, /on again/);
  assert.equal(await mutedUntil(), null);
});

test("a mute button in a chat nobody linked is refused", async () => {
  const res = await press(987_654, "mu:60");
  assert.equal(res.method, undefined);
  assert.match(answered.at(-1)?.text ?? "", /not connected/);
});

/** A notification of an issue assigned to a new member, sent to their chat; the message with its buttons. */
async function notified(actions = true) {
  const { me, chatId } = await person("member", actions);
  await setPrefs(me.id, { ...NOTIFY_DEFAULTS, seen: false, quiet: null, rules: { assigned: { telegram: "now" } } }, "UTC");
  const id = await newIssue(f.ws.ownerId, { title: "Snooze me" });
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [me.id] } }]);
  const message = (await deliver(chatId))[0]!;
  return { me, chatId, id, message };
}
type Shown = { text: string; url?: string; callback_data?: string };
const shown = (a: unknown) => ((a as Answer).reply_markup?.inline_keyboard.flat() ?? []) as Shown[];

test("a notification carries Open and Snooze 2h; Snooze 2h snoozes the line, says until when, and keeps Open", async () => {
  const { me, chatId, id, message } = await notified();
  const [open, snooze, more] = message.opts.buttons![0]!;
  assert.deepEqual(more, { text: "⋯", data: `c:x:${id}` });
  assert.deepEqual(snooze, { text: "Snooze 2h", data: `sn:${id}` });
  assert.equal(message.opts.buttons!.length, 1);
  assert.match((open as { url: string }).url, new RegExp(`^https://plan\\.example\\.test/.+/browse/${ISSUE_KEY}$`));

  const at = Date.now();
  const answer = await press(chatId, `sn:${id}`);
  const [mark] = await db.select().from(inboxMark).where(and(eq(inboxMark.userId, me.id), eq(inboxMark.issueId, id)));
  assert.ok(mark && Math.abs(Date.parse(mark.snoozedUntil!) - at - 2 * 3_600_000) < 60_000, "snoozed for two hours");
  assert.ok(mark!.snoozedId > 0);
  const toast = answered.findLast((x) => x.callbackId === `qsn:${id}`)!.text!;
  assert.match(toast, /^Snoozed until \d\d:\d\d$/);
  assert.equal(answer.method, "editMessageReplyMarkup");
  // Open links to the server's public address; the tests have none, so the redrawn message leaves it out (replyMarkup).
  assert.deepEqual(shown(answer).map((b) => b.text), [toast, "⋯"]);

  // Again: a word, nothing changes.
  const again = await press(chatId, `sn:${id}`);
  const [same] = await db.select().from(inboxMark).where(and(eq(inboxMark.userId, me.id), eq(inboxMark.issueId, id)));
  assert.equal(same!.snoozedUntil, mark!.snoozedUntil);
  assert.match(answered.findLast((x) => x.callbackId === `qsn:${id}`)!.text!, /^Already snoozed until \d\d:\d\d$/);
  assert.deepEqual(shown(again).map((b) => b.text), [toast, "⋯"]);
});

test("Snooze 2h from a chat that is not linked, or for an issue the person cannot read any more, changes nothing", async () => {
  const { me, chatId, id } = await notified();
  const stranger = await press(777_001, `sn:${id}`);
  assert.deepEqual(stranger, {});
  assert.match(answered.findLast((x) => x.callbackId === `qsn:${id}`)!.text!, /not connected/);
  assert.deepEqual(await db.select().from(inboxMark).where(and(eq(inboxMark.userId, me.id), eq(inboxMark.issueId, id))), []);

  await db.delete(schema.member).where(and(eq(schema.member.workspaceId, f.ws.workspaceId), eq(schema.member.userId, me.id)));
  forgetRoles();
  assert.deepEqual(await press(chatId, `sn:${id}`), {});
  assert.equal(answered.findLast((x) => x.callbackId === `qsn:${id}`)!.text, "You cannot see this issue any more");
  assert.deepEqual(await press(chatId, "sn:not-an-id"), {});
  assert.deepEqual(await db.select().from(inboxMark).where(and(eq(inboxMark.userId, me.id), eq(inboxMark.issueId, id))), []);
});

/** A button pressed on a message whose text Telegram sends along, as it does for every callback. */
const pressOn = (chatId: number, data: string, text: string) => press(chatId, data, new Date(), false, text);
/** The plain text of an answer: what Telegram sends back as the message's `text`. */
const plain = (a: Answer) => a.text.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");

test("/find: short forms, a key, free text; the list is five at a time, newest update first", async () => {
  const { chatId } = await person();
  const word = `zebra${Date.now()}`;
  const label = f.refs.labels[0]!;
  const key = f.refs.project.key;
  const urgent = await newIssue(f.ws.ownerId, { title: `${word} urgent`, priority: 1, labelIds: [label.id] });
  for (let i = 0; i < 6; i++) await newIssue(f.ws.ownerId, { title: `${word} plain ${i}`, priority: 3 });

  const text = await say(chatId, { text: `/find ${word}` });
  assert.equal(text.method, "sendMessage");
  assert.match(text.text, new RegExp(`<b>Find</b> · ${word} · 1–5 of 7`));
  assert.equal((text.text.match(/<code>/g) ?? []).length, 5);
  assert.match(text.text, new RegExp(`<code>${key}-\\d+</code> · `));
  assert.match(text.text, /plain 5/, "the newest first");
  assert.deepEqual(buttons(text), [{ text: "More", callback_data: "f:5" }]);

  const one = await say(chatId, { text: `/find !urgent ${word}` });
  assert.match(one.text, /urgent<\/a>/);
  assert.equal((one.text.match(/<code>/g) ?? []).length, 1);
  assert.deepEqual(buttons(one), []);
  assert.equal((await say(chatId, { text: `/find +${label.name} #${key} ${word}` })).text.includes("urgent</a>"), true);
  assert.equal((await say(chatId, { text: `/find #${key} ${word} @me` })).text.includes("Nothing found."), true, "nobody assigned me");
  const [row] = await db.select({ number: issue.number }).from(issue).where(eq(issue.id, urgent));
  assert.match((await say(chatId, { text: `/find ${key}-${row!.number}` })).text, /urgent<\/a>/, "a long key");
});

test("/find: More and Previous read the query back from the message being redrawn", async () => {
  const { chatId } = await person();
  const word = `quokka${Date.now()}`;
  for (let i = 0; i < 7; i++) await newIssue(f.ws.ownerId, { title: `${word} ${i}` });
  const first = await say(chatId, { text: `/find ${word}` });
  const more = await pressOn(chatId, "f:5", plain(first));
  assert.equal(more.method, "editMessageText");
  assert.equal(more.message_id, 40);
  assert.match(more.text, new RegExp(`${word} · 6–7 of 7`));
  assert.deepEqual(buttons(more), [{ text: "Previous", callback_data: "f:0" }]);
  const back = await pressOn(chatId, "f:0", plain(more));
  assert.match(back.text, new RegExp(`${word} · 1–5 of 7`));
  assert.ok(buttons(back).length === 1 && buttons(back)[0]!.text === "More");
  assert.ok(Buffer.byteLength(buttons(back)[0]!.callback_data) <= 64);
  assert.match((await pressOn(chatId, "f:5", "Something else")).text, /Search issues/, "a message that is not a /find answer");
});

test("/find: an error with a suggestion in the form typed; nothing found; no query", async () => {
  const { chatId } = await person();
  const word = `ocelot${Date.now()}`;
  await newIssue(f.ws.ownerId, { title: word, priority: 1 });
  const typo = await say(chatId, { text: `/find ${word} !urgnt` });
  assert.match(typo.text, /<b>Find<\/b> · \S+ !urgnt\n.*urgnt.*Did you mean !urgent\?/);
  assert.match(typo.text, new RegExp(`${word}</a>`), "the valid part still applies");
  assert.match((await say(chatId, { text: `/find ${word} priority:urgnt` })).text, /Did you mean priority:urgent\?/);
  assert.match((await say(chatId, { text: `/find ${word} #NOSUCH` })).text, /No project named &quot;NOSUCH&quot;/);
  assert.match((await say(chatId, { text: `/find nothing${word}` })).text, /Nothing found\./);
  const none = await say(chatId, { text: "/find" });
  assert.match(none.text, /Search issues/);
  assert.match(none.text, /#INFRA/);
  assert.ok(TELEGRAM_COMMANDS.some((c) => c.command === "find"));
});

test("/inbox: tabs Unread and All; Read buttons stay on Unread; a Waiting on you button of an old message opens All", async () => {
  const { me, chatId } = await person();
  const assigned = await newIssue(f.ws.ownerId, { title: "Waiting one", stateId: stateOf("unstarted") });
  const mentioned = await newIssue(f.ws.ownerId, { title: "Just assigned and started", stateId: stateOf("started") });
  for (const id of [assigned, mentioned]) await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [me.id] } }]);
  const unread = await say(chatId, { text: "/inbox" });
  assert.match(unread.text, /<b>Inbox<\/b> · 2 unread/);
  assert.deepEqual(
    buttons(unread).filter((b) => /Unread|Waiting|All/.test(b.text)),
    [{ text: "• Unread", callback_data: "i:0" }, { text: "All", callback_data: "ia:0" }],
  );
  assert.ok(buttons(unread).some((b) => b.text === "Mark all read"));

  // The tab went (RSVA-572: what waits is /my); its button on a message drawn before opens All.
  const old = await press(chatId, "iw:0");
  assert.match(old.text, /<b>Inbox<\/b> · All · 2/);
  assert.ok(!buttons(old).some((b) => b.text.startsWith("Read ") || b.callback_data === "ra"));

  // Read lines leave Unread but stay in All.
  await press(chatId, "ra");
  const all = await press(chatId, "ia:0");
  assert.match(all.text, /<b>Inbox<\/b> · All · 2/);
  assert.ok(buttons(all).some((b) => b.text === "• All"));
  assert.match((await press(chatId, "i:0")).text, /Nothing unread/);
  assert.ok(buttons(await press(chatId, "i:0")).some((b) => b.callback_data === "ia:0"), "the tabs stay on an empty tab");
});

test("notifications only: a notification has Open alone, and the chat takes no commands but /mute and /help (RSVA-496)", async () => {
  const { me, chatId, id, message } = await notified(false);
  assert.deepEqual(message.opts.buttons, [[{ text: "Open", url: (message.opts.buttons![0]![0] as { url: string }).url }]]);
  for (const text of ["/my", "/inbox", "/find snooze", "/triage", "/new Not from here", "PLNR-1", "just words"]) assert.match((await say(chatId, { text })).text, /notifications only/, text);
  assert.match((await say(chatId, { caption: "/new From a photo", photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }] })).text, /notifications only/);
  assert.deepEqual(await say(chatId, { media_group_id: "a1", photo: [{ file_id: "p2", file_unique_id: "u2", width: 1, height: 1 }] }), {}, "an album's photo without a caption is not answered");
  assert.deepEqual(await db.select().from(issue).where(and(eq(issue.workspaceId, f.ws.workspaceId), eq(issue.title, "Not from here"))), []);
  const help = await say(chatId, { text: "/help" });
  assert.match(help.text, /\/mute 2h/);
  assert.match(help.text, /notifications only/);
  assert.match((await say(chatId, { text: "/mute 1h" })).text, /urgent/i);
  const [chat] = await db.select().from(telegramChat).where(eq(telegramChat.userId, me.id));
  assert.ok(chat!.mutedUntil, "/mute still works");

  // A button drawn while actions were on: refused when pressed, and nothing changes.
  for (const data of [`sn:${id}`, `c:x:${id}`, "my:0", "ra:0"]) {
    assert.deepEqual(await press(chatId, data), {}, data);
    assert.match(answered.findLast((x) => x.callbackId === `q${data}`)!.text!, /notifications only/, data);
  }
  assert.deepEqual(await db.select().from(inboxMark).where(and(eq(inboxMark.userId, me.id), eq(inboxMark.issueId, id))), [], "not snoozed, not read");
});
