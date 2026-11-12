import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { guardConfig, hostAllowed, originAllowed } from "./guard.ts";
import { startServer } from "./test/helpers.ts";

const cfg = guardConfig({});

test("loopback hosts on any port pass, others and missing do not", () => {
  for (const h of ["localhost:5173", "127.0.0.1:3800", "[::1]:3800", "localhost", "LOCALHOST:1"]) assert.ok(hostAllowed(h, cfg), h);
  for (const h of ["evil.example:3800", "127.0.0.1.nip.io:3800", "localhost.evil.example", undefined]) assert.ok(!hostAllowed(h, cfg), String(h));
  assert.ok(hostAllowed("planner.example.com", guardConfig({ RSVA_ALLOWED_HOSTS: "planner.example.com, other:8080" })));
});

test("loopback origins pass, a missing origin passes, foreign ones do not", () => {
  for (const o of ["http://localhost:5173", "http://127.0.0.1:3800", "https://localhost", "http://[::1]:5174", undefined]) assert.ok(originAllowed(o, cfg), String(o));
  for (const o of ["https://evil.example", "http://localhost.evil.example", "null", "file://", "chrome-extension://abc"]) assert.ok(!originAllowed(o, cfg), o);
  assert.ok(originAllowed("https://planner.example.com", guardConfig({ RSVA_ALLOWED_ORIGINS: "https://planner.example.com" })));
});

let server: Awaited<ReturnType<typeof startServer>>;
before(async () => (server = await startServer()));
after(() => server.close());

function get(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(server.url + path, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject).end();
  });
}

function upgrade(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(server.url.replace("http", "ws") + "/ws", { headers });
    ws.once("open", () => (ws.close(), resolve(101)));
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode!));
    ws.once("error", reject);
  });
}

test("HTTP: a rebinding Host is rejected, a foreign Origin too", async () => {
  const port = new URL(server.url).port;
  // /auth/me answers 401 without a session once the guard lets the request through.
  assert.equal(await get("/auth/me", {}), 401);
  assert.equal(await get("/auth/me", { host: `localhost:${port}`, origin: "http://localhost:5173" }), 401);
  assert.equal(await get("/auth/me", { host: `rebind.evil.example:${port}` }), 421);
  assert.equal(await get("/auth/me", { origin: "https://evil.example" }), 403);
  // Health checks skip the guard: they call the server by address, and the answer is only {ok:true}.
  assert.equal(await get("/healthz", { host: `rebind.evil.example:${port}` }), 200);
});

test("WebSocket: the dev proxy and non-browser clients connect, a foreign page or Host does not", async () => {
  const port = new URL(server.url).port;
  assert.equal(await upgrade({}), 101);
  // What the Vite dev proxy forwards: the browser's Host and Origin of the dev server.
  assert.equal(await upgrade({ host: "localhost:5173", origin: "http://localhost:5173" }), 101);
  assert.equal(await upgrade({ origin: "https://evil.example" }), 403);
  assert.equal(await upgrade({ host: `rebind.evil.example:${port}`, origin: `http://rebind.evil.example:${port}` }), 421);
});

const STAND = { HOST: "0.0.0.0", RSVA_ALLOWED_HOSTS: "plan.example.com", RSVA_ALLOWED_ORIGINS: "https://plan.example.com" };

test("a deployment (https origin, not on loopback) takes no loopback Host or Origin; local dev keeps them", () => {
  const stand = guardConfig(STAND);
  assert.equal(stand.loopback, false);
  for (const h of ["127.0.0.1:3820", "localhost", "[::1]:3800"]) assert.ok(!hostAllowed(h, stand), h);
  for (const o of ["http://localhost:5173", "https://localhost", "http://127.0.0.1:3820"]) assert.ok(!originAllowed(o, stand), o);
  assert.ok(hostAllowed("plan.example.com", stand));
  assert.ok(originAllowed("https://plan.example.com", stand));
  assert.ok(originAllowed(undefined, stand), "non-browser clients send no Origin");
  // `pnpm dev` (https://rsva.localhost) and `pnpm dev:ts` (https origins of the tailnet) listen on loopback.
  for (const env of [{ RSVA_ALLOWED_ORIGINS: "https://rsva.localhost" }, { RSVA_ALLOWED_ORIGINS: "https://dev.example.ts.net:8443", HOST: "127.0.0.1" }]) {
    const dev = guardConfig(env);
    assert.ok(dev.loopback && hostAllowed("127.0.0.1:3800", dev) && originAllowed("http://localhost:5173", dev), JSON.stringify(env));
  }
  // An http origin alone is not a deployment.
  assert.ok(guardConfig({ HOST: "0.0.0.0", RSVA_ALLOWED_ORIGINS: "http://10.0.0.5:3800" }).loopback);
});

test("a deployment refuses a loopback Host and Origin over HTTP and WebSocket; health checks by address still pass", async () => {
  const stand = await startServer({ guard: guardConfig(STAND) });
  try {
    const port = new URL(stand.url).port;
    const status = (path: string, headers: Record<string, string> = {}) =>
      new Promise<number>((resolve, reject) => {
        request(stand.url + path, { headers }, (res) => (res.resume(), resolve(res.statusCode!))).on("error", reject).end();
      });
    assert.equal(await status("/healthz"), 200, "rsva-deploy and the compose healthcheck call 127.0.0.1");
    assert.equal(await status("/auth/me"), 421);
    assert.equal(await status("/auth/me", { host: "plan.example.com", origin: "http://localhost:5173" }), 403);
    assert.equal(await status("/auth/me", { host: "plan.example.com" }), 401);
    const ws = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
        s.once("open", () => (s.close(), resolve(101)));
        s.once("unexpected-response", (_req, res) => resolve(res.statusCode!));
        s.once("error", reject);
      });
    assert.equal(await ws({}), 421);
    assert.equal(await ws({ host: "plan.example.com", origin: "http://localhost:5173" }), 403);
  } finally {
    await stand.close();
  }
});
