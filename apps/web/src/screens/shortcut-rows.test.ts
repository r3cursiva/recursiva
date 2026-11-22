import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type Press, SECTIONS } from "./shortcut-rows.ts";

const presses = (section: string, label: RegExp): string[] => {
  const row = SECTIONS.find((s) => s.title === section)?.rows.find((r) => label.test(r[0]));
  assert.ok(row, `no row ${label} in ${section}`);
  return row.slice(1).map((p) => (typeof p === "string" ? p : (p as Press).keys.join("+")));
};
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

test("My work: 1–9 jump to a section, 0 switches to All workspaces, as the handler does", () => {
  assert.deepEqual(presses("My work", /^A section$/), ["1 – 9"]);
  assert.deepEqual(presses("My work", /^All workspaces$/), ["0"]);
  const code = source("./my-work.tsx");
  assert.match(code, /k === "0"\) view\.setScope\("all"\)/);
  assert.match(code, /k >= "1" && k <= "9"/);
});

test("History: the level keys are the ASCII - and =, which the handler compares with", () => {
  const keys = presses("History", /^Level$/);
  assert.ok(keys.includes("-") && keys.includes("="));
  assert.ok(!keys.some((k) => k.includes("−")));
  assert.match(source("./project-history.tsx"), /k === "-" \? at - 1/);
});

test("Lists: E opens the View panel and Shift with the arrows marks, as the handlers do", () => {
  assert.deepEqual(presses("Lists and boards", /View panel/).sort(), ["E", "F"]);
  assert.match(source("./view-tabs.tsx"), /key === "e" \|\| key === "f"/);
  const marks = presses("Lists and boards", /^Mark while moving$/);
  assert.ok(marks.includes("Shift+↑") || marks.includes("⇧+↑"), marks.join());
  assert.match(source("./issue-list.tsx"), /e\.shiftKey && by/);
});

test("Decisions: the sheet lists the keys the screen's commandOf takes, and G D goes there", () => {
  assert.deepEqual(presses("Go to", /^Decisions$/), ["G+D"]);
  assert.match(source("../shortcuts.ts"), /chord === "g" && key === "d"/);
  const code = source("../lib/decisions.ts");
  for (const [label, key] of [
    [/^Skip, open/, "s"],
    [/own words/, "r"],
    [/same way/, "a"],
    [/^Undo/, "z"],
    [/leave an issue/i, "x"],
  ] as const) {
    assert.ok(presses("Decisions", label).some((p) => p.toLowerCase() === key), `${label} lists ${key}`);
    assert.match(code, new RegExp(`k === "${key}"`));
  }
});
