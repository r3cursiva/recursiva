import assert from "node:assert/strict";
import { test } from "node:test";
import { pickVariant, type StaticFile } from "./static.ts";

const file: StaticFile = {
  type: "text/javascript",
  etag: '"x"',
  cacheControl: "no-cache",
  variants: [
    { encoding: "br", body: Buffer.alloc(10) },
    { encoding: "zstd", body: Buffer.alloc(12) },
    { encoding: "gzip", body: Buffer.alloc(14) },
    { encoding: null, body: Buffer.alloc(40) },
  ],
};

test("serves the smallest accepted variant", () => {
  assert.equal(pickVariant(file, "gzip, deflate, br, zstd").encoding, "br");
  assert.equal(pickVariant(file, "gzip, zstd").encoding, "zstd");
  assert.equal(pickVariant(file, "gzip").encoding, "gzip");
});

test("no Accept-Encoding or q=0 means uncompressed", () => {
  assert.equal(pickVariant(file, undefined).encoding, null);
  assert.equal(pickVariant(file, "br;q=0, gzip;q=0.0").encoding, null);
});
