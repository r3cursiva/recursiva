// Runs scenarios against a target, each with two fresh computers.
import type { SyncStoreOptions } from "@rsva/sync";
import { until } from "@rsva/test-kit";
import { Computer } from "./computer.ts";
import { fuzz, SCENARIOS, type Lab, type Scenario } from "./scenarios.ts";
import type { Target } from "./target.ts";
import { errorText } from "@rsva/schema/util";

/** The engine's link checks, short enough for a test. */
export const FAST: Partial<SyncStoreOptions> = { link: { every: 400, pong: 500, ack: 200, connect: 800, stall: 1000, stable: 2000 }, backoff: [50, 300] };

export interface Outcome {
  id: string;
  title: string;
  ok: boolean;
  ms: number;
  notes: Record<string, number>;
  error?: string;
}

async function withLab(target: Target, engine: Partial<SyncStoreOptions>, bound: number, notes: Record<string, number>, run: (lab: Lab) => Promise<void>): Promise<void> {
  const a = new Computer("A", target, target.tokens.a, engine);
  const b = new Computer("B", target, target.tokens.b, engine);
  try {
    await Promise.all([a.open(), b.open()]);
    await until(() => a.store.connection === "online" && b.store.connection === "online", 20_000, "both computers connect");
    await run({ target, a, b, bound, note: (k, v) => (notes[k] = v) });
  } finally {
    a.close();
    b.close();
  }
}

export async function runScenario(target: Target, s: Scenario, engine: Partial<SyncStoreOptions>, bound: number): Promise<Outcome> {
  const notes: Record<string, number> = {};
  const t0 = performance.now();
  try {
    await withLab(target, engine, bound, notes, s.run);
    return { id: s.id, title: s.title, ok: true, ms: Math.round(performance.now() - t0), notes };
  } catch (e) {
    return { id: s.id, title: s.title, ok: false, ms: Math.round(performance.now() - t0), notes, error: errorText(e) };
  }
}

export async function runAll(target: Target, opts: { only?: RegExp; engine: Partial<SyncStoreOptions>; bound: number; seeds: number[]; steps: number; log?: (o: Outcome) => void }): Promise<Outcome[]> {
  const out: Outcome[] = [];
  const scenarios = SCENARIOS.filter((s) => (target.name === "local" || !s.local) && (!opts.only || opts.only.test(s.id)));
  for (const seed of opts.only && !opts.only.test("fuzz") ? [] : opts.seeds) {
    scenarios.push({ id: `fuzz.${seed}`, title: `random edits and faults, seed ${seed}: everyone converges`, run: (lab) => fuzz(lab, seed, opts.steps) });
  }
  for (const s of scenarios) {
    const o = await runScenario(target, s, opts.engine, opts.bound);
    out.push(o);
    opts.log?.(o);
  }
  return out;
}
