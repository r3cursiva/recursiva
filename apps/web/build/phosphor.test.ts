import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { iconModules, usedIcons, weightElements } from "./phosphor.ts";

const dist = dirname(createRequire(import.meta.url).resolve("@phosphor-icons/react"));

test("weights are collected per importing file and add up across files", () => {
  const used = usedIcons([
    `import { CheckIcon, type Icon, XIcon as Close } from "@phosphor-icons/react";\nconst G = { a: { Icon: CheckIcon, weight: "fill" } };`,
    `import { CheckIcon } from "@phosphor-icons/react";\n<CheckIcon weight="bold" />`,
    `import { CaretDownIcon } from "@phosphor-icons/react";`,
    `const weight = "duotone"; // no Phosphor import here`,
  ]);
  assert.deepEqual([...used.keys()].sort(), ["CaretDownIcon", "CheckIcon", "XIcon"]);
  // Paired with fill in one file and bold in another; no file draws it without a weight.
  assert.deepEqual([...used.get("CheckIcon")!].sort(), ["bold", "fill"]);
  assert.deepEqual([...used.get("CaretDownIcon")!], ["regular"]);
});

test("an icon paired with its weight gets just that; the file's other icons get its weights and regular", () => {
  const used = usedIcons([
    `import { CircleIcon, EyeIcon as Look, CellSignalHighIcon } from "@phosphor-icons/react";
const G = { a: { Icon: CircleIcon, weight: "bold" } };
const L = { 2: CellSignalHighIcon };
<Look data-slot="x" weight="fill" />`,
  ]);
  assert.deepEqual([...used.get("CircleIcon")!], ["bold"]);
  assert.deepEqual([...used.get("EyeIcon")!], ["fill"]);
  assert.deepEqual([...used.get("CellSignalHighIcon")!].sort(), ["bold", "fill", "regular"]);
});

test("every weight of a definition file comes out whole, with React renamed", () => {
  const els = weightElements(readFileSync(join(dist, "defs/CircleDashed.es.js"), "utf8"));
  assert.deepEqual([...els.keys()].sort(), ["bold", "duotone", "fill", "light", "regular", "thin"]);
  for (const [w, src] of els) {
    assert.match(src, /^\/\* @__PURE__ \*\/ R\.createElement\(R\.Fragment/, w);
    assert.equal((src.match(/\(/g) ?? []).length, (src.match(/\)/g) ?? []).length, `${w}: balanced`);
  }
});

test("one module per icon with only the weights asked for, and an index re-exporting the package", () => {
  const mods = iconModules(dist, new Map([["CheckIcon", new Set(["regular"])], ["CircleHalfIcon", new Set(["regular", "fill"])]]));
  const [index, , check, half] = [...mods.values()];
  assert.match(index!, /export \* from ".*index\.es\.js";\nexport \{ CheckIcon \} from "\\u0000rsva-phosphor:icon:CheckIcon";/);
  assert.match(check!, /export const CheckIcon = .*\["regular", /);
  assert.doesNotMatch(check!, /"fill"|"bold"|"duotone"|"thin"|"light"/);
  assert.match(half!, /\["regular", .*\["fill", /s);
});
