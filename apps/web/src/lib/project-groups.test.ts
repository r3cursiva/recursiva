import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_GROUPS, type SidebarGroups } from "@rsva/protocol";
import type { Project } from "@rsva/schema/models";
import { addGroup, caption, isQuiet, keepVisible, layOut, markQuiet, moveToGroup, moveGroup, removeGroup, toggleFold, type ProjectSignals } from "./project-groups.ts";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const project = (id: string) => ({ id, key: id.toUpperCase(), name: id }) as Project;

function signals(last: Record<string, number>, flags: Partial<Record<"waits" | "overdue" | "inCycle", string[]>> = {}): ProjectSignals {
  return {
    lastChange: (id) => daysAgo(last[id] ?? 0),
    waits: (id) => !!flags.waits?.includes(id),
    overdue: (id) => !!flags.overdue?.includes(id),
    inCycle: (id) => !!flags.inCycle?.includes(id),
  };
}

test("quiet: still for 14 days with nothing for the viewer; kept, waiting, overdue or in a cycle is never quiet", () => {
  const s = signals({ a: 20, b: 3, c: 20, d: 20, e: 20, f: 20 }, { waits: ["c"], overdue: ["d"], inCycle: ["e"] });
  const g: SidebarGroups = { ...NO_GROUPS, keep: ["f"] };
  assert.deepEqual(["a", "b", "c", "d", "e", "f"].map((id) => isQuiet(id, g, s, NOW, 14)), [true, false, false, false, false, false]);
});

test("quiet days: the person's choice; 0 leaves only the marked ones", () => {
  const s = signals({ a: 10, b: 10 });
  const g = markQuiet(NO_GROUPS, "b", daysAgo(5));
  assert.deepEqual([isQuiet("a", g, s, NOW, 14), isQuiet("a", g, s, NOW, 7)], [false, true]);
  assert.deepEqual([isQuiet("a", g, signals({ a: 400 }), NOW, 0), isQuiet("b", g, s, NOW, 0)], [false, true]);
});

test("marked quiet stays quiet until something changes in it after the mark; Keep visible undoes the mark", () => {
  const s = signals({ a: 2, b: 2 });
  const g = markQuiet(markQuiet(NO_GROUPS, "a", daysAgo(1)), "b", daysAgo(3));
  assert.deepEqual([isQuiet("a", g, s, NOW, 14), isQuiet("b", g, s, NOW, 14)], [true, false], "b changed after its mark");
  const late = signals({ a: 2 }, { overdue: ["a"], inCycle: ["a"] });
  assert.equal(isQuiet("a", g, late, NOW, 14), true, "a mark holds over an overdue issue or a cycle");
  const kept = keepVisible(g, "a", true);
  assert.deepEqual([kept.keep, kept.quiet.map(([id]) => id)], [["a"], ["b"]]);
  assert.deepEqual(markQuiet(kept, "a", daysAgo(0)).keep, [], "marking quiet drops Keep visible");
});

test("layout: ungrouped on top, each group in the viewer's order, the quiet ones apart with their group; the open one stays", () => {
  const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map(project);
  let g = addGroup(NO_GROUPS, "g1", "Clients", ["d", "b"]);
  g = addGroup(g, "g2", "Acme", ["c"]);
  assert.deepEqual(g.groups.map((x) => x.name), ["Acme", "Clients"], "a new group comes first");
  const quiet = (id: string) => id === "e" || id === "d" || id === "c";
  const lay = layOut([a!, b!, c!, d!, e!], g, quiet, "c");
  assert.deepEqual(lay.top.map((p) => p.id), ["a"]);
  assert.deepEqual(lay.groups.map((r) => [r.group.name, r.projects.map((p) => p.id)]), [["Acme", ["c"]], ["Clients", ["b"]]]);
  assert.deepEqual(lay.quiet.map((q) => [q.project.id, q.from]), [["d", "Clients"], ["e", null]]);
});

test("moving: into one group at most, out of all with null; removing a group sends its projects back on top", () => {
  let g = addGroup(addGroup(NO_GROUPS, "g1", "One", ["a"]), "g2", "Two");
  g = moveToGroup(g, ["a"], "g2");
  assert.deepEqual(g.groups.map((x) => x.ids), [["a"], []]);
  assert.deepEqual(addGroup(g, "g3", "Three", ["a"]).groups.map((x) => x.ids), [["a"], [], []], "a new group takes its projects from the others");
  assert.deepEqual(moveToGroup(g, ["a"], null).groups.map((x) => x.ids), [[], []]);
  assert.deepEqual(removeGroup(g, "g2").groups.map((x) => x.id), ["g1"]);
  const folded = toggleFold(g, "g1");
  assert.deepEqual([folded.groups[1]!.folded, toggleFold(folded, "g1").groups[1]], [true, g.groups[1]]);
});

test("a group moves before another, or last; an unknown one changes nothing (RSVA-567)", () => {
  const g = addGroup(addGroup(addGroup(NO_GROUPS, "c", "C"), "b", "B"), "a", "A");
  const order = (x: typeof g) => x.groups.map((group) => group.id).join("");
  assert.deepEqual([order(g), order(moveGroup(g, "c", "a")), order(moveGroup(g, "a", undefined)), order(moveGroup(g, "x", "a"))], ["abc", "cab", "bca", "abc"]);
});

test("caption: the first three letters or digits, upper case", () => {
  assert.deepEqual(["Acme", "Own products", "Clients", "  à la carte", "2026 work"].map(caption), ["ACM", "OWN", "CLI", "ÀLA", "202"]);
});
