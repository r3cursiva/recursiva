import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localServer, signInCookies } from "./server.ts";

test("signInCookies: rsva_sid on http, __Host-rsva_sid and Secure on https, rsva_in alone without a session", () => {
  assert.deepEqual(signInCookies("http://127.0.0.1:3899", "s1").map((c) => [c.name, c.secure, c.httpOnly ?? false]), [
    ["rsva_sid", false, true],
    ["rsva_in", false, false],
  ]);
  assert.deepEqual(signInCookies("https://app.rsva.dev", "s1").map((c) => [c.name, c.secure]), [
    ["__Host-rsva_sid", true],
    ["rsva_in", true],
  ]);
  assert.deepEqual(signInCookies("https://app.rsva.dev").map((c) => c.name), ["rsva_in"]);
});

/** A stand-in for apps/server: answers /healthz, or exits at once with FAIL set. */
function fakeServer(): string {
  const file = join(mkdtempSync(join(tmpdir(), "local-server-")), "main.mjs");
  writeFileSync(
    file,
    `import http from "node:http";
     if (process.env.FAIL) process.exit(3);
     http.createServer((req, res) => res.writeHead(req.url === "/healthz" ? 200 : 404).end(String(process.pid))).listen(Number(process.env.PORT), "127.0.0.1");`,
  );
  return file;
}

test("localServer: up on a free port, restarts on the same one, kill waits for the exit", async () => {
  const s = await localServer({ entry: fakeServer(), output: "quiet" });
  const first = s.pid;
  assert.equal((await fetch(`${s.url}/healthz`)).status, 200);
  await s.restart();
  assert.notEqual(s.pid, first);
  assert.equal((await fetch(`${s.url}/`)).status, 404);
  await s.kill();
  await s.kill();
  assert.equal(await fetch(`${s.url}/healthz`).then(() => "up", () => "down"), "down");
});

test("localServer: a server that dies before answering fails at once, not after the wait", async () => {
  const t0 = performance.now();
  await assert.rejects(localServer({ entry: fakeServer(), env: { FAIL: "1" }, output: "quiet" }), /exited with 3/);
  assert.ok(performance.now() - t0 < 10_000);
});
