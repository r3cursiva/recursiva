import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { TELEGRAM_COMMANDS } from "@rsva/protocol";
import { eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { projectOf } from "./triage.ts";
import { chatHarness } from "./test-chat.ts";

const { issue, label } = schema;
const { f, newIssue, say, press, buttons, person } = chatHarness();
const row = async (id: string) => (await db.select().from(issue).where(eq(issue.id, id)))[0]!;
const data = (a: { reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }, text: string) => a.reply_markup!.inline_keyboard.flat().find((b) => b.text === text)!.callback_data;
const header = (text: string) => text.split("\n")[0]!.replace(/<[^>]+>/g, "");

/** A `proposed` label in the project, once. */
let setup: { proposed: string; cancelled: string } | null = null;
async function fixture() {
  if (setup) return setup;
  const p = f.refs.project;
  const proposed = randomUUID();
  await db.insert(label).values({ id: proposed, workspaceId: f.ws.workspaceId, projectId: p.id, name: "Proposed", color: "#888888", position: 99_000, onlyPeople: true });
  setup = { proposed, cancelled: f.refs.states.find((s) => s.group === "cancelled")!.id };
  return setup;
}
const proposal = async (title: string, createdAt: string) => {
  const s = await fixture();
  const id = await newIssue(f.ws.agentId, { title, labelIds: [s.proposed], stateId: f.refs.states.find((s) => s.group === "backlog")!.id });
  await db.update(issue).set({ createdAt }).where(eq(issue.id, id));
  return id;
};

test("/triage is in the command menu after /find", () => {
  const names = TELEGRAM_COMMANDS.map((c) => c.command);
  assert.equal(names[names.indexOf("find") + 1], "triage");
  assert.equal(projectOf("Triage · #INFRA · 3 of 12\nrest"), "INFRA");
  assert.equal(projectOf("Triage · 3 of 12"), null);
});

test("queue: oldest first, cancel, skip, the end; no Approve, and an old Approve button writes nothing", async () => {
  const s = await fixture();
  const { chatId } = await person();
  const a = await proposal("First proposal", "2029-01-01T00:00:00.000Z");
  const b = await proposal("Second proposal", "2029-01-02T00:00:00.000Z");
  const all = await say(chatId, { text: "/triage" });
  assert.match(header(all.text), /^Triage · 1 of \d+$/);
  // Narrow to the project so the queue is this file's.
  const key = f.refs.project.key;
  const first = await say(chatId, { text: `/triage #${key.toLowerCase()}` });
  const total = Number(/of (\d+)$/.exec(header(first.text))![1]);
  assert.match(header(first.text), new RegExp(`^Triage · #${key} · 1 of ${total}$`));
  assert.deepEqual(buttons(first).map((x) => x.text), ["Cancel", "Skip"]);
  assert.ok(buttons(first).every((x) => !x.callback_data || Buffer.byteLength(x.callback_data) <= 64));

  // A card drawn before Approve was taken out (owner 2026-11-06): its button is refused and changes nothing.
  const old = await press(chatId, `t:a:${a}`, new Date(), false, first.text.replace(/<[^>]+>/g, ""));
  assert.match(old.text, /Approving is done in recursiva/);
  assert.equal((await row(a)).stateId, f.refs.states.find((q) => q.group === "backlog")!.id);
  assert.deepEqual((await row(a)).labelIds, [s.proposed]);

  // Cancel every card until the end; ours come oldest first.
  let msg = first;
  const seen: string[] = [];
  for (let n = 0; n < total + 1 && msg.text.includes("Triage"); n++) {
    const id = buttons(msg).find((y) => y.callback_data?.startsWith("t:c:"))!.callback_data.slice(4);
    if (id === a || id === b) seen.push(id);
    msg = await press(chatId, `t:c:${id}`, new Date(), false, msg.text.replace(/<[^>]+>/g, ""));
  }
  assert.deepEqual(seen, [a, b], "oldest first");
  assert.equal((await row(a)).stateId, s.cancelled);
  assert.match(msg.text, /Nothing left to triage\./);
});

test("skip moves on without writing, the project stays in the header, undo puts a cancelled issue back", async () => {
  const s = await fixture();
  const { chatId } = await person();
  const key = f.refs.project.key;
  const x = await proposal("Skip me", "2028-01-01T00:00:00.000Z");
  const y = await proposal("Then me", "2028-01-02T00:00:00.000Z");
  const backlog = f.refs.states.find((q) => q.group === "backlog")!.id;
  const head = (n: number, total: number) => `Triage · #${key} · ${n} of ${total}`;
  let m = await say(chatId, { text: `/triage project:${key}` });
  while (!buttons(m).some((b) => b.callback_data === `t:s:${x}`)) m = await press(chatId, buttons(m).find((b) => b.text === "Skip")!.callback_data, new Date(), false, m.text.replace(/<[^>]+>/g, ""));
  const total = Number(/of (\d+)$/.exec(header(m.text))![1]);
  const skipped = await press(chatId, `t:s:${x}`, new Date(), false, head(1, total));
  assert.equal((await row(x)).stateId, backlog, "skip writes nothing");
  assert.match(header(skipped.text), new RegExp(`^Triage · #${key} · \\d+ of ${total}$`));
  assert.ok(buttons(skipped).some((b) => b.callback_data === `t:c:${y}`), "the next one is Then me");
  const cancelled = await press(chatId, `t:c:${y}`, new Date(), false, skipped.text.replace(/<[^>]+>/g, ""));
  assert.equal((await row(y)).stateId, s.cancelled);
  const undo = data(cancelled, "Undo");
  assert.match(undo, /^u:/);
  await press(chatId, undo);
  assert.equal((await row(y)).stateId, backlog);
  assert.deepEqual((await row(y)).labelIds, [s.proposed]);
});

test("/triage #project counts a workspace-wide proposed label too (review of PLNR-358)", async () => {
  const { chatId } = await person();
  const other = f.refs.other;
  const wide = randomUUID();
  await db.insert(label).values({ id: wide, workspaceId: f.ws.workspaceId, projectId: null, name: "proposed", color: "#888888", position: 99_001 });
  const id = await newIssue(f.ws.agentId, { title: "Wide proposal" });
  await db.update(issue).set({ projectId: other.id, labelIds: [wide], stateId: f.refs.otherStates.find((s) => s.group === "backlog")!.id }).where(eq(issue.id, id));
  const page = await say(chatId, { text: `/triage #${other.key.toLowerCase()}` });
  assert.doesNotMatch(page.text, /no proposed label/);
  assert.match(page.text, /Wide proposal|of \d+/);
});

test("a card lists up to three similar open issues under the excerpt; the proposal itself, closed and unrelated ones are not in it (PLNR-295)", async () => {
  const { chatId } = await person();
  const states = f.refs.states;
  const open = states.find((s) => s.group === "backlog")!.id;
  const done = states.find((s) => s.group === "completed")!.id;
  const issueKey = async (id: string) => `${f.refs.project.key}-${(await row(id)).number}`;
  const near = await newIssue(f.ws.agentId, { title: "Gazebo roof leaks above the north door <b>", stateId: open });
  const nearer = await newIssue(f.ws.agentId, { title: "Gazebo roof leaks above the north door", stateId: open });
  const closed = await newIssue(f.ws.agentId, { title: "Gazebo roof leaks above the north door!", stateId: done });
  await newIssue(f.ws.agentId, { title: "Quartz clock drifts by a minute", stateId: open });
  const s = await fixture();
  const id = await newIssue(f.ws.agentId, { title: "Gazebo roof leaks over the north door", labelIds: [s.proposed], stateId: open });
  await db.update(issue).set({ createdAt: "2000-01-01T00:00:00.000Z" }).where(eq(issue.id, id));

  const card = await say(chatId, { text: `/triage #${f.refs.project.key.toLowerCase()}` });
  const lines = card.text.split("\n");
  const similar = lines.find((l) => l.startsWith("Similar: "))!;
  assert.ok(similar, card.text);
  assert.equal(lines.indexOf(similar) + 1, lines.findIndex((l) => l.startsWith("Proposed by")), "the line before who proposed it");
  assert.equal(similar, `Similar: ${await issueKey(nearer)} Gazebo roof leaks above the north door, ${await issueKey(near)} Gazebo roof leaks above the north door &lt;b&gt;`);
  assert.ok(!similar.includes(await issueKey(id)), "not the proposal itself");
  assert.ok(!similar.includes(await issueKey(closed)), "not a finished issue");
  assert.ok(!similar.includes("Quartz"), "not another subject");
});
