import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { after, before, test } from "node:test";
import type { InboxEvent, InboxFrame, MarksFrame, Op } from "@rsva/protocol";
import { addMember, asToken, asUser, Client, delay, importFixture, issueWithRefs, lastSyncId, startServer, type Fixture } from "../test/helpers.ts";
import { fromMarkdown } from "@rsva/editor/markdown";
import type { DocJSON } from "@rsva/schema/models";
import { db, schema } from "../db.ts";
import { readInbox, writeMarks } from "./inbox.ts";
import { applyTx } from "./write.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let ws: Fixture;
let other: Fixture;
let refs: Awaited<ReturnType<typeof issueWithRefs>>;
let mate: { id: string };
const clients: Client[] = [];
before(async () => {
  [server, ws, other] = await Promise.all([startServer(), importFixture(), importFixture()]);
  refs = await issueWithRefs(ws.workspaceId);
  mate = await addMember(ws.workspaceId, "member");
});
after(async () => {
  for (const c of clients) c.close();
  await server.close();
});

const tx = (actor: string, ops: Op[]) => applyTx(ws.workspaceId, actor, randomUUID(), ops);
const started = () => refs.states.filter((s) => s.group === "started");
/** A fresh issue created by `creator`, so earlier tests don't leak events into it. */
async function newIssue(creator: string): Promise<string> {
  const id = randomUUID();
  await tx(creator, [{ op: "create", m: "Issue", id, projectId: refs.project.id, set: { title: "inbox test", stateId: refs.states[0]!.id } }]);
  return id;
}
const eventsOf = async (me: string, issueId: string): Promise<InboxEvent[]> => (await readInbox(ws.workspaceId, me)).e.filter((e) => e.issueId === issueId);

test("assignments, review requests and state changes reach the people involved, never the actor", async () => {
  const id = await newIssue(ws.ownerId);
  await tx(ws.agentId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [mate.id] } }]);
  await tx(ws.agentId, [{ op: "update", m: "Issue", id, set: { stateId: started()[1]!.id } }]); // In Review
  await tx(mate.id, [{ op: "update", m: "Issue", id, set: { stateId: started()[2]!.id } }]); // Approved, by the assignee
  await tx(ws.ownerId, [{ op: "update", m: "Issue", id, set: { stateId: started()[0]!.id } }]); // the owner's own move

  assert.deepEqual((await eventsOf(mate.id, id)).map((e) => e.kind), ["assigned", "state", "state"]);
  const owner = await eventsOf(ws.ownerId, id);
  assert.deepEqual(owner.map((e) => e.kind), ["review", "state"]);
  assert.equal(owner[0]!.stateId, started()[1]!.id);
  assert.equal(owner[0]!.by, ws.agentId);
  // The agent is not involved: none of it is its business.
  assert.deepEqual(await eventsOf(ws.agentId, id), []);
});

test("Done out of a review is not news to who reviews; out of approval, to nobody; past the review it is (RSVA-574)", async () => {
  const done = refs.states.find((s) => s.group === "completed")!.id;
  const kinds = async (me: string, id: string) => (await eventsOf(me, id)).map((e) => e.kind);

  // The owner created it and reviews it; the teammate did the work. Merged straight out of review.
  const merged = await newIssue(ws.ownerId);
  await tx(ws.ownerId, [{ op: "update", m: "Issue", id: merged, set: { assigneeIds: [mate.id] } }]);
  await tx(mate.id, [{ op: "update", m: "Issue", id: merged, set: { stateId: started()[1]!.id } }]);
  await tx(ws.agentId, [{ op: "update", m: "Issue", id: merged, set: { stateId: done } }]);
  assert.deepEqual(await kinds(ws.ownerId, merged), ["review"], "the reviewer is not told it is done");
  assert.deepEqual(await kinds(mate.id, merged), ["assigned", "state"], "whose work it was hears it was accepted");

  // An agent's issue: the owner manages the workspace, so the review is theirs too.
  const agents = await newIssue(ws.agentId);
  await tx(ws.ownerId, [{ op: "create", m: "Comment", id: randomUUID(), set: { issueId: agents, body: "looking" } }]);
  await tx(ws.agentId, [{ op: "update", m: "Issue", id: agents, set: { stateId: started()[1]!.id } }]);
  await tx(ws.agentId, [{ op: "update", m: "Issue", id: agents, set: { stateId: done } }]);
  assert.deepEqual((await eventsOf(ws.ownerId, agents)).map((e) => [e.kind, e.stateId]), [["state", started()[1]!.id]], "into review, and no Done for the manager who reviews it");

  // Approved, then done: the approval was the news.
  const approved = await newIssue(ws.ownerId);
  await tx(ws.ownerId, [{ op: "update", m: "Issue", id: approved, set: { assigneeIds: [mate.id] } }]);
  await tx(ws.ownerId, [{ op: "update", m: "Issue", id: approved, set: { stateId: started()[2]!.id } }]);
  await tx(ws.agentId, [{ op: "update", m: "Issue", id: approved, set: { stateId: done } }]);
  assert.deepEqual(await kinds(mate.id, approved), ["assigned", "approved"]);

  // Closed past the review: news to its creator.
  const closed = await newIssue(ws.ownerId);
  await tx(ws.agentId, [{ op: "update", m: "Issue", id: closed, set: { stateId: done } }]);
  assert.deepEqual(await kinds(ws.ownerId, closed), ["state"]);
});

test("a move to another project tells nobody of a state change: it maps the state, it does not step it (PLNR-448)", async () => {
  const id = await newIssue(ws.ownerId);
  await tx(ws.ownerId, [{ op: "update", m: "Issue", id, set: { stateId: started()[1]!.id } }]); // In Review, the owner's own
  await tx(mate.id, [{ op: "update", m: "Issue", id, set: { projectId: refs.other.id } }]);
  const [moved] = await db.select({ projectId: schema.issue.projectId, stateId: schema.issue.stateId }).from(schema.issue).where(eq(schema.issue.id, id));
  assert.equal(moved!.projectId, refs.other.id);
  assert.deepEqual(await eventsOf(ws.ownerId, id), [], "no review request from the move");
});

test("approval tells the assignee; comments reach the involved, replies the people in the thread", async () => {
  const id = await newIssue(ws.ownerId);
  await tx(ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [mate.id] } }]);
  await tx(ws.ownerId, [{ op: "update", m: "Issue", id, set: { stateId: started()[2]!.id } }]);
  const root = randomUUID();
  await tx(mate.id, [{ op: "create", m: "Comment", id: root, set: { issueId: id, body: "done, deploying" } }]);
  const reply = randomUUID();
  await tx(ws.agentId, [{ op: "create", m: "Comment", id: reply, set: { issueId: id, parentId: root, body: "deploy finished" } }]);

  assert.deepEqual((await eventsOf(mate.id, id)).map((e) => [e.kind, e.commentId ?? null]), [["assigned", null], ["approved", null], ["reply", reply]]);
  assert.deepEqual((await eventsOf(ws.ownerId, id)).map((e) => [e.kind, e.commentId]), [["comment", root], ["comment", reply]]);
  const inbox = await readInbox(ws.workspaceId, mate.id);
  assert.ok(inbox.c.includes(id) && inbox.th.includes(root));
});

test("marks go to every socket of the viewer and only to theirs; a warm request gets only newer marks", async () => {
  const id = await newIssue(ws.ownerId);
  await tx(ws.agentId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [ws.ownerId] } }]);
  const open = async (user: string) => {
    const c = await Client.open(server.url, await asUser(user));
    clients.push(c);
    return c.subscribe(ws);
  };
  const [a, b, someoneElse] = await Promise.all([open(ws.ownerId), open(ws.ownerId), open(mate.id)]);

  a.send({ t: "inbox" });
  const full = (await a.next((f) => f.t === "inbox")) as InboxFrame;
  const e = full.e.find((x) => x.issueId === id)!;
  assert.equal(e.kind, "assigned");

  const mark = { issueId: id, readId: e.id, archivedId: 0, snoozedId: 0, snoozedUntil: null };
  a.send({ t: "mark", m: [mark] });
  const [ma, mb] = (await Promise.all([a.next((f) => f.t === "marks"), b.next((f) => f.t === "marks")])) as MarksFrame[];
  assert.deepEqual(ma!.m, [mark]);
  assert.deepEqual(mb, ma);

  // Nothing changed after `at`: no answer at all. A mark after it comes back on the next request.
  b.send({ t: "inbox", at: ma!.at });
  await delay(100);
  assert.equal(b.frames.filter((f) => f.t === "marks").length, 1);
  a.send({ t: "mark", m: [{ ...mark, archivedId: e.id }] });
  await a.next((f) => f.t === "marks" && f.m[0]!.archivedId === e.id);
  b.send({ t: "inbox", at: ma!.at });
  const later = (await b.next((f) => f.t === "marks" && f.at > ma!.at)) as MarksFrame;
  assert.equal(later.m[0]!.archivedId, e.id);
  assert.equal(someoneElse.frames.filter((f) => f.t === "marks").length, 0);

  // A snooze comes back in ISO 8601, so that the client can send the mark again as it is (RSVA-565).
  const until = "2026-11-06T15:31:24.325Z";
  a.send({ t: "mark", m: [{ ...mark, snoozedId: e.id, snoozedUntil: until }] });
  const snoozed = (await a.next((f) => f.t === "marks" && f.m[0]!.snoozedUntil !== null)) as MarksFrame;
  assert.equal(snoozed.m[0]!.snoozedUntil, until);
  a.send({ t: "mark", m: [{ ...snoozed.m[0]!, readId: e.id + 1 }] });
  const again = (await a.next((f) => f.t === "marks" && f.m[0]!.readId === e.id + 1)) as MarksFrame;
  assert.equal(again.m[0]!.snoozedUntil, until);
  assert.equal((await readInbox(ws.workspaceId, ws.ownerId)).m.find((x) => x.issueId === id)!.snoozedUntil, until);
  assert.equal(a.frames.filter((f) => f.t === "rej").length, 0);

  // An issue of another workspace cannot be marked from this one.
  const foreign = (await issueWithRefs(other.workspaceId)).issue;
  a.send({ t: "mark", m: [{ ...mark, issueId: foreign.id }] });
  const rej = await a.next((f) => f.t === "rej");
  assert.deepEqual([(rej as { code: string }).code, (rej as { id: string }).id], ["invalid", "mark"]);
  // Two marks of one issue in one frame: refused, and the connection stays usable.
  a.send({ t: "mark", m: [mark, mark] });
  await a.next((f) => f.t === "rej" && f.msg.includes("twice"));
  a.send({ t: "mark", m: [mark] });
  await a.next((f) => f.t === "marks" && f.m[0]!.archivedId === 0);
});

test("a read-only token reads its inbox but cannot set marks", async () => {
  const id = await newIssue(ws.ownerId);
  await tx(ws.agentId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [ws.ownerId] } }]);
  const c = await Client.open(server.url, await asToken(ws.workspaceId, ws.ownerId, "read"));
  clients.push(c);
  await c.subscribe(ws);
  c.send({ t: "inbox" });
  const e = ((await c.next((f) => f.t === "inbox")) as InboxFrame).e.find((x) => x.issueId === id)!;
  c.send({ t: "mark", m: [{ issueId: id, readId: e.id, archivedId: e.id, snoozedId: 0, snoozedUntil: null }] });
  const rej = await c.next((f) => f.t === "rej");
  assert.deepEqual([(rej as { code: string }).code, (rej as { id: string }).id], ["forbidden", "mark"]);
  assert.equal((await readInbox(ws.workspaceId, ws.ownerId)).m.find((m) => m.issueId === id), undefined);
});

test("the log is read as each action found the issue: no events from before the viewer was involved", async () => {
  // Someone commented before the teammate did: not their business then. A comment after theirs is.
  const id = await newIssue(ws.ownerId);
  await tx(ws.agentId, [{ op: "create", m: "Comment", id: randomUUID(), set: { issueId: id, body: "first" } }]);
  await tx(mate.id, [{ op: "create", m: "Comment", id: randomUUID(), set: { issueId: id, body: "mine" } }]);
  const later = randomUUID();
  await tx(ws.agentId, [{ op: "create", m: "Comment", id: later, set: { issueId: id, body: "after" } }]);
  assert.deepEqual((await eventsOf(mate.id, id)).map((e) => [e.kind, e.commentId]), [["comment", later]]);

  // Approved before they were assigned: an assignment, not an approval of their work.
  const other = await newIssue(ws.ownerId);
  await tx(ws.ownerId, [{ op: "update", m: "Issue", id: other, set: { stateId: started()[2]!.id } }]);
  await tx(ws.ownerId, [{ op: "update", m: "Issue", id: other, set: { assigneeIds: [mate.id] } }]);
  assert.deepEqual((await eventsOf(mate.id, other)).map((e) => e.kind), ["assigned"]);
});

test("imported actions (no actor) make no notifications", async () => {
  const id = await newIssue(ws.ownerId);
  const r = await tx(ws.agentId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [ws.ownerId], stateId: started()[1]!.id } }]);
  await db.update(schema.syncAction).set({ actorId: null }).where(and(eq(schema.syncAction.workspaceId, ws.workspaceId), eq(schema.syncAction.id, r.s)));
  assert.deepEqual(await eventsOf(ws.ownerId, id), []);
});

test("mentions reach the person mentioned, involved or not, once per new mention: comments, edits, descriptions", async () => {
  const at = (u: { id: string }, name = "x") => `[@${name}](mention:${u.id})`;
  const owner = { id: ws.ownerId };
  const stranger = randomUUID(); // not a member: stays in the text, notifies nobody
  const id = await newIssue(ws.ownerId);

  // The teammate is not involved; the owner created the issue, so a mention replaces their "comment".
  const c = randomUUID();
  await tx(ws.agentId, [{ op: "create", m: "Comment", id: c, set: { issueId: id, body: `${at(mate)} and ${at(owner)} and ${at({ id: stranger })}` } }]);
  assert.deepEqual((await eventsOf(mate.id, id)).map((e) => [e.kind, e.commentId]), [["mention", c]]);
  assert.deepEqual((await eventsOf(ws.ownerId, id)).map((e) => [e.kind, e.commentId]), [["mention", c]]);
  const [created] = await db.select({ d: schema.syncAction.data }).from(schema.syncAction).where(and(eq(schema.syncAction.modelId, c), eq(schema.syncAction.action, "I")));
  assert.deepEqual((created!.d as { mentionIds: string[] }).mentionIds, [mate.id, ws.ownerId]);

  // An edit notifies only whom it adds; the agent's own mention of itself notifies nobody.
  const solo = randomUUID();
  await tx(ws.ownerId, [{ op: "create", m: "Comment", id: solo, set: { issueId: id, body: "plain" } }]);
  await tx(ws.ownerId, [{ op: "update", m: "Comment", id: solo, set: { body: `plain, cc ${at(mate)}` } }]);
  await tx(ws.ownerId, [{ op: "update", m: "Comment", id: solo, set: { body: `plain, cc ${at(mate)} again` } }]);
  assert.deepEqual((await eventsOf(mate.id, id)).map((e) => [e.kind, e.commentId]), [["mention", c], ["mention", solo]]);

  // The description: a mention when it first appears, not on every later save.
  const doc = (md: string) => fromMarkdown(md) as DocJSON;
  await tx(ws.agentId, [{ op: "update", m: "Document", id, set: { doc: doc(`over to ${at(mate)}`) } }]);
  await tx(ws.agentId, [{ op: "update", m: "Document", id, set: { doc: doc(`over to ${at(mate)}, thanks`) } }]);
  const events = await eventsOf(mate.id, id);
  assert.deepEqual(events.map((e) => [e.kind, e.commentId ?? null]), [["mention", c], ["mention", solo], ["mention", null]]);
  assert.equal(events[2]!.by, ws.agentId);
  // The owner's own comment does not count them as commenting on someone else's mention, nor notify them.
  assert.deepEqual((await eventsOf(ws.ownerId, id)).map((e) => e.kind), ["mention"]);
});

test("Subscribe brings state changes and comments from its log number on; Unsubscribe stops them, not what is addressed to the viewer", async () => {
  const id = await newIssue(ws.ownerId);
  const choose = async (user: string, subscribed: boolean) =>
    writeMarks(ws.workspaceId, user, [{ issueId: id, readId: 0, archivedId: 0, snoozedId: 0, snoozedUntil: null, subscribed, subscribedId: await lastSyncId(ws.workspaceId) }]);
  const comment = async (body: string) => {
    const c = randomUUID();
    await tx(ws.agentId, [{ op: "create", m: "Comment", id: c, set: { issueId: id, body } }]);
    return c;
  };
  const kinds = async (user: string) => (await eventsOf(user, id)).map((e) => [e.kind, e.commentId ?? null]);

  // The teammate is not involved: subscribing brings what comes after, not what came before.
  const before = await comment("before");
  await choose(mate.id, true);
  const after = await comment("after");
  await tx(ws.agentId, [{ op: "update", m: "Issue", id, set: { stateId: started()[0]!.id } }]);
  assert.deepEqual(await kinds(mate.id), [["comment", after], ["state", null]]);

  // The creator unsubscribes: what came before stays, comments and state changes after stop, a review and a mention come.
  await choose(ws.ownerId, false);
  await comment("quiet");
  await tx(ws.agentId, [{ op: "update", m: "Issue", id, set: { stateId: started()[1]!.id } }]);
  const mention = await comment(`[@x](mention:${ws.ownerId})`);
  assert.deepEqual(await kinds(ws.ownerId), [["comment", before], ["comment", after], ["state", null], ["review", null], ["mention", mention]]);

  // A mark from a shell that knows no subscriptions keeps the one stored.
  const { m } = await writeMarks(ws.workspaceId, ws.ownerId, [{ issueId: id, readId: 1, archivedId: 0, snoozedId: 0, snoozedUntil: null }]);
  assert.equal(m[0]!.subscribed, false);
  const stored = (await readInbox(ws.workspaceId, ws.ownerId)).m.find((x) => x.issueId === id)!;
  assert.deepEqual([stored.readId, stored.subscribed], [1, false]);
  // No choice: no subscription fields on the wire.
  const plain = await newIssue(ws.ownerId);
  const { m: [fresh] } = await writeMarks(ws.workspaceId, mate.id, [{ issueId: plain, readId: 1, archivedId: 0, snoozedId: 0, snoozedUntil: null }]);
  assert.deepEqual(fresh, { issueId: plain, readId: 1, archivedId: 0, snoozedId: 0, snoozedUntil: null });
});
