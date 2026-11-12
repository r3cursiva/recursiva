import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { NOTIFY_DEFAULTS, type NotifyPrefs, type NotifySettingsView } from "@rsva/protocol";
import { and, eq } from "drizzle-orm";
import type { Mail } from "../auth/mail.ts";
import { db, schema } from "../db.ts";
import { writeMarks } from "../sync/inbox.ts";
import { addMember, asUser, fetchAs } from "../test/helpers.ts";
import { follow } from "./follow.ts";
import { notifyFixture, quietAround, setPrefs } from "./fixture.ts";
import { sendDue } from "./send.ts";

const { notifyOutbox, accountSettings } = schema;
const ORIGIN = "https://plan.example.test";

const { f, tx, newIssue } = notifyFixture();
const started = () => f.refs.states.filter((s) => s.group === "started");
const outbox = (userId: string, issueId: string) => db.select().from(notifyOutbox).where(and(eq(notifyOutbox.userId, userId), eq(notifyOutbox.issueId, issueId)));
const until = (now: Date, ms: number) => new Date(now.getTime() + ms);
/** A new member, an issue just assigned to them, and the notifier's pass over it. */
async function assignedToNewMember() {
  const me = await addMember(f.ws.workspaceId, "member");
  const id = await newIssue(f.ws.ownerId);
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [me.id] } }]);
  const now = new Date();
  await follow(f.ws.workspaceId, now);
  return { me, id, now };
}

test("an assignment is mailed ten minutes later, threaded under its issue", async () => {
  const { me, id, now } = await assignedToNewMember();
  const [row] = await outbox(me.id, id);
  assert.equal(row!.kind, "assigned");
  assert.equal(row!.event, "assigned");
  assert.equal(Date.parse(row!.dueAt), now.getTime() + 10 * 60_000);

  const mails: Mail[] = [];
  // Their mails only: sendDue sends whatever is due in the outbox, and test files running beside this one fill it too.
  const mine = () => mails.filter((m) => m.to === me.email);
  await sendDue(async (m) => void mails.push(m), ORIGIN, until(now, 60_000), f.ws.workspaceId);
  assert.equal(mine().length, 0, "not before it is due");
  await sendDue(async (m) => void mails.push(m), ORIGIN, until(now, 11 * 60_000), f.ws.workspaceId);
  assert.equal(mine().length, 1);
  assert.match(mine()[0]!.subject, new RegExp(`^\\[${f.refs.project.key}-\\d+\\] Rotate the edge nodes$`));
  assert.match(mine()[0]!.text, /assigned .* to you/);
  assert.equal(mine()[0]!.headers!.References, `<rsva.issue.${id}@plan.example.test>`);
  assert.match(mine()[0]!.text, new RegExp(`${ORIGIN}/${f.ws.slug}/browse/${f.refs.project.key}-\\d+`));
  assert.equal((await outbox(me.id, id))[0]!.status, "sent");
});

test("read in the app within the wait, it is not mailed", async () => {
  const me = await addMember(f.ws.workspaceId, "member");
  const id = await newIssue(f.ws.ownerId);
  const r = await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [me.id] } }]);
  const now = new Date();
  await follow(f.ws.workspaceId, now);
  await writeMarks(f.ws.workspaceId, me.id, [{ issueId: id, readId: r.s, archivedId: 0, snoozedId: 0, snoozedUntil: null }]);
  const mails: Mail[] = [];
  await sendDue(async (m) => void mails.push(m), ORIGIN, until(now, 11 * 60_000), f.ws.workspaceId);
  assert.equal(mails.filter((m) => m.to === me.email).length, 0);
  assert.equal((await outbox(me.id, id))[0]!.status, "seen");
});

test("a row turned off sends nothing; the actor, an agent and a guest get nothing", async () => {
  const me = await addMember(f.ws.workspaceId, "member");
  const guest = await addMember(f.ws.workspaceId, "guest");
  await setPrefs(me.id, { ...NOTIFY_DEFAULTS, rules: { assigned: { email: "off" } } });
  const id = await newIssue(f.ws.ownerId);
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [me.id, f.ws.ownerId, f.ws.agentId, guest.id] } }]);
  await follow(f.ws.workspaceId);
  assert.deepEqual(await outbox(me.id, id), []);
  assert.deepEqual(await outbox(guest.id, id), []);
  assert.deepEqual(await outbox(f.ws.ownerId, id), []);
  assert.deepEqual(await outbox(f.ws.agentId, id), []);
});

test("a review asked by an agent is the plan row; quiet hours hold it, an urgent issue gets through", async () => {
  const me = await addMember(f.ws.workspaceId, "member");
  const now = new Date();
  await setPrefs(me.id, { ...NOTIFY_DEFAULTS, seen: false, quiet: quietAround(now) }, "UTC");
  const quiet = await newIssue(me.id);
  const urgent = await newIssue(me.id, { priority: 1 });
  await tx(f.ws.agentId, [{ op: "update", m: "Issue", id: quiet, set: { stateId: started()[1]!.id } }]);
  await tx(f.ws.agentId, [{ op: "update", m: "Issue", id: urgent, set: { stateId: started()[1]!.id } }]);
  await follow(f.ws.workspaceId, now);
  const [held] = await outbox(me.id, quiet);
  const [through] = await outbox(me.id, urgent);
  assert.equal(held!.event, "plan");
  assert.ok(Date.parse(held!.dueAt) > now.getTime() + 23 * 3_600_000, "held to the end of quiet hours");
  assert.equal(Date.parse(through!.dueAt), now.getTime(), "urgent goes at once");
});

test("a workspace set to Only about me drops what is not addressed to the person", async () => {
  const me = await addMember(f.ws.workspaceId, "member");
  await setPrefs(me.id, { ...NOTIFY_DEFAULTS, rules: { comment: { email: "now" } }, workspaces: { [f.ws.workspaceId]: "me" } });
  const id = await newIssue(me.id);
  await tx(f.ws.ownerId, [{ op: "create", m: "Comment", id: randomUUID(), set: { issueId: id, body: "Looks fine" } }]);
  await follow(f.ws.workspaceId);
  assert.deepEqual(await outbox(me.id, id), []);
  // The same comment with the workspace on Everything is mailed.
  await setPrefs(me.id, { ...NOTIFY_DEFAULTS, rules: { comment: { email: "now" } } });
  await tx(f.ws.ownerId, [{ op: "create", m: "Comment", id: randomUUID(), set: { issueId: id, body: "And this one" } }]);
  await follow(f.ws.workspaceId);
  assert.deepEqual((await outbox(me.id, id)).map((r) => r.kind), ["comment"]);
});

test("settings saved before the Email page read as they were, with its defaults", async () => {
  const me = await addMember(f.ws.workspaceId, "member");
  const { email: _e, digest: _d, weekly: _w, ...before } = { ...NOTIFY_DEFAULTS, rules: { assigned: { email: "off" as const } } };
  await db.insert(accountSettings).values({ userId: me.id, notifications: before });
  const view = (await (await fetchAs(await asUser(me.id))(`${f.server.url}/auth/notifications`)).json()) as NotifySettingsView;
  assert.deepEqual(view.prefs.rules, { assigned: { email: "off" } });
  assert.deepEqual(view.prefs.digest, NOTIFY_DEFAULTS.digest);
});

test("the settings round-trip and are checked", async () => {
  const me = await addMember(f.ws.workspaceId, "member");
  const put = (body: unknown) =>
    fetchAs({})(`${f.server.url}/auth/notifications`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const as = async (body: unknown) =>
    fetchAs(await asUser(me.id))(`${f.server.url}/auth/notifications`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await put(NOTIFY_DEFAULTS)).status, 401);
  const prefs: NotifyPrefs = { ...NOTIFY_DEFAULTS, rules: { comment: { email: "now" } }, quiet: { from: "23:00", to: "07:30" } };
  assert.equal((await as(prefs)).status, 200);
  const view = (await (await fetchAs(await asUser(me.id))(`${f.server.url}/auth/notifications`)).json()) as NotifySettingsView;
  assert.deepEqual(view.prefs, prefs);
  assert.deepEqual(view.workspaces.map((w) => w.slug), [f.ws.slug]);
  for (const bad of [{ ...prefs, quiet: { from: "25:00", to: "07:00" } }, { ...prefs, rules: { nope: { email: "now" } } }, { ...prefs, rules: { comment: { email: "later" } } }, { ...prefs, digest: { ...NOTIFY_DEFAULTS.digest, days: [1, 1] } }]) {
    assert.equal((await as(bad)).status, 400, JSON.stringify(bad));
  }
});

test("assigned and moved on before the notifier reads it, the first assignee still hears of it, as in the inbox", async () => {
  const [z, w] = [await addMember(f.ws.workspaceId, "member"), await addMember(f.ws.workspaceId, "member")];
  const id = await newIssue(f.ws.ownerId);
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [z.id] } }]);
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [w.id] } }]);
  await follow(f.ws.workspaceId);
  assert.deepEqual((await outbox(z.id, id)).map((r) => r.kind), ["assigned"]);
  assert.deepEqual((await outbox(w.id, id)).map((r) => r.kind), ["assigned"]);
});

test("a failing mail service is tried again later and later, then given up; a stale row is dropped", async () => {
  const { me, id, now } = await assignedToNewMember();
  const down = async () => {
    throw new Error("Resend answered HTTP 503");
  };
  let at = until(now, 11 * 60_000);
  await sendDue(down, ORIGIN, at, f.ws.workspaceId);
  const [first] = await outbox(me.id, id);
  assert.equal(first!.status, "pending");
  assert.equal(first!.attempts, 1);
  assert.equal(Date.parse(first!.dueAt), at.getTime() + 5 * 60_000);
  at = new Date(Date.parse(first!.dueAt));
  await sendDue(down, ORIGIN, at, f.ws.workspaceId);
  const [second] = await outbox(me.id, id);
  assert.equal(Date.parse(second!.dueAt), at.getTime() + 10 * 60_000, "the wait doubles");
  // The last try gives up.
  await db.update(notifyOutbox).set({ attempts: 7 }).where(eq(notifyOutbox.id, second!.id));
  await sendDue(down, ORIGIN, until(at, 3 * 3_600_000), f.ws.workspaceId);
  assert.equal((await outbox(me.id, id))[0]!.status, "failed");

  // A row two days old (a restored copy, a long stop) is not sent.
  const other = await newIssue(f.ws.ownerId);
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id: other, set: { assigneeIds: [me.id] } }]);
  await follow(f.ws.workspaceId, now);
  const mails: Mail[] = [];
  await sendDue(async (m) => void mails.push(m), ORIGIN, until(now, 49 * 3_600_000), f.ws.workspaceId);
  assert.equal(mails.filter((m) => m.to === me.email).length, 0);
  assert.equal((await outbox(me.id, other))[0]!.status, "dropped");
});
