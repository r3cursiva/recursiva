import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectComment, ProjectHistoryEntry, ProjectSettingEntry } from "@rsva/protocol";
import type { GithubEvent } from "@rsva/schema/models";
import { dayKey, dayTotals, foldHistory, oneLine, span, stepsOf, type FoldContext, type StateKind, type Tally } from "./project-history.ts";

const words = (agents: Tally, people: Tally) => dayTotals(agents, people).map((t) => `${t.text} (${t.agents}/${t.people})`);

const AGENT = "agent";
const ME = "me";
const KINDS: Record<string, StateKind> = { Todo: "other", Progress: "other", Review: "review", Approved: "approved", Done: "done" };
const ctx = (over: Partial<FoldContext> = {}): FoldContext => ({ level: "outcomes", who: "all", isAgent: (u) => u === AGENT, stateKind: (s) => KINDS[s] ?? "other", ...over });

// Local times, so the day split does not depend on the machine's time zone.
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).toISOString();
let id = 0;
const move = (i: string, by: string, when: string, from: string, to: string): ProjectHistoryEntry => ({ id: ++id, i, a: "U", by, at: when, d: { stateId: to }, p: { stateId: from } });
const remark = (i: string, by: string, when: string): ProjectComment => ({ id: `c${++id}`, i, by, at: when, x: "Looks good", r: null });

const ISSUES = [
  { id: "A", createdAt: at(29, 9), createdById: ME },
  { id: "B", createdAt: at(20, 9), createdById: ME },
];
const ENTRIES = [
  move("A", AGENT, at(29, 10), "Todo", "Progress"),
  move("A", AGENT, at(29, 11, 30), "Progress", "Review"),
  move("A", ME, at(30, 9), "Review", "Approved"),
  move("A", AGENT, at(30, 9, 5), "Approved", "Done"),
  move("B", AGENT, at(30, 8), "Progress", "Review"),
];

test("outcomes: an issue's day folds into one story, its chain from creation or the state it began the day in", () => {
  const days = foldHistory(stepsOf(ISSUES, ENTRIES, [], null), ctx());
  assert.deepEqual(days.map((d) => d.key), [dayKey(at(30, 9)), dayKey(at(29, 9)), dayKey(at(20, 9))], "newest day first");
  const [today, yesterday] = days;
  assert.deepEqual(
    today!.rows.map((r) => (r.kind === "story" ? [r.issueId, r.chain.map((c) => (c.kind === "created" ? "created" : c.stateId)), r.by] : r.kind === "step" && r.step.issueId)),
    [["A", ["Review", "Approved", "Done"], [ME, AGENT]], "B"],
    "the latest first, and an issue with one step that day is that step",
  );
  const a = yesterday!.rows[0]!;
  assert.ok(a.kind === "story");
  assert.deepEqual(a.chain.map((c) => (c.kind === "created" ? "created" : c.stateId)), ["created", "Progress", "Review"]);
  assert.equal(span(a.from, a.to), "2h 30m");
  assert.equal(a.steps.length, 3, "the story keeps its steps for expanding");
});

test("summaries count agents and people apart, whatever the filter shows", () => {
  const [today, yesterday] = foldHistory(stepsOf(ISSUES, ENTRIES, [remark("B", ME, at(30, 12))], null), ctx({ who: "agents" }));
  assert.deepEqual(words(today!.agents, today!.people), ["1 closed (1/0)", "1 to review (1/0)", "1 approved (0/1)"]);
  assert.deepEqual(words(yesterday!.agents, yesterday!.people), ["1 to review (1/0)", "1 created (0/1)"]);
  assert.deepEqual(
    today!.rows.map((r) => (r.kind === "story" ? r.issueId : r.kind === "step" && r.step.by)),
    [AGENT, AGENT],
    "agents only: the owner's approval and comment are left out, so each issue has one step",
  );
});

test("everything: every step its own line, newest first; people only; creations only after where the history starts", () => {
  const steps = stepsOf(ISSUES, ENTRIES, [remark("B", ME, at(30, 12))], at(25, 0));
  assert.equal(steps.filter((s) => s.kind === "created").length, 1, "B was created before the loaded history");
  const [today] = foldHistory(steps, ctx({ level: "everything", who: "people" }));
  assert.deepEqual(
    today!.rows.map((r) => r.kind === "step" && [r.step.kind, r.step.issueId]),
    [
      ["comment", "B"],
      ["entry", "A"],
    ],
  );
});

test("steps: an issue's day is one block, whatever else happened between its steps", () => {
  const entries = [move("A", AGENT, at(30, 9), "Todo", "Progress"), move("B", AGENT, at(30, 10), "Todo", "Progress")];
  const comments = [remark("A", AGENT, at(30, 11)), remark("A", ME, at(30, 12))];
  const [today] = foldHistory(stepsOf(ISSUES, entries, comments, at(25, 0)), ctx({ level: "steps" }));
  assert.deepEqual(
    today!.rows.map((r) => (r.kind === "story" ? [r.issueId, r.steps.length, r.by] : r.kind === "step" && r.step.issueId)),
    [["A", 3, [AGENT, ME]], "B"],
  );
});

test("a story names its pull requests, a merged one as merged; a day counts them apart", () => {
  const event = (verb: "opened" | "merged", number: number | null): GithubEvent => ({ verb, repo: "x/y", number, sha: null, title: "t", state: null, by: "someone", closing: true, at: at(30, 9) });
  const entries = [
    { ...move("A", AGENT, at(30, 9), "Todo", "Progress"), gh: event("opened", 7) },
    { id: ++id, i: "A", a: "U" as const, by: AGENT, at: at(30, 10), d: {}, p: {}, gh: event("opened", 8) },
    { ...move("A", AGENT, at(30, 11), "Progress", "Done"), gh: event("merged", 7) },
  ];
  const [today] = foldHistory(stepsOf(ISSUES, entries, [], at(25, 0)), ctx());
  const row = today!.rows[0]!;
  assert.ok(row.kind === "story");
  assert.deepEqual(row.pulls, [
    { number: 7, merged: true },
    { number: 8, merged: false },
  ]);
  assert.deepEqual(words(today!.agents, today!.people), ["1 closed (1/0)", "1 PR merged (1/0)", "2 PRs opened (2/0)"]);
});

test("comments count in a summary only on a day with nothing else", () => {
  const [today] = foldHistory(stepsOf([], [], [remark("A", ME, at(30, 9)), remark("A", ME, at(30, 10))], null), ctx({ level: "steps" }));
  assert.deepEqual(words(today!.agents, today!.people), ["2 comments (0/2)"]);
});

test("span reads minutes, hours and days; a day of nothing has no totals", () => {
  const none: Tally = { created: 0, review: 0, approved: 0, done: 0, canceled: 0, merged: 0, opened: 0, comments: 0 };
  assert.deepEqual(dayTotals(none, none), []);
  assert.equal(span(at(1, 10), at(1, 10, 40)), "40m");
  assert.equal(span(at(1, 10), at(1, 12)), "2h");
  assert.equal(span(at(1, 10), at(2, 13)), "1d 3h");
  assert.equal(span(at(1, 10), at(1, 10)), "", "less than a minute says nothing");
});

test("oneLine: a comment's Markdown as plain text on one line", () => {
  assert.equal(oneLine("## Done\n\n- [@Robin](mention:me), see **PR** [#19](https://github.com/x/y/pull/19)\n> `ok`"), "Done @Robin, see PR #19 ok");
  assert.equal(oneLine("![shot](/files/a.png) after"), "after");
  assert.equal(oneLine("first\\\nsecond"), "first second", "a hard break is a space");
  const id = "803dfab3-665d-43d2-864a-4be36b168a95";
  assert.equal(oneLine(`@\\[${id}\\] Plan approval · Risk 2`, (u) => (u === id ? "Robin" : undefined)), "@Robin Plan approval · Risk 2", "a mention Plane wrote");
  assert.equal(oneLine(`@\\[${id}\\] Ready for review`), "Ready for review", "a mention of nobody we know leaves the line");
});

test("a creation takes what the issue started with from its I entry, which is no step of its own; an imported one has none", () => {
  const started: ProjectHistoryEntry = { id: ++id, i: "A", a: "I", by: ME, at: at(29, 9), d: { stateId: "Todo", labelIds: ["bug"] }, p: {} };
  const steps = stepsOf(ISSUES, [started, ...ENTRIES], [], null);
  assert.deepEqual(
    steps.filter((s) => s.kind === "created").map((s) => [s.issueId, s.kind === "created" && s.with]),
    [
      ["B", undefined],
      ["A", { stateId: "Todo", labelIds: ["bug"] }],
    ],
  );
  assert.equal(steps.filter((s) => s.kind === "entry").length, ENTRIES.length);
});

test("the project's own changes are rows of their day at everything only, for the people picked", () => {
  const change = (by: string, when: string): ProjectSettingEntry => ({ id: ++id, m: "Label", mid: "l", a: "U", by, at: when, d: { name: "defect" }, p: { name: "bug" } });
  const settings = [change(ME, at(30, 9, 1)), change(AGENT, at(31, 9))];
  const steps = stepsOf(ISSUES, ENTRIES, [], at(25, 0));
  const kinds = (days: ReturnType<typeof foldHistory>) => days.map((d) => [d.key, d.rows.map((r) => r.kind)]);
  assert.deepEqual(kinds(foldHistory(steps, ctx({ level: "steps" }), settings)).map(([k]) => k), [dayKey(at(30, 9)), dayKey(at(29, 9))], "steps: no day of their own");
  const everything = foldHistory(steps, ctx({ level: "everything" }), settings);
  assert.deepEqual(everything[0]!.key, dayKey(at(31, 9)), "a day with only a change of the project's");
  assert.deepEqual(everything[1]!.rows.map((r) => (r.kind === "setting" ? "setting" : r.kind === "step" && r.step.at)), [at(30, 9, 5), "setting", at(30, 9), at(30, 8)], "in time order with the issues' steps");
  assert.deepEqual(kinds(foldHistory(steps, ctx({ level: "everything", who: "people" }), settings))[0], [dayKey(at(30, 9)), ["setting", "step"]], "the people's only, newest first");
});
