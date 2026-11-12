import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNdjson, toNdjson } from "../src/bundle.ts";

test("NDJSON: one object per line, a newline after the last; parsing skips empty lines and gives the objects back", () => {
  const lines = [{ m: "Bundle", version: 1 }, { m: "User", ext: "u1", name: "Line\nbreak" }];
  const text = toNdjson(lines);
  assert.equal(text, '{"m":"Bundle","version":1}\n{"m":"User","ext":"u1","name":"Line\\nbreak"}\n');
  assert.deepEqual(parseNdjson(text), lines);
  assert.deepEqual(parseNdjson(`\n${text}\n`), lines);
  assert.deepEqual(parseNdjson(""), []);
});
