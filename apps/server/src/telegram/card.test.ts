import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { onlyKeys } from "./card.ts";
import { chatHarness } from "./test-chat.ts";

const { issue, workflowState } = schema;
const { f, sent, answered, tx, newIssue, say, press, buttons, person } = chatHarness();
const row = async (id: string) => (await db.select().from(issue).where(eq(issue.id, id)))[0]!;
const keyOf = async (id: string) => `${f.refs.project.key}-${(await row(id)).number}`;
const toast = (data: string) => answered.findLast((a) => a.callbackId === `q${data}`)?.text;

test("keys alone are cards; anything else is not", () => {
  assert.deepEqual(onlyKeys("plnr-12"), ["PLNR-12"]);
  assert.deepEqual(onlyKeys(" PLNR-12, INFRA-3 PLNR-12 "), ["PLNR-12", "INFRA-3"]);
  assert.equal(onlyKeys("look at PLNR-12"), null);
  assert.equal(onlyKeys("A-1 B-2 C-3 D-4 E-5 F-6"), null, "five at most");
});

test("a key alone answers with its card; several keys with a card each, in order", async () => {
  const { me, chatId } = await person();
  const id = await newIssue(me.id, { title: "Rotate <the> keys", priority: 2, assigneeIds: [me.id] });
  const key = await keyOf(id);
  const one = await say(chatId, { text: key.toLowerCase() });
  assert.equal(one.method, "sendMessage");
  assert.ok(one.text.startsWith(`<code>${key}</code> · `), "the key leads, so a reply finds it");
  assert.match(one.text, /High/);
  assert.match(one.text, /Rotate &lt;the&gt; keys/);
  assert.deepEqual(
    buttons(one).map((b) => b.callback_data ?? b.text),
    [`c:s:${id}`, `c:p:${id}`, `c:a:${id}`, `c:l:${id}`, `sn:${id}`],
    "Open needs a public address, which the tests have none of",
  );
  for (const b of buttons(one)) assert.ok(Buffer.byteLength(b.callback_data ?? "") <= 64);

  const other = await newIssue(me.id, { title: "Second" });
  const before = sent.length;
  const last = await say(chatId, { text: `${key} ${await keyOf(other)} NOPE-1` });
  assert.equal(sent.length - before, 2, "all but the last are sent at once");
  assert.match(sent.at(-2)!.html, /Rotate/);
  assert.match(sent.at(-1)!.html, /Second/);
  assert.match(last.text, /No issue NOPE-1 that you can see/);

  assert.equal((await say(424_243, { text: key })).text, undefined, "a chat nobody linked gets nothing");
});

test("pickers change the state, the priority and the assignees; Undo puts it back", async () => {
  const { me, chatId } = await person();
  const id = await newIssue(me.id, { title: "Pick me" });

  const states = await press(chatId, `c:s:${id}`);
  assert.equal(states.method, "editMessageText");
  const names = buttons(states).map((b) => b.text);
  assert.ok(names.at(-1) === "Back");
  const done = f.refs.states.find((s) => s.group === "completed")!;
  const choice = buttons(states).find((b) => b.text.replace(/^• /, "") === done.name)!;
  const moved = await press(chatId, choice.callback_data);
  assert.equal((await row(id)).stateId, done.id);
  assert.equal(toast(choice.callback_data), `Moved to ${done.name}`);
  assert.equal(buttons(moved)[0]!.text, "Undo");

  const undone = await press(chatId, buttons(moved)[0]!.callback_data);
  assert.notEqual((await row(id)).stateId, done.id);
  assert.equal(toast(buttons(moved)[0]!.callback_data), "Undone");
  assert.notEqual(buttons(undone)[0]!.text, "Undo");
  await press(chatId, buttons(moved)[0]!.callback_data);
  assert.equal(toast(buttons(moved)[0]!.callback_data), "Undo is no longer available.", "once");

  await press(chatId, `cp:1:${id}`);
  assert.equal((await row(id)).priority, 1);
  const people = await press(chatId, `c:a:${id}`);
  const mine = buttons(people).find((b) => b.callback_data === `ca:${me.id.slice(-10)}:${id}`)!;
  assert.ok(mine, "the person is offered");
  const assigned = await press(chatId, mine.callback_data);
  assert.deepEqual((await row(id)).assigneeIds, [me.id]);
  await press(chatId, mine.callback_data);
  assert.deepEqual((await row(id)).assigneeIds, [], "a second tap unassigns");

  // Undo after the field changed again: refused.
  await press(chatId, buttons(assigned)[0]!.callback_data);
  assert.equal(toast(buttons(assigned)[0]!.callback_data), "Changed since: open the issue");
  assert.deepEqual((await row(id)).assigneeIds, []);
});

test("a state only people set (Todo, Approved) is not offered, by picker or /new", async () => {
  const { me, chatId } = await person();
  const id = await newIssue(me.id, { title: "Gate" });
  const [gate] = await db
    .insert(workflowState)
    .values({ projectId: f.refs.project.id, name: `Approved${Date.now()}`, group: "started", color: "#22c55e", position: 99, onlyPeople: true })
    .returning();
  const states = await press(chatId, `c:s:${id}`);
  assert.equal(buttons(states).some((b) => b.text.includes(gate!.name)), false);
  assert.equal((await press(chatId, `cs:${gate!.id.slice(-10)}:${id}`)).text.includes(gate!.name), false);
  assert.notEqual((await row(id)).stateId, gate!.id);
  assert.match((await say(chatId, { text: `/new Shipped already state:"${gate!.name}"` })).text, /is set in recursiva, not from Telegram\. Nothing was created/);
  assert.equal((await db.select().from(issue).where(eq(issue.title, "Shipped already"))).length, 0);
  // Todo too: moving a proposal there is approving it (owner 2026-11-06).
  const todo = f.refs.states.find((s) => s.group === "unstarted")!;
  await db.update(workflowState).set({ onlyPeople: true }).where(eq(workflowState.id, todo.id));
  assert.equal(buttons(await press(chatId, `c:s:${id}`)).some((b) => b.text.includes(todo.name)), false);
  await press(chatId, `cs:${todo.id.slice(-10)}:${id}`);
  assert.notEqual((await row(id)).stateId, todo.id);
});

test("a label only people set is not offered, and No labels leaves it on", async () => {
  const { me, chatId } = await person();
  const [a] = f.refs.labels;
  const [proposed] = await db
    .insert(schema.label)
    .values({ workspaceId: f.ws.workspaceId, projectId: f.refs.project.id, name: `proposed${Date.now()}`, color: "#888888", position: 99_100, onlyPeople: true })
    .returning();
  const id = await newIssue(me.id, { title: "Proposal", labelIds: [a!.id, proposed!.id] });
  assert.equal(buttons(await press(chatId, `c:l:${id}`)).some((b) => b.text.includes(proposed!.name)), false);
  await press(chatId, `cl:${proposed!.id.slice(-10)}:${id}`);
  assert.deepEqual((await row(id)).labelIds, [a!.id, proposed!.id], "a forged press takes nothing off");
  await press(chatId, `cl:none:${id}`);
  assert.deepEqual((await row(id)).labelIds, [proposed!.id]);
  assert.match((await say(chatId, { text: `/new Add it +${proposed!.name}` })).text, /is set in recursiva, not from Telegram\. Nothing was created/);
});

test("Labels ▾ switches a label on and off, No labels clears them; /set is gone", async () => {
  const { me, chatId } = await person();
  const [a, b] = f.refs.labels;
  const id = await newIssue(me.id, { title: "Label me", labelIds: [a!.id] });
  const card = await say(chatId, { text: await keyOf(id) });
  assert.deepEqual(buttons(card).map((x) => x.text).slice(0, 4), ["State ▾", "Priority ▾", "Assignee ▾", "Labels ▾"]);

  const picker = await press(chatId, `c:l:${id}`);
  const names = buttons(picker).map((x) => x.text);
  assert.ok(names.includes(`✓ ${a!.name}`) && names.includes(b!.name) && names.includes("No labels"), names.join(", "));
  const on = await press(chatId, `cl:${b!.id.slice(-10)}:${id}`);
  assert.deepEqual(new Set((await row(id)).labelIds), new Set([a!.id, b!.id]));
  assert.equal(toast(`cl:${b!.id.slice(-10)}:${id}`), `${b!.name} added`);
  assert.equal(buttons(on)[0]!.text, "Undo");
  await press(chatId, `cl:${a!.id.slice(-10)}:${id}`);
  assert.deepEqual((await row(id)).labelIds, [b!.id]);
  await press(chatId, `cl:none:${id}`);
  assert.deepEqual((await row(id)).labelIds, []);
  // An other project's label is not offered, nor taken from a button.
  const theirs = f.refs.otherLabels[0]!;
  assert.equal(buttons(picker).some((x) => x.text.includes(theirs.name) && !f.refs.labels.some((l) => l.name === theirs.name)), false);
  await press(chatId, `cl:${theirs.id.slice(-10)}:${id}`);
  assert.deepEqual((await row(id)).labelIds, []);

  assert.match((await say(chatId, { text: `/set ${await keyOf(id)} !high` })).text, /No such command/);
});

test("a reply to a card: text is a comment, /new is a sub-issue", async () => {
  const { me, chatId } = await person();
  const id = await newIssue(me.id, { title: "Parent" });
  const key = await keyOf(id);
  const card = { message_id: 91, from: { is_bot: true }, text: `${key} · Backlog · No priority\nParent` };

  assert.match((await say(chatId, { text: "Looks good", reply_to_message: card })).text, new RegExp(`Posted to <code>${key}</code>`));
  const [c] = await db.select().from(schema.comment).where(eq(schema.comment.issueId, id));
  assert.equal(c!.body, "Looks good");

  const child = await say(chatId, { text: "/new Child step", reply_to_message: card });
  assert.match(child.text, /Created\./);
  const [kid] = await db.select().from(issue).where(eq(issue.parentId, id));
  assert.equal(kid!.title, "Child step");

  const mine = { message_id: 92, from: { is_bot: false }, text: `${key} · not the bot's` };
  assert.match((await say(chatId, { text: "hello", reply_to_message: mine })).text, /not about an issue/);
});

test("/find quotes what the person typed in an error as text, not markup", async () => {
  const { chatId } = await person();
  const a = await say(chatId, { text: "/find #<b>x</b>" });
  assert.ok(!a.text.includes("<b>x</b>"));
  assert.match(a.text, /&lt;b&gt;x&lt;\/b&gt;/);
});

test("a reply to a card in a second workspace with the same project key acts on that card's issue (review of PLNR-358)", async () => {
  const { importFixture } = await import("../test/helpers.ts");
  const { me, chatId } = await person();
  const other = await importFixture();
  await db.insert(schema.member).values({ workspaceId: other.workspaceId, userId: me.id, role: "member" });
  const [theirs] = await db.select().from(issue).where(eq(issue.workspaceId, other.workspaceId)).limit(1);
  const [same] = await db.select().from(schema.project).where(eq(schema.project.id, theirs!.projectId));
  const key = `${same!.key}-${theirs!.number}`;
  // The card as Telegram sends it back: its key, and its buttons with the issue's id.
  const card = { message_id: 93, from: { is_bot: true }, text: `${key} · Backlog\nTheirs`, reply_markup: { inline_keyboard: [[{ text: "State ▾", callback_data: `c:s:${theirs!.id}` }]] } };
  assert.match((await say(chatId, { text: "On the right one", reply_to_message: card })).text, /Posted to/);
  const [c] = await db.select().from(schema.comment).where(eq(schema.comment.body, "On the right one"));
  assert.equal(c!.issueId, theirs!.id);
});

test("a proposal stays in Backlog or is cancelled from Telegram; Undo of the cancel puts proposed back", async () => {
  const { me, chatId } = await person();
  const [proposed] = await db
    .insert(schema.label)
    .values({ workspaceId: f.ws.workspaceId, projectId: f.refs.project.id, name: "proposed", color: "#888888", position: 99_200 })
    .returning();
  const backlog = f.refs.states.find((s) => s.group === "backlog")!;
  const started = f.refs.states.find((s) => s.group === "started" && !s.onlyPeople)!;
  const cancelled = f.refs.states.find((s) => s.group === "cancelled")!;
  const id = await newIssue(me.id, { title: "Proposed work", stateId: backlog.id, labelIds: [proposed!.id] });
  const offered = buttons(await press(chatId, `c:s:${id}`)).map((b) => b.text.replace(/^• /, ""));
  assert.ok(offered.includes(cancelled.name) && !offered.includes(started.name), offered.join(", "));
  await press(chatId, `cs:${started.id.slice(-10)}:${id}`);
  assert.equal((await row(id)).stateId, backlog.id, "a forged press does not start it");

  const moved = await press(chatId, `cs:${cancelled.id.slice(-10)}:${id}`);
  assert.equal((await row(id)).stateId, cancelled.id);
  assert.deepEqual((await row(id)).labelIds, []);
  await press(chatId, buttons(moved)[0]!.callback_data);
  assert.equal((await row(id)).stateId, backlog.id);
  assert.deepEqual((await row(id)).labelIds, [proposed!.id]);
});

test("Undo does not move an issue back into a state only people set; a refusal reads once escaped", async () => {
  const { me, chatId } = await person();
  const id = await newIssue(me.id, { title: "Was approved" });
  const [gate] = await db
    .insert(workflowState)
    .values({ projectId: f.refs.project.id, name: `Shipped${Date.now()}`, group: "started", color: "#22c55e", position: 98, onlyPeople: true })
    .returning();
  await db.update(issue).set({ stateId: gate!.id }).where(eq(issue.id, id));
  const backlog = f.refs.states.find((s) => s.group === "backlog")!;
  const moved = await press(chatId, `cs:${backlog.id.slice(-10)}:${id}`);
  await press(chatId, buttons(moved)[0]!.callback_data);
  assert.equal(toast(buttons(moved)[0]!.callback_data), `It was ${gate!.name}: set that in recursiva`);
  assert.equal((await row(id)).stateId, backlog.id);

  const child = await newIssue(me.id, { title: "Child", parentId: id });
  const { findIssue, writeChange } = await import("./card.ts");
  const refused = await writeChange(me.id, (await findIssue(me.id, id))!, { parentId: child });
  assert.ok("why" in refused && /sub-issue/.test(refused.why), "the pipeline refused it");
  assert.ok("why" in refused && !/&(amp|#39|quot);/.test(refused.why), "plain text, for a toast");
});

test("what is made in the chat says so: the log, a comment, the history (PLNR-369)", async () => {
  const { readHistory } = await import("../sync/history.ts");
  const { me, chatId } = await person();
  const id = await newIssue(me.id, { title: "Where from" });
  await press(chatId, `cp:2:${id}`);
  const card = { message_id: 94, from: { is_bot: true }, text: "X-1 · Backlog", reply_markup: { inline_keyboard: [[{ text: "State ▾", callback_data: `c:s:${id}` }]] } };
  await say(chatId, { text: "From the phone", reply_to_message: card });
  await tx(me.id, [{ op: "update", m: "Issue", id, set: { priority: 3 } }]);

  const log = await db.select({ a: schema.syncAction.action, data: schema.syncAction.data, via: schema.syncAction.via }).from(schema.syncAction).where(eq(schema.syncAction.modelId, id)).orderBy(schema.syncAction.id);
  assert.deepEqual(log.filter((a) => a.a === "U" && (a.data as { priority?: number } | null)?.priority !== undefined).map((a) => a.via), ["telegram", null], "the chat's change, then the app's");
  const [c] = await db.select().from(schema.comment).where(eq(schema.comment.issueId, id));
  assert.equal(c!.via, "telegram");

  const h = await readHistory(me.id, id);
  assert.ok(h && h !== "rate_limited");
  assert.deepEqual(h.history.filter((e) => "priority" in e.d).map((e) => e.via ?? null), ["telegram", null]);
  assert.equal(h.comments[0]!.via, "telegram");

  // The live delta carries it too, so an open tab marks the change without asking the server.
  const { writeAs } = await import("./write.ts");
  const w = await writeAs(f.ws.workspaceId, me.id, "member", [{ op: "update", m: "Issue", id, set: { priority: 1 } }], "change it", "not changed");
  assert.ok(w.ok && w.r.actions.every((a) => a.via === "telegram"));
});
