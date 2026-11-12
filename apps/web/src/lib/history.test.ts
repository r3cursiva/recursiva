import assert from "node:assert/strict";
import { test } from "node:test";
import type { HistoryEntry } from "@rsva/protocol";
import { priorityName, type GithubEvent } from "@rsva/schema/models";
import { createdWith, fieldLine, foldParts, historyEvents, historyLines, REMOVED, type HistoryPart } from "@rsva/display/history";

// The shared history words (packages/display history.ts), which the web's activity and the TUI both draw. Read here as
// plain text: names from small maps, as a screen resolves them from its store; anything else reads as REMOVED says.
const names: Record<string, Record<string, string>> = {
  state: { s1: "Backlog", s2: "Done" },
  label: { l1: "bug", l9: "ui" },
  user: { u1: "Robin" },
  issue: { i1: "PLNR-9 Parent" },
  cycle: { c1: "Cycle 7" },
  project: { p1: "Sites", p2: "Shop" },
};
const word = (p: HistoryPart): string => {
  if (typeof p === "string") return p;
  if ("em" in p) return p.em;
  if ("aside" in p) return p.aside;
  if ("priority" in p) return priorityName(p.priority);
  if ("cycle" in p && typeof p.cycle !== "string") return "";
  const [kind, id] = Object.entries(p)[0] as [keyof typeof REMOVED, unknown];
  return names[kind]![id as string] ?? REMOVED[kind];
};
const say = (parts: readonly HistoryPart[]) => parts.map(word).join("");
const line = (field: string, before: unknown, after: unknown) => {
  const l = fieldLine("k", field, before, after);
  return l && say(l.parts);
};

test("one field's change in the web's words, removed ids as the web reads them", () => {
  assert.equal(line("stateId", "s1", "gone"), "moved from Backlog to a removed state");
  assert.equal(line("stateId", null, "s2"), "moved to Done");
  assert.equal(line("labelIds", ["lx"], ["l1", "l2"]), "added labels bug and a removed label and removed label a removed label");
  assert.equal(line("assigneeIds", [], ["u1", "u9", "u8"]), "added assignees Robin, someone and someone");
  assert.equal(line("assigneeIds", ["u1"], ["u1"]), null, "equal sets say nothing");
  assert.equal(line("relatedIds", ["i1", "i2"], []), "removed related issues PLNR-9 Parent and a removed issue");
  assert.equal(line("cycleId", "c1", "c2"), "moved the issue from Cycle 7 to a removed cycle");
  assert.equal(line("cycleId", null, null), "removed the issue from ");
  assert.equal(line("dueDate", null, "2026-11-20"), "set the due date to Nov 20");
  assert.equal(line("priority", 3, 0), "removed the priority");
  assert.equal(line("deletedAt", "x", null), "restored the issue from the trash");
  assert.equal(line("sortOrder", "a", "b"), null, "a field history does not show");
});

test("the icon: a state change's new state, one assignee added their face, else the field's kind", () => {
  assert.deepEqual(fieldLine("k", "stateId", "s1", "s2")!.icon, { kind: "state", state: "s2" });
  assert.deepEqual(fieldLine("k", "assigneeIds", [], ["u1"])!.icon, { kind: "person", user: "u1" });
  assert.deepEqual(fieldLine("k", "assigneeIds", [], ["u1", "u2"])!.icon, { kind: "assignees" });
  assert.deepEqual(fieldLine("k", "priority", 0, 2)!.icon, { kind: "priority", priority: 2 });
});

test("an entry: one line per field; GitHub's carries the entry; an archive entry says so", () => {
  const e: HistoryEntry = { id: 4, a: "U", by: "u1", at: "2026-11-01T10:00:00Z", d: { title: "New", priority: 1 }, p: { title: "Old", priority: 0 } };
  assert.deepEqual(historyLines(e).map((l) => [l.key, say(l.parts)]), [["4:title", "renamed the issue to New"], ["4:priority", "set the priority to Urgent"]]);
  const gh = { ...e, gh: { verb: "merged" } as GithubEvent };
  assert.equal(historyLines(gh)[0]!.github, gh);
  assert.deepEqual(historyLines({ ...e, a: "A", d: {}, p: {} }).map((l) => say(l.parts)), ["archived the issue"]);
});

test("a move to another project is one line: the projects, the key it left, the labels it dropped, the cycle it left (PLNR-448)", () => {
  const e: HistoryEntry = {
    id: 9,
    a: "U",
    by: "u1",
    at: "2026-11-07T10:00:00Z",
    d: { projectId: "p2", stateId: "s2", labelIds: [], cycleId: null },
    p: { projectId: "p1", stateId: "s1", labelIds: ["l1", "l9"], cycleId: "c1" },
    was: "RSVA-3",
    dropped: ["l1", "l9"],
  };
  const [line, ...rest] = historyLines(e);
  assert.equal(rest.length, 0, "the mapped state and labels are part of the move");
  assert.deepEqual(line!.icon, { kind: "move" });
  assert.equal(say(line!.parts), "moved the issue from Sites to Shop (was RSVA-3), dropping labels bug and ui and out of Cycle 7");
  const { was: _, dropped: __, ...bare } = e;
  assert.equal(say(historyLines({ ...bare, d: { projectId: "p2" }, p: { projectId: "p1" } })[0]!.parts), "moved the issue from Sites to Shop");
  assert.equal(say(historyLines({ ...bare, was: "RSVA-3" })[0]!.parts), "moved the issue from Sites to Shop (was RSVA-3), out of Cycle 7");
  assert.equal(say(historyLines({ ...e, d: { projectId: "nope" } })[0]!.parts).includes(REMOVED.project), true);
});

test("what an issue started with, and a folded run", () => {
  assert.equal(say(createdWith({ stateId: "s1", labelIds: ["l1", "lx"], assigneeIds: ["u1"], delegateId: "u9", priority: 2 })), " in Backlog · bug and a removed label · for Robin · delegated to someone · High");
  assert.equal(say(createdWith({ priority: 0 })), "");
  const at = (m: number) => new Date(Date.UTC(2026, 10, 1, 10, m)).toISOString();
  const run = [{ at: at(0), move: { from: "s1", to: "x" } }, { at: at(1), move: { from: "x", to: "y" } }, { at: at(4), move: { from: "y", to: "s2" } }];
  assert.equal(say(foldParts(run)), "changed the state 3 times in 4 min: Backlog → Done");
  assert.equal(say(foldParts(run.map((r) => ({ ...r, at: at(0) })))), "changed the state 3 times: Backlog → Done");
});

test("the events: creation first when the first page is in, a sitting's description saves as one, one act as one line", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 10, 1, 10, 0, m)).toISOString();
  const e = (id: number, m: number, d: Record<string, unknown>, p: Record<string, unknown> = {}): HistoryEntry => ({ id, a: "U", by: "u1", at: at(m), d, p });
  const history = [e(1, 0, { description: true }), e(2, 20, { description: true }), e(3, 100, { priority: 2 }, { priority: 0 }), e(4, 110, { dueDate: "2026-11-20" }, { dueDate: null }), e(5, 120, { stateId: "s2" }, { stateId: "s1" })];
  const issue = { createdAt: at(-60), createdById: "u1" };
  const shown = (created: boolean) => historyEvents(issue, history, created).map((x) => `${say(x.line.parts)} @${x.at.slice(17, 19)}`);
  assert.deepEqual(shown(true), ["created the issue @00", "updated the description @20", "set the priority to High and set the due date to Nov 20 @50", "moved from Backlog to Done @00"]);
  assert.deepEqual(shown(false).slice(0, 1), ["updated the description @20"]);
  assert.deepEqual(historyEvents(issue, history, false).at(-1)!.move, { from: "s1", to: "s2" });
});

test("a change made in the Telegram chat or by an email reply ends with where it was made (PLNR-369)", () => {
  const issue = { createdAt: "2026-11-06T10:00:00.000Z", createdById: "u1" };
  const at = (m: number) => `2026-11-06T10:0${m}:00.000Z`;
  const ev = historyEvents(issue, [
    { id: 1, a: "U", by: "u1", at: at(1), d: { priority: 2 }, p: { priority: 0 }, via: "telegram" },
    { id: 2, a: "U", by: "u2", at: at(5), d: { title: "New" }, p: { title: "Old" } },
  ], false);
  assert.equal(ev[0]!.line.parts.at(-1), " · from Telegram");
  assert.notEqual(ev[1]!.line.parts.at(-1), " · from Telegram");
});
