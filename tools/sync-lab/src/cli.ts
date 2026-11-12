// pnpm sync:lab                               every scenario against a local server of its own
// pnpm sync:lab --only 'net\.' --seeds 1,2,3  some of them; --seeds picks the fuzz runs
// pnpm sync:lab --url https://app.rsva.dev --ws sync-lab
//                                             production, in the lab's workspace; tokens in LAB_TOKEN_A and LAB_TOKEN_B
// --json <file> writes the outcomes.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { FAST, runAll, type Outcome } from "./run.ts";
import { localTarget, prodTarget } from "./target.ts";

const { values } = parseArgs({
  options: { url: { type: "string" }, ws: { type: "string", default: "sync-lab" }, only: { type: "string" }, seeds: { type: "string", default: "1,2,3" }, steps: { type: "string", default: "60" }, json: { type: "string" } },
});
const prod = !!values.url;
const target = prod ? prodTarget(values.url!, values.ws, { a: process.env.LAB_TOKEN_A ?? "", b: process.env.LAB_TOKEN_B ?? "" }) : await localTarget(values.ws);
if (prod && (!target.tokens.a || !target.tokens.b)) throw new Error("LAB_TOKEN_A and LAB_TOKEN_B are not set");

const line = (o: Outcome) => console.log(`${o.ok ? "ok  " : "FAIL"} ${o.id.padEnd(22)} ${String(o.ms).padStart(7)} ms  ${Object.entries(o.notes).map(([k, v]) => `${k}=${v}`).join(" ")}${o.error ? `\n     ${o.error.split("\n")[0]}` : ""}`);
const outcomes = await runAll(target, {
  ...(values.only ? { only: new RegExp(values.only) } : {}),
  // Production keeps the engine's own times: what a person would get. Locally they are short, so a run takes a minute.
  engine: prod ? {} : FAST,
  bound: prod ? 20_000 : 3000,
  seeds: values.seeds.split(",").filter(Boolean).map(Number),
  steps: Number(values.steps),
  log: line,
});
await target.stop();
if (values.json) writeFileSync(values.json, JSON.stringify(outcomes, null, 2));
const failed = outcomes.filter((o) => !o.ok);
console.log(`\n${outcomes.length - failed.length} of ${outcomes.length} passed`);
process.exit(failed.length ? 1 : 0);
