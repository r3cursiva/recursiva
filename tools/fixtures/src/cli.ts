// node tools/fixtures/src/cli.ts <sample|10k|demo> [--seed N] [--slug S] [--out file.ndjson]
// Writes a synthetic import bundle; without --out, to stdout. Import it with `pnpm --filter @rsva/server import <file>`.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { toNdjson } from "@rsva/schema/bundle";
import { demo } from "./demo.ts";
import { generate, PRESETS, type PresetName } from "./generate.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { seed: { type: "string" }, slug: { type: "string" }, out: { type: "string" } },
});
const preset = positionals[0] as PresetName | "demo" | undefined;
if (!preset || (preset !== "demo" && !(preset in PRESETS))) {
  console.error(`usage: cli.ts <${[...Object.keys(PRESETS), "demo"].join("|")}> [--seed N] [--slug S] [--out file]`);
  process.exit(2);
}
// The demo workspace (README pictures) has its own slug and fixed contents: no --slug or --seed.
const body = toNdjson(preset === "demo" ? demo() : generate(preset, { seed: Number(values.seed ?? 1), slug: values.slug ?? preset }));
if (values.out) writeFileSync(values.out, body);
else process.stdout.write(body);
