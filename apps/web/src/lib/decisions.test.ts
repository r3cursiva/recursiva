import assert from "node:assert/strict";
import { test } from "node:test";
import type { Decision } from "@rsva/schema/models";
import { buildQueue, canRule, commandOf, evidenceOf, Sitting, UNDO_MS, unblockCounts, type Card, type Entry } from "./decisions.ts";

const ask = (n: number, extra: Partial<Decision> = {}): Decision => ({
  id: `c${n}`,
  issueId: `i${n}`,
  kind: "question",
  question: `Question ${n}?`,
  options: [
    { label: "Yes", detail: "", why: "" },
    { label: "No", detail: "", why: "" },
    { label: "Later", detail: "", why: "" },
  ],
  recommended: 0,
  evidence: [],
  topic: null,
  criteria: [],
  askedById: "agent",
  status: "open",
  answer: null,
  answerOption: null,
  answeredById: null,
  answeredAt: null,
  commentId: null,
  answerCommentId: null,
  ruleId: null,
  createdAt: `2026-11-0${n}T10:00:00Z`,
  ...extra,
});
const none = () => 0;

test("the queue: most unblocking first, the oldest among equals; Oldest ignores what they unblock; skipped go last", () => {
  const open = [ask(1), ask(2), ask(3)];
  const unblocks = (id: string) => ({ i2: 2, i3: 2 })[id] ?? 0;
  assert.deepEqual(buildQueue(open, unblocks, "unblocks").map((c) => c.id), ["c2", "c3", "c1"]);
  assert.deepEqual(buildQueue(open, unblocks, "oldest").map((c) => c.id), ["c1", "c2", "c3"]);
  assert.deepEqual(buildQueue(open, unblocks, "unblocks", ["c2"]).map((c) => c.id), ["c3", "c1", "c2"]);
});

test("unblocks counts the open issues blocked by an issue", () => {
  const of = unblockCounts(
    [
      { id: "a", blockedByIds: ["x"] },
      { id: "b", blockedByIds: ["x", "y"] },
      { id: "done", blockedByIds: ["x"] },
    ],
    (i) => i.id !== "done",
  );
  assert.deepEqual([of("x"), of("y"), of("z")], [2, 1, 0]);
});

test("questions of one kind and topic with the same options are one card; a lone one, other options or another kind stay apart", () => {
  const close = (n: number, topic: string | null, options = ask(n).options) => ask(n, { kind: "close", topic, options, question: `Close CORE-${n}?` });
  const open = [
    close(1, "Already shipped"),
    close(2, "Already shipped"),
    close(3, "Already shipped", [
      { label: "Close", detail: "", why: "" },
      { label: "Keep", detail: "", why: "" },
    ]),
    close(4, "Duplicates"),
    close(5, null),
    ask(6, { topic: "Already shipped" }),
  ];
  const q = buildQueue(open, (id) => (id === "i2" ? 3 : 0), "unblocks");
  const group = q.find((c) => c.members.length > 1)!;
  assert.deepEqual(group.members.map((m) => m.id), ["c1", "c2"]);
  assert.equal(group.question, "Already shipped: close 2 issues?");
  assert.equal(group.unblocks, 3);
  assert.deepEqual(group.each, [0, 3]);
  assert.equal(q.length, 5, "c3, c4, c5 and the question c6 are cards of their own");
});

test("hand-offs never group and offer no rule: each one's Done when is read before it is handed over", () => {
  const hand = (n: number) => ask(n, { kind: "handoff", topic: "small fixes", criteria: [`Fix ${n} works`] });
  const q = buildQueue([hand(1), hand(2)], none, "oldest");
  assert.deepEqual(q.map((c) => c.members.length), [1, 1]);
  assert.equal(canRule(q[0]!), false);
  assert.equal(canRule(buildQueue([ask(3, { topic: "courier" })], none, "oldest")[0]!), true);
});

const card = (options = 3, members = 1): Card => buildQueue([ask(1, { options: ask(1).options.slice(0, options) }), ...Array.from({ length: members - 1 }, (_, i) => ask(i + 2))], none, "oldest")[0]!;
const key = (key: string, mods: Partial<KeyboardEvent> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("keys: a digit answers with its option, Enter the recommendation, S skips, O opens; a digit past the options does nothing", () => {
  const c = { ...card(), recommended: 2 };
  assert.deepEqual(commandOf(key("2"), c), { t: "answer", option: 1 });
  assert.equal(commandOf(key("4"), c), null);
  assert.deepEqual(commandOf(key("Enter"), c), { t: "answer", option: 2 });
  assert.deepEqual(commandOf(key("s"), c), { t: "skip" });
  assert.deepEqual(commandOf(key("S", { shiftKey: true }), c), { t: "skip" });
  assert.deepEqual(commandOf(key("o"), c), { t: "open" });
  assert.deepEqual(commandOf(key("z"), c), { t: "undo" });
  assert.deepEqual(commandOf(key("z"), null), { t: "undo" }, "Z undoes on the empty queue too");
  assert.equal(commandOf(key("1"), null), null);
  assert.equal(commandOf(key("1", { metaKey: true }), c), null, "⌘1 is the browser's");
  assert.deepEqual([commandOf(key("j"), c), commandOf(key("k"), c)], [{ t: "move", by: 1 }, { t: "move", by: -1 }]);
  assert.equal(commandOf(key("x"), c), null, "X checks in a group only");
  assert.equal(commandOf(key("Enter"), c, true), null, "Enter on a focused button presses that button");
  assert.equal(commandOf(key(" "), c, true), null);
  assert.deepEqual(commandOf(key("2"), c, true), { t: "answer", option: 1 }, "a digit still answers");
});

function clock() {
  let now = 0;
  const due: { at: number; f: () => void; id: number }[] = [];
  let n = 0;
  return {
    now: () => now,
    set: (f: () => void, ms: number) => {
      due.push({ at: now + ms, f, id: ++n });
      return n as unknown as ReturnType<typeof setTimeout>;
    },
    clear: (t: ReturnType<typeof setTimeout>) => {
      const i = due.findIndex((d) => d.id === (t as unknown as number));
      if (i >= 0) due.splice(i, 1);
    },
    tick(ms: number) {
      now += ms;
      for (const d of due.filter((x) => x.at <= now)) {
        due.splice(due.indexOf(d), 1);
        d.f();
      }
    },
  };
}

test("an answer is held for the undo window, then posted; Z within it takes the last one back and nothing is posted", () => {
  const posted: Entry[] = [];
  const c = clock();
  const s = new Sitting((e) => posted.push(e), c);
  const a = card();
  s.answer(a, { option: 0, label: "Yes" }, false);
  assert.ok(s.answered.has("c1"), "it leaves the queue at once");
  c.tick(UNDO_MS - 1);
  assert.equal(posted.length, 0);
  assert.equal(s.undo()?.card.id, "c1");
  assert.equal(s.answered.size, 0, "back in the queue");
  c.tick(UNDO_MS);
  assert.equal(posted.length, 0, "taken back: never posted");

  s.answer(a, { option: 1, label: "No" }, false);
  c.tick(UNDO_MS);
  assert.deepEqual(posted.map((e) => e.answer), [{ option: 1, label: "No" }]);
  assert.equal(s.undo(), null, "posted: past undoing");
  assert.equal(s.canUndo, false);
});

test("leaving the page posts what is held", () => {
  const posted: Entry[] = [];
  const s = new Sitting((e) => posted.push(e), clock());
  s.answer(card(), { text: "Ship with Speedy, but not to the islands" }, false);
  s.flush();
  assert.equal(posted.length, 1);
  s.flush();
  assert.equal(posted.length, 1, "once");
});

test("a group's unchecked members are left out of the answer and of the summary", () => {
  const s = new Sitting(() => {}, clock());
  const g = buildQueue([1, 2, 3].map((n) => ask(n, { kind: "close", topic: "Duplicates", askedById: n === 3 ? "other" : "agent" })), (id) => (id === "i3" ? 4 : 1), "oldest")[0]!;
  const e = s.answer(g, { option: 0, label: "Yes" }, true, g.members.slice(0, 2));
  assert.deepEqual(e.members.map((m) => m.id), ["c1", "c2"]);
  assert.equal(e.rule, false, "a group saves no rule");
  assert.deepEqual(s.summary, { decisions: 2, unblocked: 2, askers: 1, minutes: 0, rules: [] });
  assert.ok(!s.answered.has("c3"), "the unchecked one stays in the queue");
});

test("the summary counts what was answered and the rules saved, and the time from the first answer to the last", () => {
  const c = clock();
  const s = new Sitting(() => {}, c);
  s.answer(buildQueue([ask(1, { topic: "courier" })], none, "oldest")[0]!, { option: 0, label: "Yes" }, true);
  c.tick(3 * 60_000);
  const e = s.answer(buildQueue([ask(2)], () => 2, "oldest")[0]!, { text: "Not now" }, true);
  assert.equal(e.rule, false, "no topic, no rule: a rule answers a topic, never a question's words");
  const sum = s.summary;
  assert.deepEqual(sum, { decisions: 2, unblocked: 2, askers: 1, minutes: 3, rules: ["“courier” is answered “Yes”"] });
});

test("evidence lines: a path in backticks, an issue's key, a pull request, else a fact", () => {
  assert.deepEqual(evidenceOf("`backup/retention.yml:12`"), { t: "code", text: "backup/retention.yml:12" });
  assert.deepEqual(evidenceOf("OBASE-80"), { t: "issue", key: "OBASE-80" });
  assert.deepEqual(evidenceOf("#412 restic: forget policy"), { t: "pr", text: "#412 restic: forget policy" });
  assert.deepEqual(evidenceOf("41 orders · median €48"), { t: "fact", text: "41 orders · median €48" });
});
