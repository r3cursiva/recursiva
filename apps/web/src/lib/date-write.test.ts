import assert from "node:assert/strict";
import { test } from "node:test";
import { finishDate } from "./date-write.ts";

function run(value: string | null, day: string | null | undefined) {
  const calls: string[] = [];
  finishDate(value, day, () => calls.push("close"), (d) => calls.push(`write ${d}`), () => calls.push("after"));
  return calls;
}

test("nothing chosen writes nothing, whatever the live value became while the calendar was open", () => {
  // Opened on 11-02; another client set 11-20; a click elsewhere or Enter with nothing typed passes undefined.
  assert.deepEqual(run("2026-11-20", undefined), ["close", "after"]);
  assert.deepEqual(run(null, undefined), ["close", "after"]);
});

test("Escape writes nothing", () => {
  assert.deepEqual(run("2026-11-20", undefined), ["close", "after"]);
});

test("a day typed or picked writes once, between the close and what follows it", () => {
  assert.deepEqual(run("2026-11-02", "2026-11-09"), ["close", "write 2026-11-09", "after"]);
  assert.deepEqual(run(null, "2026-11-09"), ["close", "write 2026-11-09", "after"]);
});

test("a person's own choice wins over the live value, even the value the calendar opened on", () => {
  assert.deepEqual(run("2026-11-20", "2026-11-02"), ["close", "write 2026-11-02", "after"]);
});

test("the live day chosen again writes nothing", () => {
  assert.deepEqual(run("2026-11-02", "2026-11-02"), ["close", "after"]);
});

test("Clear writes null once", () => {
  assert.deepEqual(run("2026-11-02", null), ["close", "write null", "after"]);
  assert.deepEqual(run(null, null), ["close", "after"]);
});
