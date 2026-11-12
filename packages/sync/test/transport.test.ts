// The engine's network outside a browser: the credential goes in a header on every request and on the socket.
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { authorizedTransport, type SocketLike } from "../src/index.ts";

class FakeSocket implements SocketLike {
  onmessage = null;
  onclose = null;
  onerror = null;
  readonly url: string;
  readonly init: unknown;
  constructor(url: string, init: { headers: Record<string, string> }) {
    this.url = url;
    this.init = init;
  }
  send(): void {}
  close(): void {}
}

test("the socket gets the header beside its own options, read anew for every socket", () => {
  let token = "a";
  const t = authorizedTransport(() => `Bearer ${token}`, FakeSocket, { createConnection: "relay" });
  const first = new t.WebSocket("ws://h/ws");
  token = "b";
  const second = new t.WebSocket("ws://h/ws");
  assert.ok(first instanceof FakeSocket);
  assert.equal(first.url, "ws://h/ws");
  assert.deepEqual(first.init, { createConnection: "relay", headers: { authorization: "Bearer a" } });
  assert.deepEqual(second.init, { createConnection: "relay", headers: { authorization: "Bearer b" } });
});

test("fetch adds the header and keeps the request's own, in any form", async () => {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => (seen.push(req.headers), res.end("ok")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const t = authorizedTransport("Session s", FakeSocket);
    assert.equal(await (await t.fetch(url)).text(), "ok");
    await t.fetch(url, { method: "POST", body: "{}", headers: { "content-type": "application/json", authorization: "Bearer stale" } });
    await t.fetch(url, { headers: new Headers({ "x-a": "1" }) });
    assert.deepEqual(
      seen.map((h) => [h.authorization, h["content-type"], h["x-a"]]),
      [
        ["Session s", undefined, undefined],
        ["Session s", "application/json", undefined],
        ["Session s", undefined, "1"],
      ],
    );
  } finally {
    server.close();
  }
});
