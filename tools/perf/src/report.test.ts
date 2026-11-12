import assert from "node:assert/strict";
import { test } from "node:test";
import { judge, runCount, type Metric } from "./report.ts";

const timing: Metric = { key: "t", label: "t", value: 400, unit: "ms", ratchet: false };
const bytes: Metric = { key: "b", label: "b", value: 400, unit: "B", ratchet: true };
const strict = { ratchetPct: 2, update: false, warnTimings: false, noteGrowth: false };
const ci = { ...strict, warnTimings: true };

test("a timing over budget fails a local run and only warns in CI", () => {
  assert.equal(judge(timing, 300, undefined, strict), "BUDGET");
  assert.equal(judge(timing, 300, undefined, ci), "SLOW");
});

test("growth past a baseline from another machine is a note, and a budget still fails", () => {
  const local = { ...strict, noteGrowth: true };
  assert.equal(judge(bytes, undefined, 300, local), "BIGGER");
  assert.equal(judge(bytes, undefined, 395, local), "ok");
  assert.equal(judge(bytes, 300, 300, local), "BUDGET");
});

test("bytes over budget fail in CI too", () => {
  assert.equal(judge(bytes, 300, undefined, ci), "BUDGET");
});

test("growth past the tolerance fails in CI, unless the run is accepting it", () => {
  assert.equal(judge(bytes, undefined, 300, ci), "GREW");
  assert.equal(judge(bytes, undefined, 300, { ...ci, update: true }), "ok");
  assert.equal(judge(bytes, undefined, 395, ci), "ok");
});

test("a metric that measured nothing fails, also when the run accepts new values", () => {
  for (const value of [Number.NaN, undefined as unknown as number, Number.POSITIVE_INFINITY]) {
    assert.equal(judge({ ...timing, value }, 300, undefined, ci), "NONE");
    assert.equal(judge({ ...bytes, value }, undefined, 300, { ...strict, update: true }), "NONE");
    assert.equal(judge({ ...bytes, value }, undefined, undefined, strict), "NONE");
  }
});

test("a run count below the minimum or not a whole number is refused", () => {
  const name = "PERF_TEST_RUNS";
  const read = (raw: string | undefined, min?: number) => {
    if (raw === undefined) delete process.env[name];
    else process.env[name] = raw;
    try {
      return runCount(name, 5, min);
    } finally {
      delete process.env[name];
    }
  };
  assert.equal(read(undefined), 5);
  assert.equal(read(""), 5);
  assert.equal(read("3"), 3);
  assert.equal(read("0", 0), 0);
  for (const raw of ["0", "-1", "abc", "2.5"]) assert.throws(() => read(raw), new RegExp(`${name}=${raw} `));
});
