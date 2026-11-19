// node tools/fixtures/src/cli.ts <sample|10k> [--seed N] [--slug S] [--out file.ndjson]
// Writes a synthetic import bundle; without --out, to stdout. Import it with `pnpm --filter @rsva/server import <file>`.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { toNdjson } from "@rsva/schema/bundle";
import { generate, PRESETS, type PresetName } from "./generate.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { seed: { type: "string" }, slug: { type: "string" }, out: { type: "string" } },
});
const preset = positionals[0] as PresetName | undefined;
if (!preset || !(preset in PRESETS)) {
  console.error(`usage: cli.ts <${Object.keys(PRESETS).join("|")}> [--seed N] [--slug S] [--out file]`);
  process.exit(2);
}
// The demo workspace (Lumen) is the server's own: a server started with RSVA_DEMO=on makes it (apps/server/src/demo).
const body = toNdjson(generate(preset, { seed: Number(values.seed ?? 1), slug: values.slug ?? preset }));
if (values.out) writeFileSync(values.out, body);
else process.stdout.write(body);
