import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue, StateGroup } from "@rsva/schema/models";
import { groupOfRow, hasParents, rowTotal, sortRows, structure, type StructureFacts } from "./structure.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
let n = 0;
const issue = (group: StateGroup | "review", over: Partial<Issue> = {}): Issue =>
  ({ id: `i${++n}`, stateId: group, parentId: null, labelIds: [], updatedAt: "2026-11-09T00:00:00Z", ...over }) as Issue;
const facts = (over: Partial<StructureFacts> = {}): StructureFacts => ({
  groupOf: (i) => (i.stateId === "review" ? "started" : (i.stateId as StateGroup)),
  stageOf: (i) => (i.stateId === "review" ? "review" : i.stateId === "started" ? "progress" : undefined),
  wait: new Set(),
  doing: new Set(),
  agents: new Set(),
  blocked: new Set(),
  ...over,
});
const pick = (rows: ReturnType<typeof structure>, id: string) => rows.find((r) => r.id === id)!;

test("a parent's row counts everything under it at any depth, not the parent; what stands alone is the rest", () => {
  const top = issue("started", { id: "top" });
  const mid = issue("unstarted", { id: "mid", parentId: "top" });
  const waits = issue("review", { parentId: "mid" });
  const mine = issue("started", { parentId: "top" });
  const blocked = issue("backlog", { parentId: "top", updatedAt: "2026-11-10T00:00:00Z" });
  const review = issue("review", { parentId: "top" });
  const done = issue("completed", { parentId: "mid" });
  const cancelled = issue("cancelled", { parentId: "top" });
  const alone = issue("unstarted");
  const closedParent = issue("completed", { id: "old" });
  const underClosed = issue("completed", { parentId: "old" });
  const all = [top, mid, waits, mine, blocked, review, done, cancelled, alone, closedParent, underClosed];
  const f = facts({ wait: new Set([waits.id]), doing: new Set([mine.id]), blocked: new Set([blocked.id]) });
  const rows = structure("parent", all, f);
  assert.deepEqual(rows.map((r) => r.id).sort(), ["rest", "top"]);
  assert.deepEqual(pick(rows, "top"), { id: "top", kind: "parent", wait: 1, doing: 1, agents: 0, review: 1, blocked: 1, done: 1, open: 4, backlog: 1, changed: "2026-11-10T00:00:00Z" });
  assert.equal(rowTotal(pick(rows, "top")), 6);
  assert.equal(pick(rows, "rest").open, 1);
  assert.equal(hasParents(all, f), true);
  assert.equal(hasParents([alone, underClosed], f), false);
});

test("a parent loop ends where it began", () => {
  const a = issue("unstarted", { id: "a", parentId: "b" });
  const b = issue("unstarted", { id: "b", parentId: "a" });
  assert.doesNotThrow(() => structure("parent", [a, b], facts()));
});

test("by label an issue is in each of its labels' rows; one without a label is the rest", () => {
  const rows = structure("label", [issue("unstarted", { labelIds: ["x", "y"] }), issue("backlog", { labelIds: ["x"] }), issue("started"), issue("completed", { labelIds: ["z"] })], facts());
  assert.deepEqual(
    rows.map((r) => [r.id, r.kind, r.open, r.backlog]).sort(),
    [
      ["rest", "rest", 1, 0],
      ["x", "label", 1, 1],
      ["y", "label", 1, 0],
    ],
  );
});

test("rows that need the viewer come first, stalled ones last, the rest row last in its group", () => {
  const row = (id: string, over: object) => ({ id, kind: "parent" as const, wait: 0, doing: 0, agents: 0, review: 0, blocked: 0, done: 0, open: 1, backlog: 0, changed: "2026-11-10T00:00:00Z", ...over });
  const rows = [row("stalled", { changed: "2026-10-20T00:00:00Z" }), row("rest", { kind: "rest", open: 9 }), row("small", {}), row("big", { open: 5 }), row("need", { wait: 1 })];
  assert.deepEqual(sortRows(rows, NOW).map((r) => r.id), ["need", "big", "small", "rest", "stalled"]);
  assert.equal(groupOfRow(rows.at(-1)!, NOW), "stalled");
});
