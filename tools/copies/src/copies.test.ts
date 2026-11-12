import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALLOWED } from "./allowed.ts";
import { constantOf, findCopies, MENU, report, rules, type Allowed } from "./copies.ts";

const menu = readFileSync(join(import.meta.dirname, "../../..", MENU), "utf8");
const all = rules(menu);
const SURFACE = constantOf(menu, "POPUP_SURFACE");
const MOTION = constantOf(menu, "POPUP_MOTION");
const SIDES = constantOf(menu, "POPUP_SIDES");

/** The rules a line breaks, in a file that is no rule's home. */
function broken(line: string, path = "apps/web/src/screens/x.tsx"): string[] {
  return findCopies([{ path, text: line }], all, []).copies.map((c) => c.rule.id);
}

test("issue key: a key spelled out as a regex is a copy", () => {
  assert.deepEqual(broken("const KEY = /([A-Z][A-Z0-9]*-\\d+)/g;"), ["issue-key"]);
  assert.deepEqual(broken("assert.match(t, /assigned [A-Z]+-\\d+ to you/);"), ["issue-key"]);
  assert.deepEqual(broken('new RegExp("^[A-Z][A-Z0-9]{0,11}-[1-9][0-9]*$")'), ["issue-key"]);
  assert.deepEqual(broken("const k = /^[a-z][a-z0-9]*-\\d*$/;"), ["issue-key"]);
});

test("issue key: the shared pattern and other dashes are not", () => {
  assert.deepEqual(broken("const REF = new RegExp(`(?<!/)${ISSUE_KEY}`, 'gu');"), []);
  assert.deepEqual(broken("const DAY = /^\\d{4}-\\d{2}-\\d{2}$/;"), []);
  assert.deepEqual(broken("if (!/[A-Z0-9]-[1-9]/.test(text)) return [];"), []);
  assert.deepEqual(broken("assert.match(key, /^CORE-\\d+$/);"), []);
});

test("plural: an s or a word chosen by hand is a copy", () => {
  assert.deepEqual(broken("`${n} issue${n === 1 ? \"\" : \"s\"}`"), ["plural"]);
  assert.deepEqual(broken("`${n} issue${n !== 1 ? 's' : ''}`"), ["plural"]);
  assert.deepEqual(broken("`${done} ${done === 1 ? \"issue\" : \"issues\"} done`"), ["plural"]);
  assert.deepEqual(broken("{w.members} {w.members === 1 ? \"member\" : \"members\"}"), ["plural"]);
  assert.deepEqual(broken("`Move its ${count} work ${count === 1 ? \"item\" : \"items\"} to`"), ["plural"]);
});

test("plural: other choices on one are not", () => {
  assert.deepEqual(broken('`${plural(n, "issue")} match`'), []);
  // A verb agreeing with its count, and a word without its count.
  assert.deepEqual(broken('`${n} stay${n === 1 ? "s" : ""} unfinished`'), []);
  assert.deepEqual(broken('head(d.pulls.length === 1 ? "PULL REQUEST" : "PULL REQUESTS");'), []);
  // A different count on each side.
  assert.deepEqual(broken('`${a} ${b === 1 ? "issue" : "issues"}`'), []);
});

test("popup classes: a line holding every class of a constant is a copy, in any order", () => {
  assert.deepEqual(broken(`className="sheet fixed ${SURFACE} outline-none"`), ["popup-surface"]);
  assert.deepEqual(broken(`cn("z-50", "${SURFACE.split(" ").reverse().join(" ")}")`), ["popup-surface"]);
  assert.deepEqual(broken(`"duration-100 ${MOTION}"`), ["popup-motion"]);
  assert.deepEqual(broken(`"${SIDES} origin-(--transform-origin)"`), ["popup-sides"]);
});

test("popup classes: the constants themselves and a part of them are not", () => {
  assert.deepEqual(broken("className={cn('sheet z-50', POPUP_SURFACE, POPUP_MOTION, POPUP_SIDES)}"), []);
  assert.deepEqual(broken('"rounded-(--float-radius) bg-popover text-popover-foreground ring-1 ring-foreground/10"'), []);
  assert.deepEqual(broken('"data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2"'), []);
  assert.deepEqual(broken(`const POPUP_SURFACE = "${SURFACE}";`, MENU), []);
});

test("a rule's scope limits the files it reads (the shape RSVA-124's raw <select> would take)", () => {
  const select = { id: "raw-select", what: "a raw <select>", use: "Select from @rsva/ui", home: [], scope: ["apps/web/src/"], matches: (l: string) => /<select\b/.test(l) };
  const at = (path: string) => findCopies([{ path, text: "<select>" }], [select], []).copies.length;
  assert.equal(at("apps/web/src/screens/x.tsx"), 1);
  assert.equal(at("packages/ui/src/components/select.tsx"), 0);
});

test("an allowance takes exactly its count: one more fails, one fewer is out of date", () => {
  const file = "apps/web/src/a.ts";
  const two = "/[A-Z]+-\\d+/\n/[A-Z]+-\\d+/";
  const allow = (count: number): Allowed[] => [{ rule: "issue-key", file, count, reason: "test" }];
  const run = (text: string, count: number) => findCopies([{ path: file, text }], all, allow(count));
  assert.deepEqual(run(two, 2), { copies: [], stale: [] });
  const over = run(two, 1);
  assert.deepEqual(over.copies.map((c) => c.line), [1, 2]);
  assert.match(report(over.copies, over.stale, allow(1))[0]!, /^apps\/web\/src\/a\.ts:1: an issue key pattern \(allowed 1 here\); use ISSUE_KEY/);
  const under = run(two, 3);
  assert.deepEqual(under.stale.map((s) => s.found), [2]);
  assert.match(report(under.copies, under.stale, allow(3))[0]!, /lower the count to 2/);
  assert.match(report([], run("", 1).stale, allow(1))[0]!, /remove the entry/);
});

test("every allowance names a rule that exists and gives a reason", () => {
  const ids = new Set(all.map((r) => r.id));
  for (const a of ALLOWED) {
    assert.ok(ids.has(a.rule), `${a.file}: no rule ${a.rule}`);
    assert.ok(a.reason && a.count > 0, `${a.file}: reason and a positive count`);
  }
});
