// Moving issues between projects in the browser (PLNR-448): shown at once with the state and labels the server will give,
// the old key still opening the issue while the server answers, a refusal putting it back, someone else's move arriving
// as a delta, and both projects' Timelines taking it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Op, ProjectHistory, SnapshotLine } from "@rsva/protocol";
import { ISSUE, online, PROJECT, snapshot, TODO, until } from "./fake.ts";

const [A, B, C] = ISSUE;
const SITE = "00000000-0000-7000-8000-0000000000b2";
const SITE_TODO = "00000000-0000-7000-8000-0000000000c3";
const SITE_BACKLOG = "00000000-0000-7000-8000-0000000000c4";
const SITE_DONE = "00000000-0000-7000-8000-0000000000c5";
const BUG = "00000000-0000-7000-8000-0000000000e1";
const WS_LABEL = "00000000-0000-7000-8000-0000000000e2";
const SITE_BUG = "00000000-0000-7000-8000-0000000000e3";
const OTHER = "00000000-0000-7000-8000-0000000000a2";

/** The usual snapshot plus a second project SITE: Backlog (default), Todo, Done, and its own "Bug". A is labelled bug and ws. */
function twoProjects(): SnapshotLine[] {
  const lines = snapshot(10);
  return lines.flatMap((l): SnapshotLine[] => {
    if (l.t !== "b") return [l];
    if (l.m === "Project") return [{ ...l, r: [...l.r, [SITE, "SITE", "Site", null, [], 7, "2026-10-27T00:00:00Z", null]] }];
    if (l.m === "WorkflowState")
      return [{ ...l, r: [...l.r, [SITE_BACKLOG, SITE, "Backlog", "backlog", "#999", 0, true], [SITE_TODO, SITE, "todo", "unstarted", "#999", 1, false], [SITE_DONE, SITE, "Shipped", "completed", "#0f0", 2, false]] }];
    if (l.m === "Label") return [{ ...l, r: [...l.r, [SITE_BUG, SITE, null, "Bug", "#f00", 1]] }];
    if (l.m === "Issue" && l.r.some((r) => r[0] === A)) {
      const labels = l.c.indexOf("labelIds");
      return [{ ...l, r: l.r.map((r) => (r[0] === A ? r.map((v, i) => (i === labels ? [BUG, WS_LABEL] : v)) : r)) }];
    }
    return [l];
  });
}

const moveOps = (ops: Op[]) => ops.filter((o): o is Extract<Op, { m: "Issue"; op: "update" }> => o.m === "Issue" && o.op === "update" && o.set.projectId !== undefined);

test("a move shows at once: mapped state and labels, no number yet, the old key still opens it; the echo gives the number", async () => {
  const { store, socket } = await online({ serve: twoProjects() });
  assert.equal(store.moveIssues([A, A], SITE), 1, "each issue once");
  const [tx] = socket().frames("tx");
  const [op] = moveOps(tx!.ops);
  assert.deepEqual(op!.set, { projectId: SITE, stateId: SITE_TODO, labelIds: [SITE_BUG, WS_LABEL] }, "Todo → todo by name, bug → Bug, the workspace label stays");
  assert.deepEqual(op!.base, { labelIds: [BUG, WS_LABEL] }, "the list it saw, for the server to merge");

  const a = store.issues.get(A)!;
  assert.equal(a.projectId, SITE);
  assert.equal(store.issueKey(a), "SITE-?");
  assert.deepEqual(a.formerKeys, ["PLANE-1"]);
  assert.equal(store.issueByKey("PLANE-1"), a, "an open page with the old key keeps its issue");
  assert.equal(store.issueByKey("PLN-1"), a, "and the project's key before a rename");
  assert.ok(store.issuesOf(SITE).includes(a));
  assert.ok(!store.issuesOf(PROJECT).includes(a));

  socket().push({ t: "d", a: [{ id: 11, m: "Issue", mid: A, a: "U", d: { projectId: SITE, number: 8, formerKeys: ["PLANE-1"], stateId: SITE_TODO, labelIds: [SITE_BUG, WS_LABEL], updatedAt: "2026-11-07T00:00:00Z" } }] });
  socket().push({ t: "ack", id: tx!.id, s: 11 });
  await until(() => store.issueKey(store.issues.get(A)!) === "SITE-8", "the number");
  assert.equal(store.issueByKey("SITE-8"), store.issues.get(A));
  assert.equal(store.issueByKey("PLANE-1"), store.issues.get(A));
  assert.equal(store.issueByKey("PLANE-2"), store.issues.get(B), "the project's own issues are still its");
  store.dispose();
});

test("a refused move puts the issue back where it was, its number and keys too", async () => {
  const { store, socket } = await online({ serve: twoProjects() });
  store.moveIssues([B], SITE);
  const [tx] = socket().frames("tx");
  socket().push({ t: "rej", id: tx!.id, code: "invalid", msg: "project SITE is archived" });
  const b = store.issues.get(B)!;
  assert.equal(b.projectId, PROJECT);
  assert.equal(store.issueKey(b), "PLANE-2");
  assert.deepEqual(b.formerKeys, []);
  assert.equal(b.stateId, TODO);
  assert.equal(store.issueByKey("PLANE-2"), b);
  store.dispose();
});

test("issues already there or deleted are left out; many go in one transaction", async () => {
  const { store, socket } = await online({ serve: twoProjects() });
  store.updateIssue(C, { deletedAt: new Date().toISOString() });
  assert.equal(store.moveIssues([A, B, C], SITE), 2);
  const tx = socket().frames("tx").at(-1)!;
  assert.deepEqual(moveOps(tx.ops).map((o) => o.id), [A, B]);
  assert.equal(store.moveIssues([A], SITE), 0, "already there (locally)");
  store.dispose();
});

test("a move made elsewhere arrives as a delta: both Timelines take it, the history entry says the key it left", async () => {
  const h = await online({ serve: twoProjects() });
  const page = (): ProjectHistory => ({ s: 10, history: [], comments: [] });
  h.projectHistory.set(`project=${PROJECT}&level=steps`, page());
  h.projectHistory.set(`project=${SITE}&level=steps`, page());
  h.projectHistory.set(`project=${PROJECT}&level=outcomes`, page());
  const from = h.store.projectHistory(PROJECT, "steps");
  const to = h.store.projectHistory(SITE, "steps");
  const outcomes = h.store.projectHistory(PROJECT, "outcomes");
  await until(() => from.status === "ready" && to.status === "ready" && outcomes.status === "ready", "ready");
  h.socket().push({
    t: "d",
    a: [{ id: 11, m: "Issue", mid: B, a: "U", by: OTHER, d: { projectId: SITE, number: 8, formerKeys: ["PLANE-2"], stateId: SITE_DONE, updatedAt: "2026-11-07T00:00:00Z" } }],
  });
  for (const f of [from, to]) {
    assert.deepEqual(
      f.entries.map((e) => [e.id, e.i, e.d, e.p, e.was]),
      [[11, B, { projectId: SITE, stateId: SITE_DONE }, { projectId: PROJECT, stateId: TODO }, "PLANE-2"]],
    );
  }
  assert.equal(outcomes.entries.length, 0, "outcomes show no moves");
  const b = h.store.issues.get(B)!;
  assert.equal(h.store.issueKey(b), "SITE-8");
  assert.equal(h.store.issueByKey("PLANE-2"), b);
  // The key handed over to another project later: the moved issue answers to it no more.
  h.socket().push({ t: "d", a: [{ id: 12, m: "Issue", mid: B, a: "U", d: { formerKeys: [] } }] });
  assert.equal(h.store.issueByKey("PLANE-2"), undefined);

  h.store.dispose();
});

test("a move made by someone else is no state change in the Inbox: the state it maps is not a step of the work", async () => {
  const { store, socket } = await online({ serve: twoProjects() });
  socket().push({ t: "inbox", s: 10, e: [], m: [], c: [], th: [], at: null });
  await until(() => store.inbox.status === "ready", "inbox");
  // A was created by the viewer: a state change by someone else would reach them.
  socket().push({ t: "d", a: [{ id: 11, m: "Issue", mid: A, a: "U", by: OTHER, d: { projectId: SITE, number: 8, formerKeys: ["PLANE-1"], stateId: SITE_DONE, updatedAt: "2026-11-07T00:00:00Z" } }] });
  assert.equal(store.inbox.rows.length, 0);
  socket().push({ t: "d", a: [{ id: 12, m: "Issue", mid: A, a: "U", by: OTHER, d: { stateId: SITE_TODO, updatedAt: "2026-11-07T00:00:01Z" } }] });
  assert.deepEqual(store.inbox.rows.map((r) => r.latest.kind), ["state"]);
  store.dispose();
});
