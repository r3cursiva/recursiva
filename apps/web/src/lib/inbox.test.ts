import assert from "node:assert/strict";
import { test } from "node:test";
import type { InboxEvent, InboxKind, InboxRow } from "@rsva/sync";
import type { Issue, WorkflowState } from "@rsva/schema/models";
import { arrange, DEFAULT_INBOX_DISPLAY, dayGroup, filterCount, inboxActions, matches, reason, snoozeOptions, untilLabel } from "./inbox.ts";

const state = (id: string, group: string, position: number) => ({ id, group, position, name: id, projectId: "p" }) as WorkflowState;
const STATES = [
  state("backlog", "backlog", 0),
  state("todo", "unstarted", 1),
  state("doing", "started", 2),
  state("review", "started", 3),
  state("approved", "started", 4),
  state("done", "completed", 5),
];
const ME = "me";
const ev = (kind: InboxKind, at = "2026-10-28T10:00:00Z", id = 1): InboxEvent => ({ id, issueId: "i", kind, by: "dan", at });
const row = (kinds: InboxKind[], issue: Partial<Issue> = {}, snoozedUntil: string | null = null): InboxRow => {
  const events = kinds.map((k, i) => ev(k, undefined, i + 1));
  return {
    issue: { id: "i", stateId: "todo", assigneeIds: [], createdById: "dan", ...issue } as Issue,
    events,
    latest: events.at(-1)!,
    kinds: new Set(kinds),
    unread: true,
    snoozedUntil,
  };
};

test("filter: each list needs one match, any event's actor counts", () => {
  const r = { ...row(["assigned", "reply"], { projectId: "p", priority: 2 }), ws: "atlas" };
  const group = (id: string) => STATES.find((s) => s.id === id)?.group;
  assert.equal(matches(r, {}, group), true);
  assert.equal(matches(r, { kind: ["reply", "review"] }, group), true);
  assert.equal(matches(r, { kind: ["review"] }, group), false);
  assert.equal(matches(r, { from: ["dan"], project: ["p"], priority: [2], stateGroup: ["unstarted"] }, group), true);
  assert.equal(matches(r, { from: ["dan"], priority: [1] }, group), false);
  // RSVA-613: one inbox for every workspace, narrowed to some of them.
  assert.equal(matches(r, { workspace: ["atlas", "beacon"] }, group), true);
  assert.equal(matches(r, { workspace: ["beacon"], from: ["dan"] }, group), false);
  assert.equal(filterCount({ kind: ["reply", "review"], from: ["dan"] }), 3);
});

test("the reason line names the state it moved into", () => {
  assert.equal(
    reason({ ...ev("state"), stateId: "done" }, (id) => (id === "done" ? "Done" : undefined)),
    "moved it to Done",
  );
  assert.equal(
    reason(ev("review"), () => undefined),
    "requested your review",
  );
});

test("actions: approve or send back while in review; start an assignment; done after approval", () => {
  const review = inboxActions(row(["review"], { stateId: "review", createdById: ME }), STATES, ME);
  assert.deepEqual(
    review.map((a) => [a.label, a.stateId, a.primary]),
    [
      ["Request changes", "doing", false],
      ["Approve", "approved", true],
    ],
  );
  // Already moved on, or not the viewer's to approve: nothing to ask.
  assert.deepEqual(inboxActions(row(["review"], { stateId: "approved", createdById: ME }), STATES, ME), []);
  assert.deepEqual(inboxActions(row(["review"], { stateId: "review" }), STATES, ME), []);
  const assigned = inboxActions(row(["assigned"], { assigneeIds: [ME] }), STATES, ME);
  assert.deepEqual(
    assigned.map((a) => a.stateId),
    ["backlog", "doing"],
  );
  assert.deepEqual(
    inboxActions(row(["approved"], { stateId: "approved", assigneeIds: [ME] }), STATES, ME).map((a) => a.stateId),
    ["done"],
  );
});

test("order, groups and snooze times; days follow the local calendar", () => {
  const now = new Date(2026, 9, 28, 11, 0).getTime();
  assert.equal(dayGroup(new Date(2026, 9, 28, 0, 5).toISOString(), now), "Today");
  assert.equal(dayGroup(new Date(2026, 9, 27, 23, 55).toISOString(), now), "Yesterday");
  assert.equal(dayGroup(new Date(2026, 9, 20).toISOString(), now), "Earlier");
  const at = (r: InboxRow, t: Date, p: Partial<Issue> = {}) => ({ ...r, issue: { ...r.issue, ...p }, latest: ev(r.latest.kind, t.toISOString()) });
  const today = at(row(["assigned"]), new Date(now), { id: "a", projectId: "p1", priority: 4 });
  const older = { ...at(row(["comment"]), new Date(2026, 9, 26), { id: "b", projectId: "p2", priority: 1 }), unread: false };
  const names = (gs: { name: string; rows: InboxRow[] }[]) => gs.map((g) => [g.name, g.rows.map((r) => r.issue.id).join("")]);
  const name = (id: string) => id.toUpperCase();
  const flat = { ...DEFAULT_INBOX_DISPLAY, groupBy: "none" as const };
  assert.deepEqual(names(arrange([older, today], flat, now, name)), [["", "ab"]]);
  // Days are the default.
  assert.deepEqual(names(arrange([older, today], DEFAULT_INBOX_DISPLAY, now, name)), [
    ["Today", "a"],
    ["Earlier", "b"],
  ]);
  assert.deepEqual(names(arrange([today, older], { ...DEFAULT_INBOX_DISPLAY, orderBy: "priority", groupBy: "project" }, now, name)), [
    ["P2", "b"],
    ["P1", "a"],
  ]);
  assert.deepEqual(names(arrange([today, older], { ...flat, orderBy: "oldest" }, now, name)), [["", "ba"]]);
  assert.deepEqual(names(arrange([older, today], { ...flat, orderBy: "oldest", unreadFirst: true }, now, name)), [["", "ab"]]);

  // Wednesday 11:00: later today 18:00, tomorrow 09:00, Monday Nov 2, a week on.
  const opts = snoozeOptions(now);
  assert.deepEqual(
    opts.map((o) => [o.label, o.at.getDate(), o.at.getHours()]),
    [
      ["Later today", 28, 18],
      ["Tomorrow", 29, 9],
      ["Next Monday", 2, 9],
      ["In a week", 4, 9],
    ],
  );
  assert.deepEqual(snoozeOptions(new Date(2026, 9, 28, 17, 30).getTime())[0]!.label, "Tomorrow");
  assert.equal(untilLabel(opts[1]!.at.toISOString(), now), "Tomorrow, 09:00");
});

test("a comment's row says how the comment starts; one without its line says the kind", () => {
  const none = () => undefined;
  assert.equal(reason({ ...ev("comment"), commentId: "c", text: "Tests pass" }, none), "· Tests pass");
  assert.equal(reason({ ...ev("reply"), commentId: "c", text: "Agreed" }, none), "replied · Agreed");
  assert.equal(reason({ ...ev("mention"), commentId: "c", text: "@Ann look" }, none), "mentioned you · @Ann look");
  assert.equal(reason({ ...ev("comment"), commentId: "c" }, none), "commented");
});
