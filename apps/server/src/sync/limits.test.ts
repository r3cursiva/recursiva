import assert from "node:assert/strict";
import { test } from "node:test";
import { Budget } from "./limits.ts";

test("a budget lets a minute's worth through at once, refills at its rate, and gives back what a read did not use", () => {
  const b = new Budget(600);
  const t = 1_000_000;
  assert.equal(b.take("a", 600, t), true, "a burst of a whole minute");
  assert.equal(b.take("a", 1, t), false);
  assert.equal(b.take("b", 600, t), true, "keys are independent");
  assert.equal(b.retryAfter("a", 60, t), 6, "60 units at 10 a second");
  assert.equal(b.take("a", 60, t + 5_000), false, "not yet: 50 back");
  assert.equal(b.take("a", 60, t + 6_000), true);
  assert.equal(b.available("a", t + 600_000), 600, "never more than a minute's worth");
  // A reservation: take the most, refund the rest.
  assert.equal(b.take("c", 500, t), true);
  b.refund("c", 450, t);
  assert.equal(b.available("c", t), 550);
  assert.equal(b.take("c", 601, t), false, "more than a bucket holds never passes");
});
