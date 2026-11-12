// The lab in `pnpm test`: every scenario against a local server of its own, with a few random runs.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fuzz, SCENARIOS, type Scenario } from "./scenarios.ts";
import { FAST, runScenario } from "./run.ts";
import { localTarget, type Target } from "./target.ts";

let target: Target;
before(async () => {
  target = await localTarget();
});
after(() => target.stop());

const random = (seed: number): Scenario => ({ id: `fuzz.${seed}`, title: `random edits and faults, seed ${seed}: everyone converges`, run: (lab) => fuzz(lab, seed, 80) });

for (const s of [...SCENARIOS, random(1), random(2), random(3)]) {
  test(`${s.id}: ${s.title}`, async () => {
    const o = await runScenario(target, s, FAST, 3000);
    assert.ok(o.ok, o.error ?? s.id);
  });
}
