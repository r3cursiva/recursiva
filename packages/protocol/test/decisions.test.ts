import assert from "node:assert/strict";
import { test } from "node:test";
import { askKind, formatAnswer, formatAsk, parseAnswer, parseAsk, ruleText, type Ask } from "../src/decisions.ts";

const BACKUPS = [
  "**Question:** How long should backups be kept on the new box?",
  "",
  "1. 30 daily, 12 monthly — about 1.1 TB of the 4 TB",
  "2. 7 daily, 4 weekly, as now — 0.3 TB",
  "3. 14 daily, 6 monthly",
  "",
  "Recommended: 1. OBASE-80 needs 30 days of audit history, and there is room.",
  "",
  "Evidence:",
  "- `backup/retention.yml:12`",
  "- OBASE-80",
  "- #412",
].join("\n");

test("an agent's question: the question, its options with details, the recommendation and its reason, the evidence", () => {
  const a = parseAsk(BACKUPS);
  assert.ok(a);
  assert.equal(a.kind, "question");
  assert.equal(a.question, "How long should backups be kept on the new box?");
  assert.deepEqual(a.options, [
    { label: "30 daily, 12 monthly", detail: "about 1.1 TB of the 4 TB" },
    { label: "7 daily, 4 weekly, as now", detail: "0.3 TB" },
    { label: "14 daily, 6 monthly", detail: "" },
  ]);
  assert.equal(a.recommended, 0);
  assert.equal(a.why, "OBASE-80 needs 30 days of audit history, and there is room.");
  assert.deepEqual(a.evidence, ["`backup/retention.yml:12`", "OBASE-80", "#412"]);
  assert.equal(a.group, null);
});

test("what does not fit is an ordinary comment: no mark, one option, five, a gap in the numbers, no recommendation", () => {
  assert.equal(parseAsk("How long should backups be kept?\n\n1. A\n2. B\n\nRecommended: 1"), null);
  assert.equal(parseAsk("**Question:** Which?\n\n1. A\n\nRecommended: 1"), null);
  assert.equal(parseAsk("**Question:** Which?\n\n1. A\n2. B\n3. C\n4. D\n5. E\n\nRecommended: 1"), null);
  assert.equal(parseAsk("**Question:** Which?\n\n1. A\n3. B\n\nRecommended: 1"), null);
  assert.equal(parseAsk("**Question:** Which?\n\n1. A\n2. B"), null);
  assert.equal(parseAsk("**Question:** Which?\n\n1. A\n2. B\n\nRecommended: 3"), null);
  assert.equal(parseAsk("**Question:**\n\n1. A\n2. B\n\nRecommended: 1"), null);
});

test("close proposals and hand-offs by their mark; a group names close proposals answered together", () => {
  const close = parseAsk("**Close proposal:** Close OPTO-6 as obsolete?\n\n1. Close as obsolete — the sale ended\n2. Keep it\n\nRecommended: 1\n\nGroup: Already shipped");
  assert.equal(close?.kind, "close");
  assert.equal(close?.group, "Already shipped");
  assert.equal(close?.why, "");
  assert.equal(askKind("  **Hand-off:** Hand RSVA-329 to Claude?"), "hand");
  assert.equal(askKind("**Answer:** 1. Yes"), null);
});

test("formatAsk writes what parseAsk reads back", () => {
  const a = parseAsk(BACKUPS)!;
  assert.deepEqual(parseAsk(formatAsk(a)), a);
  const g: Ask = { ...a, kind: "close", group: "Duplicates", evidence: [] };
  assert.deepEqual(parseAsk(formatAsk(g)), g);
});

test("an answer names the option by number, or carries the person's words; the agent reads either back", () => {
  const picked = formatAnswer({ option: 1, label: "7 daily, 4 weekly, as now" });
  assert.equal(picked, "**Answer:** 2. 7 daily, 4 weekly, as now");
  assert.deepEqual(parseAnswer(picked), { option: 1, text: "7 daily, 4 weekly, as now" });
  assert.deepEqual(parseAnswer(formatAnswer({ text: " Keep 30 daily, monthly to the cold bucket " })), { option: null, text: "Keep 30 daily, monthly to the cold bucket" });
  assert.equal(parseAnswer("Thanks!"), null);
});

test("a rule reads as one sentence", () => {
  assert.equal(ruleText({ project: "INFRA", question: "How long?", answer: "30 daily" }), "In INFRA, when asked “How long?”, answer “30 daily”.");
});
