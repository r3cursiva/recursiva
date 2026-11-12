import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { serverImages } from "./images.ts";

const ORIGIN = "https://app.rsva.dev";
const FILE = `/files/arsen/${"a".repeat(64)}`;

/** A loader over a fetch that records what it was asked and answers with three bytes. */
function recording() {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const get = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;
  return { calls, load: serverImages(ORIGIN, "Bearer secret", get) };
}

test("serverImages: a file of this server is fetched with the credential and no redirect followed (RSVA-477)", async () => {
  const { calls, load } = recording();
  assert.deepEqual(await load(FILE), new Uint8Array([1, 2, 3]));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${ORIGIN}${FILE}`);
  assert.deepEqual(calls[0]!.init, { headers: { authorization: "Bearer secret" }, redirect: "error" });
});

test("serverImages: any other source is not fetched at all, so the credential goes nowhere (RSVA-477)", async () => {
  const { calls, load } = recording();
  for (const src of [
    `https://attacker.example${FILE}`,
    `//attacker.example${FILE}`,
    `https://app.rsva.dev@attacker.example${FILE}`,
    `https://app.rsva.dev.attacker.example${FILE}`,
    `HTTPS://APP.RSVA.DEV${FILE}`,
    `${ORIGIN}${FILE}`,
    `http://app.rsva.dev${FILE}`,
    `/\\attacker.example${FILE}`,
    `${FILE}?x=1`,
    "/files/arsen/not-a-hash",
    "/sync/workspaces",
    "data:image/png;base64,AAAA",
    "x.png",
  ]) {
    await assert.rejects(load(src), /not a file of this server/, src);
  }
  assert.deepEqual(calls, []);
});

test("serverImages: a redirect from this server is not followed with the credential (RSVA-477)", async () => {
  const seen: IncomingHttpHeaders[] = [];
  const other = createServer((req, res) => {
    seen.push(req.headers);
    res.end("png");
  });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  const ours = createServer((_req, res) => {
    res.writeHead(302, { location: `http://localhost:${(other.address() as AddressInfo).port}/x.png` });
    res.end();
  });
  await new Promise<void>((r) => ours.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(serverImages(`http://127.0.0.1:${(ours.address() as AddressInfo).port}`, "Bearer secret")(FILE));
    assert.deepEqual(seen, []);
  } finally {
    ours.close();
    other.close();
  }
});
