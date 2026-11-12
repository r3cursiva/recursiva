import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import type { Op } from "@rsva/protocol";
import { TITLE_MAX } from "@rsva/schema/models";
import { and, eq, sql } from "drizzle-orm";
import type { WebSocket } from "ws";
import { db, schema } from "../db.ts";
import { addMember, importFixture, issueWithRefs, lastSyncId, rejects, type Fixture } from "../test/helpers.ts";
import { snapshot } from "./bootstrap.ts";
import { subscribe } from "./hub.ts";
import { onMembershipChange } from "./membership.ts";
import { applyServerChange, applyTx } from "./write.ts";

const { issue, syncAction, appliedTx, project } = schema;

let ws: Fixture;
let refs: Awaited<ReturnType<typeof issueWithRefs>>;
before(async () => {
  ws = await importFixture();
  refs = await issueWithRefs(ws.workspaceId);
});

const update = (id: string, set: Extract<Op, { op: "update"; m: "Issue" }>["set"]): Op[] => [{ op: "update", m: "Issue", id, set }];
const tx = (ops: Op[] | unknown, txId = randomUUID()) => applyTx(ws.workspaceId, ws.ownerId, txId, ops);
const actionsOf = (txId: string) => db.select().from(syncAction).where(eq(syncAction.txId, txId));

test("50 parallel transactions from several clients get exactly s+1..s+50", async () => {
  const issues = await db.select({ id: issue.id }).from(issue).where(eq(issue.workspaceId, ws.workspaceId)).limit(50);
  const s0 = await lastSyncId(ws.workspaceId);
  // Five "clients", each with its own actor; every transaction changes a different issue's title.
  const actors = [ws.ownerId, ws.agentId];
  const results = await Promise.all(
    issues.map((row, n) => applyTx(ws.workspaceId, actors[n % 2]!, randomUUID(), update(row.id, { title: `parallel ${n} ${randomUUID()}` }))),
  );
  const got = results.map((r) => r.s).sort((a, b) => a - b);
  assert.deepEqual(got, Array.from({ length: 50 }, (_, i) => s0 + 1 + i));
  const log = await db.select({ id: syncAction.id }).from(syncAction).where(eq(syncAction.workspaceId, ws.workspaceId));
  const ids = log.map((a) => a.id).filter((id) => id > s0).sort((a, b) => a - b);
  assert.deepEqual(ids, got);
  assert.equal(await lastSyncId(ws.workspaceId), s0 + 50);
});

test("overlapping bulk edits sent in opposite orders, and a parent change racing an edit, all commit", async () => {
  // Before: rows were locked in the order of the ops, and a parent change locked the workspace row in the middle of the
  // transaction, so these pairs deadlocked and Postgres aborted one of each (40P01): that person's edit was lost.
  const rows = await db.select({ id: issue.id }).from(issue).where(eq(issue.projectId, refs.project.id)).orderBy(issue.number).limit(12);
  const ids = rows.map((r) => r.id);
  const [parent, ...rest] = ids;
  const runs: Promise<unknown>[] = [];
  for (let round = 0; round < 6; round++) {
    const bulk = rest.flatMap((id) => update(id, { priority: round % 4 }));
    runs.push(tx(bulk), tx([...bulk].reverse()));
    const [x, y] = [rest[round]!, rest[round + 1]!];
    runs.push(tx([...update(x, { parentId: parent! }), ...update(y, { title: `raced ${round}` })]), tx(update(y, { title: `racer ${round}` })));
  }
  const results = await Promise.allSettled(runs);
  const failed = results.flatMap((r) => (r.status === "rejected" ? [String((r.reason as Error).cause ?? r.reason)] : []));
  assert.deepEqual(failed, []);
});

test("descriptions saved in opposite orders, and a save racing an edit of its issue, all commit", async () => {
  const rows = await db.select({ id: issue.id }).from(issue).where(eq(issue.projectId, refs.project.id)).orderBy(issue.number).limit(2);
  const [a, b] = rows.map((r) => r.id) as [string, string];
  const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  const save = (id: string, text: string): Op => ({ op: "update", m: "Document", id, set: { doc: doc(text) } });
  // Both documents exist first: their rows are what the saves lock.
  await tx([save(a, "a0"), save(b, "b0")]);
  const runs: Promise<unknown>[] = [];
  for (let round = 0; round < 4; round++) {
    runs.push(tx([save(a, `a${round}`), save(b, `b${round}`)]), tx([save(b, `B${round}`), save(a, `A${round}`)]));
    // The save locks the document, then writes the issue; the edit had the issue, then wanted the document.
    runs.push(tx([save(a, `alone ${round}`)]), tx([...update(a, { priority: round % 4 }), save(a, `with edit ${round}`)]));
  }
  const results = await Promise.allSettled(runs);
  assert.deepEqual(results.flatMap((r) => (r.status === "rejected" ? [String((r.reason as Error).cause ?? r.reason)] : [])), []);
});

test("a deadlock the lock order leaves (comments edited in opposite orders) is retried, and both edits commit", async () => {
  const [c1, c2] = [randomUUID(), randomUUID()];
  const comment = (id: string, body: string): Op => ({ op: "create", m: "Comment", id, set: { issueId: refs.issue.id, body } });
  const edit = (id: string, body: string): Op => ({ op: "update", m: "Comment", id, set: { body } });
  await tx([comment(c1, "one"), comment(c2, "two")]);
  // A pair at a time, as two people would: Postgres aborts one of a deadlocked pair and the retry runs it again.
  for (let round = 0; round < 6; round++) {
    const pair = await Promise.allSettled([tx([edit(c1, `x${round}`), edit(c2, `y${round}`)]), tx([edit(c2, `Y${round}`), edit(c1, `X${round}`)])]);
    assert.deepEqual(pair.flatMap((r) => (r.status === "rejected" ? [String((r.reason as Error).cause ?? r.reason)] : [])), [], `round ${round}`);
  }
});

test("a connection lost in the middle of a transaction: it runs again and writes once", async () => {
  const s0 = await lastSyncId(ws.workspaceId);
  let runs = 0;
  const r = await applyServerChange(ws.workspaceId, ws.ownerId, async (t) => {
    if (++runs === 1) await t.execute(sql`select pg_terminate_backend(pg_backend_pid())`);
    return [{ m: "Issue", mid: refs.issue.id, a: "U", d: { priority: 1 } }];
  });
  assert.equal(runs, 2);
  assert.equal(r.s, s0 + 1);
  assert.equal(await lastSyncId(ws.workspaceId), s0 + 1);
  // Without patches/postgres@3.4.9.patch the driver's rollback on the dead connection stops the process, and the next
  // query on that connection gets its FATAL. More queries than the pool has connections reach it.
  const rows = await Promise.all(Array.from({ length: 12 }, () => db.execute(sql`select 1 as one, pg_sleep(0.02)`)));
  assert.deepEqual(rows.map((r) => r.length), Array(12).fill(1));
});

for (const [name, write] of [
  ["a client transaction", () => tx(update(refs.issue.id, { title: randomUUID() }))],
  ["a server change", () => applyServerChange(ws.workspaceId, ws.ownerId, async () => [{ m: "Issue", mid: refs.issue.id, a: "U", d: { priority: 2 } }])],
] as const) {
  test(`${name} that committed but lost the answer: the next run is a replay, and the delta still goes out`, async (t) => {
    const s0 = await lastSyncId(ws.workspaceId);
    const sent: string[] = [];
    const leave = subscribe(ws.workspaceId, { ws: { send: (f: string) => sent.push(f) } as unknown as WebSocket, userId: ws.ownerId, buffer: null });
    t.after(leave);
    const real = db.transaction.bind(db);
    let runs = 0;
    const lost = Object.assign(new Error("closed"), { code: "CONNECTION_CLOSED" });
    t.mock.method(db, "transaction", async (...args: Parameters<typeof db.transaction>) => {
      const answer = await real(...args);
      if (++runs === 1) throw lost;
      return answer;
    });
    const r = await write();
    assert.equal(runs, 2);
    assert.equal(r.s, s0 + 1, "the first run's number");
    assert.deepEqual(r.actions.map((a) => a.id), [s0 + 1], "the first run's answer: the caller reads a new issue's number from it");
    assert.equal(await lastSyncId(ws.workspaceId), s0 + 1, "written once");
    assert.ok(sent.some((f) => (JSON.parse(f) as { a: { id: number }[] }).a.some((a) => a.id === s0 + 1)), "broadcast");
  });
}

test("a removal whose answer was lost for good: the client's resend closes the member's sockets, by the role they have now", async (t) => {
  const removed = await addMember(ws.workspaceId, "member");
  const heard: (string | null)[] = [];
  onMembershipChange((_, userId, role) => {
    if (userId === removed.id) heard.push(role);
  });
  const txId = randomUUID();
  const real = db.transaction.bind(db);
  const lost = Object.assign(new Error("closed"), { code: "CONNECTION_CLOSED" });
  const mock = t.mock.method(db, "transaction", async (...args: Parameters<typeof db.transaction>) => {
    if (mock.mock.callCount() === 0) await real(...args);
    throw lost;
  });
  const remove: Op[] = [{ op: "delete", m: "User", id: removed.id }];
  await assert.rejects(tx(remove, txId), /closed/);
  mock.mock.restore();
  assert.deepEqual(heard, [], "nothing ran after the commit");
  await tx(remove, txId);
  assert.deepEqual(heard, [null]);
  await db.insert(schema.member).values({ workspaceId: ws.workspaceId, userId: removed.id, role: "member" });
  await tx(remove, txId);
  assert.deepEqual(heard, [null, "member"], "back since: a late resend does not take them out");
  await db.delete(schema.member).where(eq(schema.member.userId, removed.id));
});

test("a replayed txId gets the same s and writes nothing, also while the original is running", async () => {
  const txId = randomUUID();
  // A change whatever the tests before left: a value equal to the row's writes no action to compare.
  const ops = update(refs.issue.id, { title: `replayed ${txId}` });
  // Sent twice at once: the second waits for the first and returns its answer.
  const [a, b] = await Promise.all([tx(ops, txId), tx(ops, txId)]);
  assert.equal(a.s, b.s);
  assert.deepEqual(b.actions.map((x) => x.id), a.actions.map((x) => x.id), "one action, in both answers");
  assert.equal((await actionsOf(txId)).length, 1);
  const s1 = await lastSyncId(ws.workspaceId);
  const c = await tx(ops, txId);
  assert.equal(c.s, a.s);
  assert.deepEqual(c.actions.map((x) => x.id), [a.s], "the first answer again");
  assert.equal(await lastSyncId(ws.workspaceId), s1);
  assert.equal((await actionsOf(txId)).length, 1);
});

test("references must stay in the issue's project and workspace", async () => {
  const other = await importFixture("sample", undefined, 2);
  const otherRefs = await issueWithRefs(other.workspaceId);
  const id = refs.issue.id;
  await rejects(tx(update(id, { stateId: refs.otherStates[0]!.id })), "bad_ref");
  await rejects(tx(update(id, { labelIds: [refs.otherLabels[0]!.id] })), "bad_ref");
  await rejects(tx(update(id, { labelIds: [otherRefs.labels[0]!.id] })), "bad_ref");
  await rejects(tx(update(id, { assigneeIds: [other.ownerId] })), "bad_ref");
  await rejects(tx(update(id, { delegateId: other.agentId })), "bad_ref");
  await rejects(tx(update(id, { parentId: otherRefs.issue.id })), "bad_ref");
  await rejects(tx(update(id, { parentId: id })), "bad_ref");
  await rejects(tx(update(randomUUID(), { title: "x" })), "not_found");
  await rejects(tx([{ op: "update", m: "Issue", id, set: { number: 5 } }]), "invalid");
  await rejects(tx([]), "invalid");
  await rejects(applyTx(ws.workspaceId, ws.ownerId, "not-a-uuid", update(id, { title: "x" })), "invalid");
  // The project's own label, a member as assignee and the agent as delegate pass.
  const r = await tx(update(id, { labelIds: [refs.labels[0]!.id], assigneeIds: [ws.ownerId], delegateId: ws.agentId }));
  assert.equal(r.actions.length, 1);
});

test("completedAt is set by completed and cancelled states, kept between them, cleared on reopen", async () => {
  const id = refs.issue.id;
  const state = (group: string) => refs.states.find((s) => s.group === group)!.id;
  const row = async () => (await db.select().from(issue).where(eq(issue.id, id)))[0]!;

  await tx(update(id, { stateId: state("started") }));
  assert.equal((await row()).completedAt, null);
  const done = await tx(update(id, { stateId: state("completed") }));
  const doneAt = (await row()).completedAt;
  assert.ok(doneAt);
  // The delta carries the stored value in the snapshot's format.
  assert.equal(done.actions[0]!.d!.completedAt, doneAt);
  assert.equal(done.actions[0]!.d!.updatedAt, (await row()).updatedAt);
  await tx(update(id, { stateId: state("cancelled") }));
  assert.equal((await row()).completedAt, doneAt);
  const reopened = await tx(update(id, { stateId: state("backlog") }));
  assert.equal((await row()).completedAt, null);
  assert.equal(reopened.actions[0]!.d!.completedAt, null);
});

test("leaving Backlog ends a proposal: the label goes, in the delta and the row, and only then", async () => {
  const [id] = (await db.select({ id: issue.id }).from(issue).where(and(eq(issue.projectId, refs.project.id), sql`${issue.id} <> ${refs.issue.id}`)).limit(1)).map((r) => r.id);
  const [other, proposed] = refs.labels;
  await db.update(schema.label).set({ name: "Proposed" }).where(eq(schema.label.id, proposed!.id));
  const state = (group: string) => refs.states.find((s) => s.group === group)!.id;
  const labels = async () => (await db.select({ labelIds: issue.labelIds }).from(issue).where(eq(issue.id, id!)))[0]!.labelIds;
  await tx(update(id!, { stateId: state("backlog"), labelIds: [other!.id, proposed!.id] }));

  await tx(update(id!, { title: "still a proposal" }));
  assert.deepEqual(await labels(), [other!.id, proposed!.id]);

  const txId = randomUUID();
  const left = await tx(update(id!, { stateId: state("unstarted") }), txId);
  assert.deepEqual(left.actions[0]!.d!.labelIds, [other!.id]);
  assert.deepEqual((await actionsOf(txId))[0]!.prev, { stateId: state("backlog"), labelIds: [other!.id, proposed!.id] });
  assert.deepEqual(await labels(), [other!.id]);

  // Back in Backlog, with the label on purpose: the undo of My work's Accept sends both.
  await tx(update(id!, { stateId: state("backlog"), labelIds: [other!.id, proposed!.id] }));
  assert.deepEqual(await labels(), [other!.id, proposed!.id]);
  await tx(update(id!, { stateId: state("cancelled"), labelIds: [proposed!.id] }));
  assert.deepEqual(await labels(), []);
  // Past Backlog a person may put the label back: only leaving takes it off.
  await tx(update(id!, { labelIds: [proposed!.id] }));
  await tx(update(id!, { stateId: state("started") }));
  assert.deepEqual(await labels(), [proposed!.id]);
});

test("create assigns the next number and goes to the top of the column", async () => {
  const [p] = await db.select().from(project).where(eq(project.id, refs.project.id));
  const id = randomUUID();
  const r = await tx([{ op: "create", m: "Issue", id, projectId: refs.project.id, set: { title: "New one", stateId: refs.states.find((s) => s.group === "completed")!.id } }]);
  const d = r.actions[0]!.d as { number: number; sortOrder: string; completedAt: string | null; createdById: string };
  assert.equal(d.number, p!.issueCounter + 1);
  assert.ok(d.completedAt);
  assert.equal(d.createdById, ws.ownerId);
  const [top] = await db.select({ id: issue.id }).from(issue).where(eq(issue.projectId, refs.project.id)).orderBy(issue.sortOrder).limit(1);
  assert.equal(top!.id, id);
  const second = await tx([{ op: "create", m: "Issue", id: randomUUID(), projectId: refs.project.id, set: { title: "Next", stateId: refs.states[0]!.id } }]);
  assert.equal((second.actions[0]!.d as { number: number }).number, p!.issueCounter + 2);
  // A state from another project is rejected before a number is taken.
  await rejects(tx([{ op: "create", m: "Issue", id: randomUUID(), projectId: refs.project.id, set: { title: "x", stateId: refs.otherStates[0]!.id } }]), "bad_ref");
  const [after] = await db.select().from(project).where(eq(project.id, refs.project.id));
  assert.equal(after!.issueCounter, p!.issueCounter + 2);
});

test("a sort key the library can't build on is refused, so creates at the top keep working", async () => {
  const id = randomUUID();
  await tx([{ op: "create", m: "Issue", id, projectId: refs.project.id, set: { title: "Keyed", stateId: refs.states[0]!.id } }]);
  // "!" sorts before every real key under COLLATE "C"; stored, it would make generateKeyBetween throw on every create.
  for (const k of ["!", "A", "zz", "a10", "a0 "]) await rejects(tx(update(id, { sortOrder: k })), "invalid");
  await rejects(tx([{ op: "create", m: "Issue", id: randomUUID(), projectId: refs.project.id, set: { title: "x", stateId: refs.states[0]!.id, sortOrder: "!" } }]), "invalid");
  // A bad key already stored (before the check) is refused by name instead of failing as an internal error.
  await db.update(issue).set({ sortOrder: "!" }).where(eq(issue.id, id));
  await rejects(tx([{ op: "create", m: "Issue", id: randomUUID(), projectId: refs.project.id, set: { title: "y", stateId: refs.states[0]!.id } }]), "invalid");
  await tx(update(id, { sortOrder: "Zz" }));
  await tx([{ op: "create", m: "Issue", id: randomUUID(), projectId: refs.project.id, set: { title: "z", stateId: refs.states[0]!.id } }]);
});

test("an assignee or label listed twice is refused", async () => {
  await rejects(tx(update(refs.issue.id, { assigneeIds: [ws.ownerId, ws.ownerId] })), "invalid");
  const l = refs.labels[0]!.id;
  await rejects(tx(update(refs.issue.id, { labelIds: [l, l] })), "invalid");
});

test("titles are cleaned as names are; nothing visible and past TITLE_MAX are refused", async () => {
  const id = randomUUID();
  const r = await tx([{ op: "create", m: "Issue", id, projectId: refs.project.id, set: { title: " Fix\nlogin\u202E\u200B  page ", stateId: refs.states[0]!.id } }]);
  assert.equal((r.actions[0]!.d as { title: string }).title, "Fix login page");
  await tx(update(id, { title: "Two\tlines\r\nhere" }));
  const [row] = await db.select({ title: issue.title }).from(issue).where(eq(issue.id, id));
  assert.equal(row!.title, "Two lines here");
  await rejects(tx(update(id, { title: "\uFEFF \n" })), "invalid");
  await rejects(tx(update(id, { title: "x".repeat(TITLE_MAX + 1) })), "invalid");
});

test("a no-op update writes no action, no number and no updatedAt", async () => {
  const [row] = await db.select().from(issue).where(eq(issue.id, refs.issue.id));
  const s0 = await lastSyncId(ws.workspaceId);
  const txId = randomUUID();
  const r = await tx(update(row!.id, { title: row!.title, priority: row!.priority, labelIds: row!.labelIds }), txId);
  assert.equal(r.s, s0);
  assert.deepEqual(r.actions, []);
  assert.equal(await lastSyncId(ws.workspaceId), s0);
  assert.equal((await actionsOf(txId)).length, 0);
  const [same] = await db.select().from(issue).where(eq(issue.id, row!.id));
  assert.equal(same!.updatedAt, row!.updatedAt);
  // Recorded, so a replay answers from the record even if the data changed meanwhile.
  const [rec] = await db.select().from(appliedTx).where(and(eq(appliedTx.txId, txId)));
  assert.equal(rec!.lastSyncId, s0);
});

test("the snapshot agrees with the database and is cut at lastSyncId", async () => {
  const key = refs.project.key;
  const lines = [];
  for await (const l of snapshot(ws.slug, key)) lines.push(l);
  const meta = lines[0]!;
  assert.equal(meta.t, "meta");
  assert.equal(meta.t === "meta" && meta.s, await lastSyncId(ws.workspaceId));
  assert.equal(lines.at(-1)!.t, "end");

  const ready = lines.findIndex((l) => l.t === "ready");
  const batches = lines.flatMap((l, i) => (l.t === "b" ? [{ ...l, i }] : []));
  const issueBatches = batches.filter((b) => b.m === "Issue");
  // The open project's issues come first, alone, before ready; the rest after.
  assert.equal(issueBatches.length, 2);
  const pi = issueBatches[0]!.c.indexOf("projectId");
  assert.ok(issueBatches[0]!.i < ready && issueBatches[1]!.i > ready);
  assert.ok(issueBatches[0]!.r.every((r) => r[pi] === refs.project.id));
  assert.ok(issueBatches[1]!.r.every((r) => r[pi] !== refs.project.id));
  for (const m of ["User", "Project", "WorkflowState", "Label"]) assert.ok(batches.find((b) => b.m === m)!.i < ready, m);

  const rows = await db.select().from(issue).where(eq(issue.workspaceId, ws.workspaceId));
  const snap = issueBatches.flatMap((b) => b.r.map((r) => Object.fromEntries(b.c.map((c, n) => [c, r[n]]))));
  assert.equal(snap.length, rows.length);
  const byId = new Map(rows.map((r) => [r.id, r as Record<string, unknown>]));
  for (const s of snap) for (const [k, v] of Object.entries(s)) assert.deepEqual(v, byId.get(s.id as string)![k], k);
  const count = (m: string) => batches.find((b) => b.m === m)!.r.length;
  assert.deepEqual([count("User"), count("Project"), count("WorkflowState"), count("Label")], [2, 10, 70, 40]);

  // Without an open project: no first batch, ready right after the shared models.
  const plain = [];
  for await (const l of snapshot(ws.slug, undefined)) plain.push(l);
  assert.equal(plain.filter((l) => l.t === "b" && l.m === "Issue").length, 1);
});

test("a snapshot cut during writes plus the log after its s equals the final state", async () => {
  const issues = await db.select({ id: issue.id }).from(issue).where(eq(issue.workspaceId, ws.workspaceId)).limit(30);
  const writes = issues.map((row, n) => tx(update(row.id, { title: `during snapshot ${n} ${randomUUID()}` })));
  const lines = [];
  for await (const l of snapshot(ws.slug, undefined)) lines.push(l);
  await Promise.all(writes);

  const meta = lines[0]!;
  assert.ok(meta.t === "meta");
  const titles = new Map<string, unknown>();
  for (const l of lines) {
    if (l.t !== "b" || l.m !== "Issue") continue;
    const [id, title] = [l.c.indexOf("id"), l.c.indexOf("title")];
    for (const r of l.r) titles.set(r[id] as string, r[title]);
  }
  const later = await db.select().from(syncAction).where(eq(syncAction.workspaceId, ws.workspaceId)).orderBy(syncAction.id);
  for (const a of later.filter((a) => a.id > meta.s)) {
    const d = a.data as { title?: string } | null;
    if (a.action === "U" && d?.title !== undefined) titles.set(a.modelId, d.title);
  }
  const rows = await db.select({ id: issue.id, title: issue.title }).from(issue).where(eq(issue.workspaceId, ws.workspaceId));
  for (const r of rows) assert.equal(titles.get(r.id), r.title);
});

test("a txId used in another workspace or by another actor is refused, not acked with someone else's number", async () => {
  const other = await importFixture();
  const otherRefs = await issueWithRefs(other.workspaceId);
  const txId = randomUUID();
  await tx(update(refs.issue.id, { title: `mine ${txId}` }), txId);
  const before = await lastSyncId(other.workspaceId);
  await rejects(applyTx(other.workspaceId, other.ownerId, txId, update(otherRefs.issue.id, { title: "theirs" })), "conflict");
  assert.equal(await lastSyncId(other.workspaceId), before, "nothing was written there");
  await rejects(applyTx(ws.workspaceId, ws.agentId, txId, update(refs.issue.id, { title: "agent's" })), "conflict");
  // The same actor in the same workspace still gets the first answer.
  const again = await tx(update(refs.issue.id, { title: "resent" }), txId);
  assert.equal((again.actions[0]!.d as { title: string }).title, `mine ${txId}`);
});

test("an admin-role agent cannot reach a state only people set: by naming another like it, renaming it, or by a person's switch", async () => {
  const f = await importFixture();
  const r = await issueWithRefs(f.workspaceId);
  await db.update(schema.member).set({ role: "admin" }).where(and(eq(schema.member.workspaceId, f.workspaceId), eq(schema.member.userId, f.agentId)));
  const agent = (ops: Op[]) => applyTx(f.workspaceId, f.agentId, randomUUID(), ops);
  const people = (ops: Op[]) => applyTx(f.workspaceId, f.ownerId, randomUUID(), ops);
  const stateOf = async (id: string) =>
    (await db.select({ name: schema.workflowState.name }).from(issue).innerJoin(schema.workflowState, eq(schema.workflowState.id, issue.stateId)).where(eq(issue.id, id)))[0]!.name;
  const start = await stateOf(r.issue.id);
  const create = (id: string, name: string, onlyPeople?: boolean): Op => ({ op: "create", m: "WorkflowState", id, set: { projectId: r.project.id, name, group: "started", position: 99_000, ...(onlyPeople === undefined ? {} : { onlyPeople }) } });
  const guardOf = async (id: string) => (await db.select({ g: schema.workflowState.onlyPeople }).from(schema.workflowState).where(eq(schema.workflowState.id, id)))[0]?.g;

  // 1. Create a state that reads as the guarded Todo (any case, a lookalike) and move into it in one transaction: it
  // comes guarded, so the move is refused; made alone it is guarded too, and an unguarded one is refused outright.
  for (const name of ["Todo", "todo", "TODO", "T0do"]) {
    const s = randomUUID();
    await rejects(agent([create(s, name), ...update(r.issue.id, { stateId: s })]), "forbidden");
    await rejects(agent([create(s, name, false)]), "forbidden");
    await agent([create(s, name)]);
    assert.equal(await guardOf(s), true, name);
  }
  // A new guarded state the agent makes the default would take every issue people make without a state.
  const shipIt: Op = { op: "create", m: "WorkflowState", id: randomUUID(), set: { projectId: r.project.id, name: "Ship", group: "unstarted", position: 99_500, isDefault: true, onlyPeople: true } };
  await rejects(agent([{ op: "update", m: "WorkflowState", id: r.states.find((x) => x.isDefault)!.id, set: { isDefault: false } }, shipIt]), "forbidden");
  // 2. Move into "Foo", then rename "Foo" to "Todo": in one transaction or in two.
  const foo = randomUUID();
  await agent([create(foo, "Foo")]);
  await rejects(agent([...update(r.issue.id, { stateId: foo }), { op: "update", m: "WorkflowState", id: foo, set: { name: "Todo" } }]), "forbidden");
  await agent(update(r.issue.id, { stateId: foo }));
  await rejects(agent([{ op: "update", m: "WorkflowState", id: foo, set: { name: "todo" } }]), "forbidden");
  // 3. Rename the real Todo away, or delete it: also refused, it is a state only people set.
  const todo = r.states.find((s) => s.name === "Todo")!;
  await rejects(agent([{ op: "update", m: "WorkflowState", id: todo.id, set: { name: "Ready" } }]), "forbidden");
  await rejects(agent([{ op: "delete", m: "WorkflowState", id: todo.id }]), "forbidden");
  // 4. The switch decides, not the name: a state a person made with Only people on is refused to the agent, whatever it is called.
  const shouty = randomUUID();
  await people([create(shouty, "Ship it", true)]);
  await rejects(agent(update(r.issue.id, { stateId: shouty })), "forbidden");
  // 5. A signed-in admin adds "Approved" to a project without one: it is the people's, as the migration made the others.
  const approved = randomUUID();
  await applyTx(f.workspaceId, f.ownerId, randomUUID(), [create(approved, "Approved")], true);
  assert.equal(await guardOf(approved), true);
  await rejects(agent(update(r.issue.id, { stateId: approved })), "forbidden");
  assert.equal(await stateOf(r.issue.id), "Foo", `moved from ${start} into Foo only`);

  // What stays allowed: other states, other fields of Todo, and a title edit of an issue a person put into Todo.
  await agent([{ op: "update", m: "WorkflowState", id: foo, set: { name: "Bar", position: 99_001 } }]);
  await agent([{ op: "update", m: "WorkflowState", id: todo.id, set: { position: todo.position + 0.5 } }]);
  await people(update(r.issue.id, { stateId: todo.id }));
  await agent(update(r.issue.id, { title: "agent edit while in Todo" }));
  // And people do all of it.
  await people([{ op: "update", m: "WorkflowState", id: foo, set: { name: "Approved 2" } }]);
});
