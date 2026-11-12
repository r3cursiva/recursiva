import assert from "node:assert/strict";
import { test } from "node:test";
import { pickEncoding } from "./compress.ts";

test("pickEncoding: brotli over gzip, q=0 means not accepted (PLNR-409)", () => {
  assert.equal(pickEncoding("gzip, deflate, br"), "br");
  assert.equal(pickEncoding("gzip, deflate"), "gzip");
  assert.equal(pickEncoding("br;q=0, gzip"), "gzip");
  assert.equal(pickEncoding("br;q=0"), null);
  assert.equal(pickEncoding("br;q=0.0, gzip;q=0"), null);
  assert.equal(pickEncoding("BR;q=0.5"), "br");
  assert.equal(pickEncoding("identity"), null);
  assert.equal(pickEncoding(undefined), null);
});
