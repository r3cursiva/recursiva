import assert from "node:assert/strict";
import { test } from "node:test";
import { asksViewer, toTriage } from "../src/my-work.ts";

test("what waits on the viewer asks them something; a proposal is to triage, never both", () => {
  const rows = [
    { group: "wait", ask: "review" },
    { group: "wait", ask: "reply" },
    { group: "wait", ask: "mention" },
    { group: "wait", ask: "proposed" },
    { group: "doing" },
  ] as const;
  assert.deepEqual(rows.map((x) => asksViewer(x)), [true, true, true, false, false]);
  assert.deepEqual(rows.map((x) => toTriage(x)), [false, false, false, true, false]);
});
