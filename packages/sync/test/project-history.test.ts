import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMENT_EXCERPT, type ProjectHistory } from "@rsva/protocol";
import { DONE, ISSUE, online, PROJECT, TODO, until } from "./fake.ts";

const [A, B] = ISSUE;
const OTHER = "00000000-0000-7000-8000-0000000000a2";
const T0 = "2026-10-29T10:00:00.000Z";
const T1 = "2026-10-30T11:00:00.000Z";
const NOWHERE = "00000000-0000-7000-8000-0000000000ff";
const q = (level: string, until?: string) => `project=${PROJECT}&level=${level}${until ? `&until=${encodeURIComponent(until)}` : ""}`;
const page = (over: Partial<ProjectHistory> = {}): ProjectHistory => ({ s: 10, history: [], comments: [], ...over });

test("a project history loads once per level and follows deltas: the level decides what a change adds", async () => {
  const h = await online();
  h.projectHistory.set(q("outcomes"), page({ history: [{ id: 7, i: A, a: "U", by: OTHER, at: T0, d: { stateId: DONE }, p: { stateId: TODO } }] }));
  h.projectHistory.set(q("steps"), page());
  const outcomes = h.store.projectHistory(PROJECT, "outcomes");
  const steps = h.store.projectHistory(PROJECT, "steps");
  await until(() => outcomes.status === "ready" && steps.status === "ready", "ready");
  assert.deepEqual(outcomes.entries.map((e) => e.id), [7]);
  h.store.projectHistory(PROJECT, "outcomes");
  assert.equal(h.requests.filter((u) => u.includes("level=outcomes")).length, 1, "loaded once");

  h.socket().push({
    t: "d",
    a: [
      { id: 11, m: "Issue", mid: B, a: "U", d: { stateId: DONE, priority: 2, updatedAt: T1 }, by: OTHER },
      { id: 12, m: "Issue", mid: B, a: "U", d: { priority: 3, updatedAt: T1 }, by: OTHER },
      { id: 13, m: "Comment", mid: NOWHERE, a: "I", d: { issueId: B, body: "z".repeat(COMMENT_EXCERPT + 9), createdAt: T1, parentId: null }, by: OTHER },
      // An issue the pool does not have is not this project's.
      { id: 14, m: "Issue", mid: NOWHERE, a: "U", d: { stateId: DONE, updatedAt: T1 }, by: OTHER },
    ],
  });
  assert.deepEqual(
    outcomes.entries.map((e) => [e.id, e.i, e.d, e.p]),
    [
      [7, A, { stateId: DONE }, { stateId: TODO }],
      [11, B, { stateId: DONE }, { stateId: TODO }],
    ],
    "outcomes keep the move and its before-value, nothing else",
  );
  assert.deepEqual(outcomes.comments, []);
  assert.deepEqual(steps.entries.map((e) => [e.id, e.d]), [[11, { stateId: DONE }]]);
  assert.deepEqual(steps.comments.map((c) => [c.i, c.x.length, c.at]), [[B, COMMENT_EXCERPT, T1]], "steps show a line of the comment");

  h.socket().push({ t: "d", a: [{ id: 15, m: "Comment", mid: NOWHERE, a: "U", d: { issueId: B, body: "", deletedAt: T1 }, by: OTHER }] });
  assert.deepEqual(steps.comments, [], "a deleted comment leaves");
  h.store.dispose();
});

test("deltas during the load wait; those past the answer's cut go on top once; older pages go under", async () => {
  const h = await online();
  let answer!: (x: ProjectHistory) => void;
  h.projectHistory.set(q("outcomes"), new Promise<ProjectHistory>((r) => (answer = r)));
  const feed = h.store.projectHistory(PROJECT, "outcomes");
  await until(() => h.requests.some((u) => u.includes("/sync/project-history")), "request");
  h.socket().push({ t: "d", a: [{ id: 11, m: "Issue", mid: A, a: "U", d: { stateId: DONE, updatedAt: T1 }, by: OTHER }] });
  h.socket().push({ t: "d", a: [{ id: 12, m: "Issue", mid: B, a: "U", d: { stateId: DONE, updatedAt: T1 }, by: OTHER }] });
  // The server read at 11: it has the first move, not the second.
  answer(page({ s: 11, older: T0, history: [{ id: 11, i: A, a: "U", by: OTHER, at: T1, d: { stateId: DONE }, p: { stateId: TODO } }] }));
  await until(() => feed.status === "ready", "ready");
  assert.deepEqual(feed.entries.map((e) => e.id), [11, 12]);

  assert.equal(feed.hasOlder, true);
  h.projectHistory.set(q("outcomes", T0), page({ s: 12, older: null, history: [{ id: 3, i: B, a: "U", by: OTHER, at: T0, d: { stateId: TODO }, p: { stateId: DONE } }] }));
  feed.loadOlder();
  await until(() => !feed.hasOlder, "older");
  assert.deepEqual(feed.entries.map((e) => e.id), [3, 11, 12]);
  h.store.dispose();
});

test("live: a new issue's start goes to the project's feeds by the level; its states and labels only at everything, with the names they had", async () => {
  const h = await online();
  const BUG = "00000000-0000-7000-8000-0000000000e1";
  const WS_LABEL = "00000000-0000-7000-8000-0000000000e2";
  const NEW = "00000000-0000-7000-8000-0000000000d9";
  h.projectHistory.set(q("steps"), page());
  h.projectHistory.set(q("everything"), page({ settings: [] }));
  const steps = h.store.projectHistory(PROJECT, "steps");
  const all = h.store.projectHistory(PROJECT, "everything");
  await until(() => steps.status === "ready" && all.status === "ready", "ready");
  const row = { id: NEW, projectId: PROJECT, title: "new", stateId: TODO, labelIds: [BUG], assigneeIds: [], delegateId: null, priority: 3, createdAt: T1 };
  h.socket().push({
    t: "d",
    a: [
      // Not in the pool before this action: the action names the project.
      { id: 11, m: "Issue", mid: NEW, a: "I", d: row, by: OTHER },
      { id: 12, m: "Label", mid: BUG, a: "U", d: { name: "defect" }, by: OTHER },
      { id: 13, m: "Label", mid: BUG, a: "U", d: { color: "#0f0" }, by: OTHER },
      { id: 14, m: "WorkflowState", mid: DONE, a: "U", d: { group: "cancelled" }, by: OTHER },
      // The workspace's label is no project's.
      { id: 15, m: "Label", mid: WS_LABEL, a: "U", d: { name: "everywhere" }, by: OTHER },
      { id: 16, m: "Label", mid: BUG, a: "D", d: { projectId: PROJECT }, by: OTHER },
    ],
  });
  assert.deepEqual(steps.entries.map((e) => [e.id, e.a, e.i, e.d]), [[11, "I", NEW, { stateId: TODO }]], "steps: the state it started in");
  assert.deepEqual(all.entries.map((e) => [e.id, e.a, e.d]), [[11, "I", { stateId: TODO, labelIds: [BUG], priority: 3 }]], "no empty fields");
  assert.deepEqual(steps.settings, []);
  assert.deepEqual(
    all.settings.map((e) => [e.id, e.m, e.a, e.d, e.p]),
    [
      [12, "Label", "U", { name: "defect" }, { name: "bug" }],
      [14, "WorkflowState", "U", { group: "cancelled" }, { group: "completed" }],
      [16, "Label", "D", {}, { name: "defect" }],
    ],
    "a color says nothing; a deletion keeps the name it had",
  );
  h.store.dispose();
});
