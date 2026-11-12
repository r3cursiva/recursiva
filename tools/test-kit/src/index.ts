// Complexity guards for tests that must not depend on how fast or how busy the machine is (PLNR-190, ADR 0030).
//
// A bound in milliseconds measures the machine: a shared CI runner runs every package's tests at once and the same
// work takes 5 to 50 times longer there than on a Mac, differently from run to run. What these tests guard is the shape
// of the cost, so they compare the code with itself at the same moment: k runs on an input k times smaller against one
// run on the full input. Equal work on both sides, sampled in alternation, so a busy machine slows both alike.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

/** Linear code reads about 1, n log n a little more, quadratic about k. */
export function growth(small: () => unknown, large: () => unknown, k: number, samples = 9): number {
  small();
  large();
  const ratios: number[] = [];
  for (let s = 0; s < samples; s++) {
    const t0 = performance.now();
    for (let i = 0; i < k; i++) small();
    const t1 = performance.now();
    large();
    ratios.push((performance.now() - t1) / (t1 - t0));
  }
  return quantile(ratios, 0.5);
}

/** The value at fraction `q` of the sorted copy of `xs` (index `floor(n * q)`, no interpolation); `xs` must not be empty. */
export function quantile(xs: readonly number[], q: number): number {
  return [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))]!;
}

/** Input k times larger, time up at most `limit` times per unit of input: far from quadratic (k) on either side. */
export const K = 16;
const LIMIT = 6;

/** Fails when `run` grows faster than about linearly from `size(n / K)` to `size(n)`. */
export function assertLinear<T>(name: string, size: (n: number) => T, run: (input: T) => unknown, n: number): number {
  const small = size(Math.round(n / K));
  const large = size(n);
  const g = growth(() => run(small), () => run(large), K);
  assert.ok(g < LIMIT, `${name}: ${g.toFixed(1)}× per unit of input from ${n / K} to ${n} (linear is about 1, quadratic ${K})`);
  return g;
}

/**
 * Waits for a condition something reaches asynchronously (a server, a socket, timers): checks it every `every` ms and
 * resolves with how long it took, or fails after `ms`, naming `what`. The check interval bounds what a reported time can
 * tell apart, so a caller that measures with it keeps its own.
 */
export async function until(cond: () => boolean, ms: number, what: string, every = 10): Promise<number> {
  const t0 = performance.now();
  for (;;) {
    if (cond()) return Math.round(performance.now() - t0);
    if (performance.now() - t0 > ms) throw new Error(`not within ${ms} ms: ${what}`);
    await sleep(every);
  }
}
