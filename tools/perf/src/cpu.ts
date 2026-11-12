// CPU calibration shared by the perf checks: budgets were set on the owner's Mac, and CPU-bound timings from a slower
// machine (a CI runner is 2–3× slower) are divided by its measured slowdown.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { ROOT } from "./report.ts";

/**
 * A fixed JS workload in the browser (sorting, object churn, JSON), median of 5 runs, compared with the same run on
 * the reference machine (perf/budgets.json `cpuReferenceMs`, measured on the reference Mac).
 */
export async function calibrate(browser: Browser): Promise<{ ms: number; reference: number }> {
  const page = await browser.newPage();
  const ms = await page.evaluate(() => {
    const run = () => {
      const t = performance.now();
      let seed = 1;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const rows = Array.from({ length: 100_000 }, (_, i) => ({ id: i, key: rnd().toString(36), n: rnd() }));
      rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      JSON.parse(JSON.stringify(rows.slice(0, 20_000)));
      return performance.now() - t;
    };
    run();
    const xs = Array.from({ length: 5 }, run).sort((a, b) => a - b);
    return xs[2]!;
  });
  await page.close();
  const budgets = JSON.parse(readFileSync(join(ROOT, "perf/budgets.json"), "utf8")) as { cpuReferenceMs?: number };
  return { ms, reference: budgets.cpuReferenceMs ?? ms };
}


/** Slowdown of this machine against the reference, never below 1. */
export const slowdown = (c: { ms: number; reference: number }) => Math.max(1, c.ms / c.reference);
