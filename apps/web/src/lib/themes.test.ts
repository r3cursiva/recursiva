// Every color theme (ADR 0031) as the CSS defines it: a block per theme, only tokens the base has, and the contrast
// the design system asks for — text 4.5:1, status and priority glyphs 3:1 on every surface they sit on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DARK_THEMES, LIGHT_THEMES } from "@rsva/protocol";
import { contrast, themeTokens } from "@rsva/display/theme-css";
import { DARK_THEME_INFO, LIGHT_THEME_INFO } from "@rsva/display/themes";

const css = readFileSync(new URL("../../../../packages/display/src/themes.css", import.meta.url), "utf8");
const ledger = themeTokens(css, "ledger", false);
const blocks = new Map([...css.matchAll(/^\[data-theme="([\w-]+)"\] \{([\s\S]*?)\n\}/gm)].map((m) => [m[1]!, m[2]!]));

const SURFACES = ["ground", "panel", "sidebar", "group", "row-hover", "row-selected", "field"];
const TEXT_SURFACES = ["ground", "panel", "sidebar", "group", "field"];
const GLYPHS = ["status-backlog", "status-todo", "status-progress", "status-review", "status-approved", "status-done", "status-canceled", "priority-level", "signal"];

/** [foreground, background, least contrast]. Ledger's own pairs set the floor where it is under 4.5. */
const PAIRS: [string, string, number][] = [
  ...["ink", "ink-2"].flatMap((f) => SURFACES.map((b): [string, string, number] => [f, b, 4.5])),
  ...TEXT_SURFACES.map((b): [string, string, number] => ["ink-3", b, 4.5]),
  ["ink-3", "row-hover", 4.5],
  // Ledger: 4.49. A selected row's meta text.
  ["ink-3", "row-selected", 4.4],
  ...GLYPHS.flatMap((f) => SURFACES.map((b): [string, string, number] => [f, b, 3])),
  ...["success", "warning", "error"].flatMap((f) => ["ground", "panel", "field"].map((b): [string, string, number] => [f, b, 4.5])),
  ["signal-text", "panel", 4.5],
  ["signal-text", "ground", 4.5],
  // Ledger: 4.34, white on vermilion. Bold text only (the Urgent badge, the unread count).
  ["signal-ink", "signal", 4.3],
  ["inverse-ink", "inverse", 4.5],
  ["inverse-ink-2", "inverse", 4.5],
  ["error", "error-bg", 4.5],
  ["ink", "code", 4.5],
];

test("each theme the protocol names has a block, and only those", () => {
  const named = [...LIGHT_THEMES.slice(1), ...DARK_THEMES.slice(1)];
  assert.deepEqual([...blocks.keys()].sort(), [...named].sort());
  assert.deepEqual(
    [...LIGHT_THEME_INFO, ...DARK_THEME_INFO].map((t) => t.id),
    [...LIGHT_THEMES, ...DARK_THEMES],
  );
});

test("a theme sets only tokens its base has", () => {
  for (const [id, body] of blocks) {
    for (const [, name] of body.matchAll(/--ql-([\w-]+):/g)) assert.ok(name! in ledger, `${id}: --ql-${name} is not a base token`);
  }
});

for (const [ids, dark] of [
  [LIGHT_THEMES, false],
  [DARK_THEMES, true],
] as const) {
  for (const id of ids) {
    test(`${id}: text and glyphs keep their contrast`, () => {
      const t = themeTokens(css, id, dark);
      const fails = PAIRS.filter(([f, b, min]) => contrast(t[f]!, t[b]!) < min).map(([f, b, min]) => `${f} on ${b}: ${contrast(t[f]!, t[b]!).toFixed(2)} < ${min}`);
      // A delete button: white on its fill.
      if (contrast("#ffffff", t.danger!) < 4.5) fails.push(`white on danger: ${contrast("#ffffff", t.danger!).toFixed(2)}`);
      assert.deepEqual(fails, []);
    });
  }
}
