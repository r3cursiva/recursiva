import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLinear, growth, K, quantile, until } from "./index.ts";

const linear = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const quadratic = (xs: number[]) => {
  let s = 0;
  for (const a of xs) for (const b of xs) s += a < b ? 1 : 0;
  return s;
};
const list = (n: number) => Array.from({ length: n }, (_, i) => (i * 7919) % n);

test("growth tells linear from quadratic work", () => {
  assert.ok(growth(() => linear(list(20_000 / K)), () => linear(list(20_000)), K) < 3);
  assert.ok(growth(() => quadratic(list(4_000 / K)), () => quadratic(list(4_000)), K) > K / 2);
});

test("assertLinear passes linear code and names the case when it fails", () => {
  assertLinear("sum", list, linear, 200_000);
  assert.throws(() => assertLinear("pairs", list, quadratic, 4_000), /pairs: \d+\.\d× per unit of input from 250 to 4000/);
});

test("quantile takes the value at floor(n * q) of the sorted copy", () => {
  const xs = [5, 1, 4, 2, 3];
  assert.equal(quantile(xs, 0.5), 3);
  assert.equal(quantile(xs, 0.95), 5);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 3);
  assert.deepEqual(xs, [5, 1, 4, 2, 3]);
});

test("until resolves with the wait once the condition holds, and names it when it never does", async () => {
  const at = performance.now() + 30;
  assert.ok((await until(() => performance.now() >= at, 1000, "later", 1)) >= 29);
  assert.equal(await until(() => true, 0, "now"), 0);
  await assert.rejects(until(() => false, 20, "never"), /not within 20 ms: never/);
});
