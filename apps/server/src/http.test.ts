// HTTP-level hardening (PLNR-32): error bodies, thrown refusals, NUL bytes, issue numbers, security headers, /healthz, request logs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { buildApp } from "./app.ts";
import { guardConfig } from "./guard.ts";
import { contentSecurityPolicy, inlineScriptHashes, securityHeaders } from "./headers.ts";
import { HttpError, clientKey, redactUrl } from "./http.ts";
import type { StaticFile } from "./static.ts";
import { TxError } from "./sync/tx-error.ts";
import { asToken, asUser, importFixture, type Fixture } from "./test/helpers.ts";

const THEME = `\n      (() => { document.documentElement.classList.toggle("dark", true); })();\n    `;
const PAGE = `<!doctype html><html><head><script>${THEME}</script><script type="module" crossorigin src="/assets/index.js"></script></head><body></body></html>`;
const shell: StaticFile = { type: "text/html; charset=utf-8", etag: '"p"', cacheControl: "no-cache", variants: [{ encoding: null, body: Buffer.from(PAGE) }] };
const files = new Map([["/index.html", shell]]);

let ws: Fixture;
let lines: string[] = [];
const app = buildApp({ files, logLevel: "info", logStream: { write: (l) => void lines.push(l) }, mailer: async () => {} });
// A route that fails the way a query does: drizzle puts the SQL and its parameters in the message.
app.get("/test/fail", async () => {
  throw new Error('Failed query: select "secret" from "user" where "email" = $1\nparams: a@example.com');
});
// Refusals thrown out of a route: a route's own, and the write pipeline's by its code.
app.get("/test/refused", async () => {
  throw new HttpError(403, "forbidden", "not yours");
});
app.get<{ Params: { code: string } }>("/test/tx/:code", async (req) => {
  throw new TxError(req.params.code, `refused: ${req.params.code}`);
});
before(async () => {
  ws = await importFixture();
  await app.ready();
});
after(() => app.close());

test("a 5xx says only 'internal'; the details go to the log", async () => {
  lines = [];
  const r = await app.inject("/test/fail");
  assert.equal(r.statusCode, 500);
  assert.deepEqual(r.json(), { error: "internal", message: "Something went wrong on the server." });
  assert.ok(lines.some((l) => l.includes("Failed query")), "logged");
});

test("4xx from Fastify keep the app's { error, message } shape without internal codes", async () => {
  const post = (body: string, type: string) => app.inject({ method: "POST", url: "/auth/code", headers: { "content-type": type }, body });
  const cases = [
    [await post("{nope", "application/json"), 400, "invalid"],
    [await post("<a/>", "application/xml"), 415, "unsupported_media_type"],
    [await post(JSON.stringify({ email: "x".repeat(1_100_000) }), "application/json"), 413, "payload_too_large"],
    [await app.inject({ method: "POST", url: "/no/such/route" }), 404, "not_found"],
  ] as const;
  for (const [r, status, error] of cases) {
    assert.equal(r.statusCode, status, r.body);
    const body = r.json() as Record<string, unknown>;
    assert.equal(body.error, error);
    assert.ok(!("code" in body) && !("statusCode" in body), r.body);
  }
  // The default 404 echoed the method and URL.
  assert.ok(!(await app.inject({ method: "POST", url: "/join/abc" })).body.includes("abc"));
});

test("a client is counted by its IPv4 address, or by the /64 of its IPv6 one", () => {
  assert.equal(clientKey("203.0.113.7"), "203.0.113.7");
  assert.equal(clientKey("::ffff:203.0.113.7"), "203.0.113.7");
  for (const ip of ["2001:db8:1:2::1", "2001:0db8:0001:0002:ffff:ffff:ffff:ffff", "2001:db8:1:2:0:0:0.0.0.9", "2001:DB8:1:2::1%eth0"]) assert.equal(clientKey(ip), "2001:db8:1:2::/64", ip);
  assert.equal(clientKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientKey("::1"), "0:0:0:0::/64");
  assert.equal(clientKey("2001::2:3:4:5:6"), "2001:0:0:2::/64");
  assert.notEqual(clientKey("2001:db8:1:3::1"), clientKey("2001:db8:1:2::1"));
});

test("a thrown refusal answers its status with { error, message }; the pipeline's by its code, as everywhere (PLNR-411)", async () => {
  const refused = await app.inject("/test/refused");
  assert.deepEqual([refused.statusCode, refused.json()], [403, { error: "forbidden", message: "not yours" }]);
  for (const [code, status] of [["not_found", 404], ["forbidden", 403], ["wrong_account", 403], ["conflict", 409], ["invalid", 400], ["bad_ref", 400]] as const) {
    const r = await app.inject(`/test/tx/${code}`);
    assert.deepEqual([r.statusCode, r.json()], [status, { error: code, message: `refused: ${code}` }], code);
  }
});

test("NUL bytes in the path or the query are refused with 400 before any route runs", async () => {
  const headers = await asUser(ws.ownerId);
  for (const url of [`/sync/bootstrap?ws=a%00b`, `/sync/bootstrap?ws=${ws.slug}%00`, `/api/v1/workspaces/${ws.slug}%00/issues`, "/join/a%00"]) {
    const r = await app.inject({ url, headers });
    assert.equal(r.statusCode, 400, url);
    assert.equal(r.json().error, "invalid");
  }
});

test("a URL the router cannot decode is a 400 in the same shape, with the headers and without the URL", async () => {
  lines = [];
  for (const url of ["/%E0", `/join/pli_secret%E0`, "/api/v1/workspaces/%E0/issues"]) {
    const r = await app.inject(url);
    assert.equal(r.statusCode, 400, url);
    assert.equal(r.json().error, "invalid");
    assert.ok(!r.body.includes("%E0") && !r.body.includes("secret"), r.body);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.ok(r.headers["content-security-policy"]);
  }
  assert.ok(!lines.some((l) => l.includes("pli_secret")), "the log has no secret");
});

test("issue numbers above int4 name no issue, and the query does not fail", async () => {
  const headers = await asToken(ws.workspaceId, ws.agentId);
  const get = (key: string) => app.inject({ url: `/api/v1/workspaces/${ws.slug}/issues/${key}`, headers });
  assert.equal((await get("CORE-2147483648")).statusCode, 404);
  assert.equal((await get("CORE-99999999999999999999")).statusCode, 404);
  assert.equal((await get("CORE-2147483647")).statusCode, 404);
  // A key in any case finds the issue: its project key is upper case, as stored.
  const lower = await get("core-1");
  assert.equal(lower.statusCode, 200, lower.body);
  assert.equal(lower.json().key, "CORE-1");
  // The same through a parent key.
  const r = await app.inject({ method: "PATCH", url: `/api/v1/workspaces/${ws.slug}/issues/CORE-1`, headers, payload: { parent: "CORE-99999999999" } });
  assert.equal(r.statusCode, 400, r.body);
});

test("security headers on the page, the API and errors; the CSP hashes the inline script", async () => {
  const hash = `'sha256-${createHash("sha256").update(THEME).digest("base64")}'`;
  assert.deepEqual(inlineScriptHashes(PAGE), [hash]);
  for (const url of ["/", "/atlas/projects/CORE/issues", "/healthz", "/test/fail", "/missing.js"]) {
    const r = await app.inject(url);
    assert.equal(r.headers["x-content-type-options"], "nosniff", url);
    assert.equal(r.headers["referrer-policy"], "strict-origin-when-cross-origin", url);
    const csp = String(r.headers["content-security-policy"]);
    assert.ok(csp.includes(`script-src 'self' ${hash}`), csp);
    for (const d of ["default-src 'self'", "style-src 'self'", "img-src 'self' data:", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'", "form-action 'self'"])
      assert.ok(csp.includes(d), `${url}: ${d}`);
    // Only style attributes may be inline (pasted formatting in the editor); no inline scripts or <style>.
    assert.deepEqual(csp.split("; ").filter((d) => d.includes("unsafe")), ["style-src-attr 'unsafe-inline'"], csp);
  }
  // The WebSocket of a configured https origin is listed explicitly, for browsers whose 'self' does not match wss:.
  const stand = contentSecurityPolicy(files, guardConfig({ RSVA_ALLOWED_ORIGINS: "https://plan.example.com" }));
  assert.match(stand, /connect-src 'self' wss:\/\/plan\.example\.com;/);
});

test("HSTS only on a deployment: an https origin and a non-loopback bind, never on local dev (RSVA-618)", () => {
  const hsts = (env: NodeJS.ProcessEnv) => securityHeaders(files, guardConfig(env))["strict-transport-security"];
  assert.equal(hsts({ RSVA_ALLOWED_ORIGINS: "https://plan.example.com", HOST: "0.0.0.0" }), "max-age=31536000");
  assert.equal(hsts({ RSVA_ALLOWED_ORIGINS: "http://plan.example.com", HOST: "0.0.0.0" }), undefined, "plain http");
  assert.equal(hsts({}), undefined, "nothing configured");
  assert.equal(hsts({ RSVA_ALLOWED_ORIGINS: "https://rsva.localhost" }), undefined, "portless dev on loopback");
  assert.equal(hsts({ RSVA_ALLOWED_ORIGINS: "https://rsva.localhost", HOST: "127.0.0.1" }), undefined, "loopback bind");
});

test("/healthz says only that the server is up", async () => {
  assert.deepEqual((await app.inject("/healthz")).json(), { ok: true });
});

test("invite secrets are cut out of request logs", async () => {
  assert.equal(redactUrl("/join/s3cret"), "/join/[secret]");
  assert.equal(redactUrl("/api/v1/invites/s3cret/accept?x=1"), "/api/v1/invites/[secret]/accept?x=1");
  assert.equal(redactUrl("//join//s3cret"), "//join//[secret]");
  assert.equal(redactUrl("/api/v1/me/invites/123/accept"), "/api/v1/me/invites/123/accept");
  lines = [];
  const secret = "pli_" + "Q".repeat(32);
  await app.inject(`/join/${secret}`);
  await app.inject(`/api/v1/invites/${secret}`);
  await app.inject({ method: "POST", url: `/api/v1/invites/${secret}/accept` });
  await app.inject({ method: "POST", url: `/join/${secret}` });
  assert.ok(lines.length >= 4, "requests were logged");
  assert.ok(lines.some((l) => l.includes("/api/v1/invites/[secret]/accept")), lines.join(""));
  assert.ok(!lines.some((l) => l.includes(secret)), lines.filter((l) => l.includes(secret)).join(""));
});
