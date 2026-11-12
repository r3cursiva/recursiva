import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { CLOSE_FORBIDDEN, CLOSE_NOT_FOUND, CLOSE_UNAUTHORIZED, type AccountSecurity, type ServerFrame, type TerminalCode, type TerminalSession } from "@rsva/protocol";
import { and, eq } from "drizzle-orm";
import WebSocket from "ws";
import { db, schema } from "../db.ts";
import { SoftAuthenticator } from "../test/authenticator.ts";
import { addMember, agedSession, asToken, asUser, Client, fetchAs, importFixture, issueWithRefs, ORIGIN, startServer, tenThenLimited, type Fixture } from "../test/helpers.ts";
import { applyTx } from "../sync/write.ts";
import { forgetRoles } from "./access.ts";
import { sessionCookieNames } from "./actor.ts";
import { DAILY_FAILURES } from "./codes.ts";
import { maySignIn } from "./eligibility.ts";
import { devCodeFromEnv, mailerFromEnv, senderFromEnv, type Mail } from "./mail.ts";
import { SIGNED_IN_BEFORE, sweepDevices } from "./devices.ts";
import { sha256 } from "./secret.ts";
import { createSession, endSession } from "./sessions.ts";
import { createToken } from "./tokens.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let ws: Fixture;
let other: Fixture;
let ownerEmail: string;
const mails: Mail[] = [];
before(async () => {
  [server, ws, other] = await Promise.all([startServer({ mailer: async (m) => void mails.push(m) }), importFixture(), importFixture()]);
  ownerEmail = (await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, ws.ownerId)))[0]!.email;
});
after(() => server.close());

const url = (path: string, base = server.url) => `${base}${path}`;
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
  body: JSON.stringify(body),
});
const post = (path: string, body: unknown, headers?: Record<string, string>, base?: string) => fetch(url(path, base), json(body, headers));

/** A server of its own, for tests that would use up the shared one's per-IP sign-in limits. */
async function ownServer(): Promise<{ url: string; post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<Response> }> {
  const own = await startServer({ mailer: async (m) => void mails.push(m) });
  after(() => own.close());
  return { url: own.url, post: (path, body, headers) => post(path, body, headers, own.url) };
}

/** The latest mail to this address that `matches`, taken off the list (sending runs after the answer). */
async function mailFor(email: string, matches: (m: Mail) => boolean): Promise<Mail> {
  for (let i = 0; i < 100; i++) {
    const m = mails.findLast((x) => x.to === email.toLowerCase() && matches(x));
    if (m) {
      mails.splice(mails.indexOf(m), 1);
      return m;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no mail to ${email}`);
}

/** The code in the next mail to this address. */
const codeFor = async (email: string) => /(\d{6})/.exec((await mailFor(email, (m) => /recursiva code/.test(m.subject))).text)![1]!;

/** Cookie header from a sign-in answer's Set-Cookie values. */
const cookieOf = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(";", 1)[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");

/** Opens a socket and resolves with its close code, or with "open" once hello arrives and `sub` was answered. */
function socketOutcome(headers: Record<string, string>, sub?: string): Promise<number | "open"> {
  return new Promise((resolve) => {
    const s = new WebSocket(url("/ws").replace(/^http/, "ws"), { headers });
    s.on("close", (code) => resolve(code));
    s.on("message", (data) => {
      const f = JSON.parse(String(data)) as ServerFrame;
      if (f.t === "hello" && sub) s.send(JSON.stringify({ t: "sub", ws: sub, s: 0 }));
      else if (f.t === "hello" || f.t === "d" || f.t === "resync") {
        resolve("open");
        s.close();
      }
    });
  });
}

test("without a session or token: 401 everywhere, the socket closes with CLOSE_UNAUTHORIZED, the shell is public", async () => {
  const { issue } = await issueWithRefs(ws.workspaceId);
  for (const path of [`/sync/bootstrap?ws=${ws.slug}`, "/sync/workspaces", `/sync/history/${issue.id}`, `/api/v1/workspaces/${ws.slug}/issues/CORE-1`, "/auth/me"])
    assert.equal((await fetch(url(path))).status, 401, path);
  assert.equal((await fetch(url("/sync/workspaces"), { headers: { cookie: "rsva_sid=forged" } })).status, 401);
  assert.equal((await fetch(url("/sync/workspaces"), { headers: { authorization: "Bearer rsva_forged" } })).status, 401);
  assert.equal(await socketOutcome({ origin: ORIGIN }), CLOSE_UNAUTHORIZED);
  assert.notEqual((await fetch(url("/healthz"))).status, 401);
});

test("code sign-in: a mailed code opens a session once; the cookies are HttpOnly with a readable marker", async () => {
  assert.equal((await post("/auth/code", { email: ` ${ownerEmail.toUpperCase()} ` })).status, 204);
  const code = await codeFor(ownerEmail);
  const wrong = await post("/auth/verify", { email: ownerEmail, code: code === "000000" ? "111111" : "000000" });
  assert.equal(wrong.status, 400);
  assert.equal(((await wrong.json()) as { error: string }).error, "invalid_code");

  const r = await post("/auth/verify", { email: ownerEmail, code });
  assert.equal(r.status, 200);
  const set = r.headers.getSetCookie();
  assert.ok(set.some((c) => c.startsWith("rsva_sid=") && /HttpOnly/.test(c) && /SameSite=Lax/.test(c) && !/Secure/.test(c)));
  assert.ok(set.some((c) => c.startsWith("rsva_in=1") && !/HttpOnly/.test(c)));
  const body = (await r.json()) as { user: { id: string } };
  assert.equal(body.user.id, ws.ownerId);

  const cookie = cookieOf(r);
  const me = await fetch(url("/auth/me"), { headers: { cookie } });
  assert.equal(((await me.json()) as { user: { email: string } }).user.email, ownerEmail);
  assert.equal((await fetch(url(`/sync/bootstrap?ws=${ws.slug}`), { headers: { cookie } })).status, 200);
  // Used up.
  assert.equal((await post("/auth/verify", { email: ownerEmail, code })).status, 400);
});

test("on https the session cookie is __Host- and Secure", async () => {
  await post("/auth/code", { email: ownerEmail }, { origin: "https://localhost" });
  const r = await post("/auth/verify", { email: ownerEmail, code: await codeFor(ownerEmail) }, { origin: "https://localhost" });
  assert.ok(r.headers.getSetCookie().some((c) => c.startsWith("__Host-rsva_sid=") && /Secure/.test(c) && /Path=\//.test(c) && !/Domain/.test(c)));
  assert.equal((await fetch(url("/auth/me"), { headers: { cookie: cookieOf(r) } })).status, 200);
});

test("unknown emails and agents get the same answer and no mail", async () => {
  const before = mails.length;
  assert.equal((await post("/auth/code", { email: "nobody@example.test" })).status, 204);
  assert.equal((await post("/auth/code", { email: `bot@${ws.slug}.test` })).status, 204);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mails.length, before);
  assert.equal((await post("/auth/code", { email: "not an email" })).status, 400);
  // /auth/verify does not tell them apart either: a member's and a stranger's wrong code read the same.
  const m = await addMember(ws.workspaceId, "member");
  await post("/auth/code", { email: m.email });
  await codeFor(m.email);
  const answer = async (email: string) => {
    const r = await post("/auth/verify", { email, code: "000000" });
    return [r.status, ((await r.json()) as { error: string }).error];
  };
  assert.deepEqual(await answer("nobody@example.test"), await answer(m.email));
});

test("an agent never gets a browser session: not by a code, a link, an invite to its address or a stray session row (PLNR-276)", async () => {
  const own = await ownServer();
  const agent = await addMember(ws.workspaceId, "member", "agent");
  // An admin's live invite to the agent's address does not make it a person who may sign in.
  await db.insert(schema.invite).values({ workspaceId: other.workspaceId, email: agent.email, role: "member", hash: randomUUID(), invitedById: other.ownerId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const before = mails.length;
  assert.equal((await own.post("/auth/code", { email: agent.email })).status, 204);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mails.length, before, "no code is mailed to an agent");
  // Even a code or a link that reached the agent's mailbox opens nothing: the account is checked again when it is used.
  const code = "123456";
  const secret = "A".repeat(43);
  const plant = (codeHash: string) => {
    const row = { codeHash, attempts: 0, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    return db.insert(schema.loginCode).values({ email: agent.email, ...row }).onConflictDoUpdate({ target: schema.loginCode.email, set: row });
  };
  await plant(sha256(`${agent.email}\n${code}`));
  const byCode = await own.post("/auth/verify", { email: agent.email, code });
  assert.deepEqual([byCode.status, ((await byCode.json()) as { error: string }).error], [400, "invalid_code"]);
  assert.equal(byCode.headers.getSetCookie().length, 0);
  await plant(`L:${sha256(`${agent.email}\n${secret}`)}`);
  const byLink = await own.post("/auth/link", { email: agent.email, secret });
  assert.deepEqual([byLink.status, ((await byLink.json()) as { error: string }).error], [400, "invalid_link"]);
  assert.equal(byLink.headers.getSetCookie().length, 0);
  // No account was made for the invited address: it stays the agent's one.
  assert.deepEqual(
    (await db.select({ kind: schema.user.kind }).from(schema.user).where(eq(schema.user.email, agent.email))).map((u) => u.kind),
    ["agent"],
  );
  // A passkey is refused the same way (routes.ts), and a session row made some other way is not honoured.
  assert.equal(await maySignIn(agent.id), false);
  assert.equal(await maySignIn(ws.ownerId), true);
  const stray = await asUser(agent.id);
  assert.equal((await fetch(url("/auth/me"), { headers: stray })).status, 401);
  assert.equal((await fetch(url(`/sync/bootstrap?ws=${ws.slug}`), { headers: stray })).status, 401);
});

test("the fifth wrong guess ends the code; an expired code is refused", async () => {
  const m = await addMember(ws.workspaceId, "member");
  await post("/auth/code", { email: m.email });
  const code = await codeFor(m.email);
  const wrong = code === "123456" ? "654321" : "123456";
  for (let i = 0; i < 5; i++) assert.equal((await post("/auth/verify", { email: m.email, code: wrong })).status, 400);
  const r = await post("/auth/verify", { email: m.email, code });
  assert.equal(((await r.json()) as { error: string }).error, "expired_code");

  await post("/auth/code", { email: m.email });
  const fresh = await codeFor(m.email);
  await db.update(schema.loginCode).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.loginCode.email, m.email));
  assert.equal(((await (await post("/auth/verify", { email: m.email, code: fresh })).json()) as { error: string }).error, "expired_code");
});

test("code requests are limited per email", async () => {
  const m = await addMember(ws.workspaceId, "member");
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await post("/auth/code", { email: m.email })).status);
  assert.deepEqual(statuses, [204, 204, 204, 204, 204, 429]);
});

test("a live code under a minute old is not replaced: requests from someone else neither void it nor mail the person again (RSVA-600)", async () => {
  const m = await addMember(ws.workspaceId, "member");
  await post("/auth/code", { email: m.email });
  const code = await codeFor(m.email);
  for (let i = 0; i < 3; i++) assert.equal((await post("/auth/code", { email: m.email })).status, 204);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mails.some((x) => x.to === m.email), false, "no mail for the requests within the minute");
  assert.equal((await post("/auth/verify", { email: m.email, code })).status, 200, "the first code still works");

  // A minute on, asking again sends a new code, which ends the one before.
  const n = await addMember(ws.workspaceId, "member");
  await post("/auth/code", { email: n.email });
  const first = await codeFor(n.email);
  await db.update(schema.loginCode).set({ createdAt: new Date(Date.now() - 61_000).toISOString() }).where(eq(schema.loginCode.email, n.email));
  await post("/auth/code", { email: n.email });
  const second = await codeFor(n.email);
  if (first !== second) assert.equal(((await (await post("/auth/verify", { email: n.email, code: first })).json()) as { error: string }).error, "invalid_code");
  assert.equal((await post("/auth/verify", { email: n.email, code: second })).status, 200);
});

test("a code out of guesses or used up is no live code: asking again at once sends a new one (RSVA-600)", async () => {
  // Its own server: seven verifies here would eat into the shared one's per-IP limit.
  const { post } = await ownServer();
  const m = await addMember(ws.workspaceId, "member");
  await post("/auth/code", { email: m.email });
  const spent = await codeFor(m.email);
  const wrong = spent === "123456" ? "654321" : "123456";
  for (let i = 0; i < 5; i++) assert.equal((await post("/auth/verify", { email: m.email, code: wrong })).status, 400);
  const row = async () => (await db.select().from(schema.loginCode).where(eq(schema.loginCode.email, m.email))).length;
  assert.equal(await row(), 0, "the fifth wrong guess deletes the row");
  assert.equal((await post("/auth/code", { email: m.email })).status, 204);
  const fresh = await codeFor(m.email);
  assert.equal((await post("/auth/verify", { email: m.email, code: fresh })).status, 200);
  assert.equal(await row(), 0, "a used code's row is deleted");
  assert.equal((await post("/auth/code", { email: m.email })).status, 204);
  await codeFor(m.email);
});

test("within the minute a member's address and an unknown one answer alike, guess by guess (RSVA-600)", async () => {
  // Its own server: twelve verifies here would eat into the shared one's per-IP limit.
  const { post } = await ownServer();
  const m = await addMember(ws.workspaceId, "member");
  const stranger = `nobody-${randomUUID().slice(0, 8)}@example.test`;
  /** Status and body of each step for one address: a code, three wrong guesses, a new request, then guesses on. */
  const run = async (email: string) => {
    const steps: unknown[] = [];
    const step = async (r: Promise<Response>) => {
      const res = await r;
      steps.push([res.status, await res.text()]);
    };
    await step(post("/auth/code", { email }));
    await new Promise((r) => setTimeout(r, 50)); // the code row is written after the answer
    for (let i = 0; i < 3; i++) await step(post("/auth/verify", { email, code: "000000" }));
    await step(post("/auth/code", { email }));
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 3; i++) await step(post("/auth/verify", { email, code: "000000" }));
    return steps;
  };
  const [mine, theirs] = [await run(m.email), await run(stranger)];
  assert.deepEqual(mine, theirs);
  // The kept code ran out of guesses at the fifth: the sixth finds no code.
  assert.equal(JSON.parse((theirs.at(-1) as [number, string])[1]).error, "expired_code");
});

test("sign-out ends the session, clears the cookies and closes its sockets", async () => {
  const headers = await asUser(ws.ownerId);
  const c = await Client.open(server.url, headers);
  const closed = new Promise<number>((r) => c.ws.once("close", (code) => r(code)));
  await c.next((f) => f.t === "hello", 3000, true);
  const r = await post("/auth/sign-out", {}, headers);
  assert.equal(r.status, 204);
  assert.ok(r.headers.getSetCookie().every((c) => /Max-Age=0/.test(c)));
  // The browser drops its cached files and pictures, not its storage: the Service Worker's shell stays (RSVA-620).
  assert.equal(r.headers.get("clear-site-data"), '"cache"');
  assert.equal(await closed, CLOSE_UNAUTHORIZED);
  assert.equal((await fetch(url("/sync/workspaces"), { headers })).status, 401);
});

test("forged cross-site writes: a cookie write needs our Origin, a cookie socket too", async () => {
  const headers = await asUser(ws.ownerId);
  const { origin: _, ...noOrigin } = headers;
  assert.equal((await fetch(url("/auth/sign-out"), { method: "POST", headers: noOrigin })).status, 403);
  assert.equal((await fetch(url("/auth/sign-out"), { method: "POST", headers: { ...headers, origin: "https://evil.example" } })).status, 403);
  assert.equal(await socketOutcome(noOrigin), CLOSE_UNAUTHORIZED);
  // Still signed in: none of the above went through.
  assert.equal((await fetch(url("/sync/workspaces"), { headers })).status, 200);
});

test("terminal sign-in: a fresh session shows a one-time code, the terminal trades it once for a session of its own", async () => {
  const cookie = await asUser(ws.ownerId);
  const shown = await post("/auth/terminal/code", {}, cookie);
  assert.equal(shown.status, 200);
  const { code } = (await shown.json()) as TerminalCode;
  // The terminal sends no Origin and no cookie.
  const trade = (c: string) => fetch(url("/auth/terminal"), { method: "POST", headers: { "content-type": "application/json", "user-agent": "rsva/cli (Macintosh; Mac OS X)" }, body: JSON.stringify({ code: c }) });
  const r = await trade(code);
  assert.equal(r.status, 200);
  const t = (await r.json()) as TerminalSession;
  assert.equal(t.user.email, ownerEmail);
  assert.equal((await trade(code)).status, 400, "a code works once");
  assert.equal((await trade("made-up")).status, 400);

  // The session is the person's, in a header: no Origin for a socket or a write (sign-out below).
  const terminal = { authorization: `Session ${t.session}` };
  assert.equal((await fetch(url("/sync/workspaces"), { headers: terminal })).status, 200);
  assert.equal(await socketOutcome(terminal, ws.slug), "open");
  const security = (await (await fetch(url("/auth/security"), { headers: terminal })).json()) as AccountSecurity;
  assert.ok(security.sessions.some((s) => s.current && s.method === "cli" && s.device === "Terminal on macOS"));
  // A forged Session header is nobody; a session's secret in Bearer is not a token.
  assert.equal((await fetch(url("/sync/workspaces"), { headers: { authorization: "Session forged" } })).status, 401);
  assert.equal((await fetch(url("/sync/workspaces"), { headers: { authorization: `Bearer ${t.session}` } })).status, 401);
  assert.equal((await fetch(url("/auth/sign-out"), { method: "POST", headers: terminal })).status, 204);
  assert.equal((await fetch(url("/sync/workspaces"), { headers: terminal })).status, 401);
});

test("terminal sign-in: a code needs a fresh sign-in, a new code ends the one before, a token gets none", async () => {
  const { id } = await addMember(ws.workspaceId, "member");
  const cookie = await asUser(id);
  const first = ((await (await post("/auth/terminal/code", {}, cookie)).json()) as TerminalCode).code;
  const second = ((await (await post("/auth/terminal/code", {}, cookie)).json()) as TerminalCode).code;
  assert.equal((await post("/auth/terminal", { code: first })).status, 400);
  assert.equal((await post("/auth/terminal", { code: second })).status, 200);
  await agedSession(cookie);
  const r = await post("/auth/terminal/code", {}, cookie);
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { error: string }).error, "reauth_required");
  assert.equal((await post("/auth/terminal/code", {}, await asToken(ws.workspaceId, id))).status, 403);
});

test("terminal sign-in: no sign-in of its own: the session keeps the browser's sign-in time, and a terminal shows no code", async () => {
  const { id } = await addMember(ws.workspaceId, "member");
  const cookie = await agedSession(await asUser(id), 9);
  const browser = await db.select({ at: schema.session.createdAt }).from(schema.session).where(eq(schema.session.id, sha256(cookie.cookie!.split("=")[1]!)));
  const { code } = (await (await post("/auth/terminal/code", {}, cookie)).json()) as TerminalCode;
  const t = (await (await post("/auth/terminal", { code })).json()) as TerminalSession;
  const terminal = await db.select({ at: schema.session.createdAt }).from(schema.session).where(eq(schema.session.id, sha256(t.session)));
  // Trading a code made nothing fresh: a minute later the terminal is as stale as the browser, and cannot chain.
  assert.equal(Date.parse(terminal[0]!.at), Date.parse(browser[0]!.at));
  const r = await fetch(url("/auth/terminal/code"), { method: "POST", headers: { authorization: `Session ${t.session}` } });
  assert.equal(r.status, 403);
});

test("terminal sign-in: a code dies with the browser session that showed it, however that ends", async () => {
  const { id } = await addMember(ws.workspaceId, "member");
  const codeOf = async (cookie: Record<string, string>) => ((await (await post("/auth/terminal/code", {}, cookie)).json()) as TerminalCode).code;
  const handleOf = async (cookie: Record<string, string>) => ((await (await fetch(url("/auth/security"), { headers: cookie })).json()) as AccountSecurity).sessions.find((s) => s.current)!.id;

  // Signed out: the code the attacker kept back is dead with the cookie.
  const signedOut = await asUser(id);
  const first = await codeOf(signedOut);
  assert.equal((await fetch(url("/auth/sign-out"), { method: "POST", headers: signedOut })).status, 204);
  assert.equal((await post("/auth/terminal", { code: first })).status, 400);

  // Ended from another session, by id.
  const stolen = await asUser(id);
  const owner = await asUser(id);
  const second = await codeOf(stolen);
  assert.equal((await fetch(url(`/auth/sessions/${await handleOf(stolen)}`), { method: "DELETE", headers: owner })).status, 204);
  assert.equal((await post("/auth/terminal", { code: second })).status, 400);

  // Signed out everywhere else; and the session in use still trades its code.
  const third = await codeOf(await asUser(id));
  assert.equal((await post("/auth/sessions/end-others", {}, owner)).status, 200);
  assert.equal((await post("/auth/terminal", { code: third })).status, 400);
  assert.equal((await post("/auth/terminal", { code: await codeOf(owner) })).status, 200);
});

/** A new member's browser session and the terminal session its code was traded for (ADR 0044). */
async function memberWithTerminal(): Promise<{ id: string; cookie: Record<string, string>; session: string }> {
  const { id } = await addMember(ws.workspaceId, "member");
  const cookie = await asUser(id);
  const { code } = (await (await post("/auth/terminal/code", {}, cookie)).json()) as TerminalCode;
  const t = (await (await post("/auth/terminal", { code })).json()) as TerminalSession;
  return { id, cookie, session: t.session };
}

test("terminal sign-in: the session makes no new way in, however fresh; it may end sessions and ends after a year from the sign-in", async () => {
  const t = await memberWithTerminal();
  const terminal = { authorization: `Session ${t.session}`, origin: ORIGIN };
  // Fresh (the browser signed in a moment ago), yet an API token, a passkey, the sign-in address and the Telegram chat
  // are the browser's to make: the Keychain's session must not make itself a key that outlives it (PLNR-326).
  const refused = async (res: Response) => assert.deepEqual([res.status, ((await res.json()) as { error: string }).error], [403, "forbidden"]);
  await refused(await post(`/api/v1/workspaces/${ws.slug}/tokens`, { name: "mine", scope: "write" }, terminal));
  await refused(await post("/auth/passkeys/options", {}, terminal));
  await refused(await post("/auth/email", { email: "elsewhere@example.com" }, terminal));
  // The same secret in a cookie, with an Origin a non-browser adds: still the terminal's session, judged by its method.
  const asCookie = { cookie: `rsva_sid=${t.session}`, origin: ORIGIN };
  await refused(await post(`/api/v1/workspaces/${ws.slug}/tokens`, { name: "mine", scope: "write" }, asCookie));
  await refused(await post("/auth/terminal/code", {}, asCookie));
  // And the browser's own secret sent in the header comes from outside the browser: no code for it either.
  await refused(await post("/auth/terminal/code", {}, { authorization: `Session ${t.cookie.cookie!.split("=")[1]!}`, origin: ORIGIN }));
  // Ending another session is protection, not access: open to the terminal.
  const security = (await (await fetch(url("/auth/security"), { headers: terminal })).json()) as AccountSecurity;
  const browser = security.sessions.find((s) => !s.current)!;
  assert.equal((await fetch(url(`/auth/sessions/${browser.id}`), { method: "DELETE", headers: terminal })).status, 204);
  // A year from the sign-in it inherits, not from the trade.
  const [row] = await db.select({ createdAt: schema.session.createdAt, expiresAt: schema.session.expiresAt }).from(schema.session).where(eq(schema.session.id, sha256(t.session)));
  assert.equal(Date.parse(row!.expiresAt) - Date.parse(row!.createdAt), 365 * 86_400_000);
});

test("sign-in over a terminal's session leaves it: the header is no browser", async () => {
  const t = await memberWithTerminal();
  const email = (await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, t.id)))[0]!.email;
  assert.equal((await post("/auth/code", { email })).status, 204);
  const r = await post("/auth/verify", { email, code: await codeFor(email) }, { authorization: `Session ${t.session}` });
  assert.equal(r.status, 200);
  assert.equal((await fetch(url("/sync/workspaces"), { headers: { authorization: `Session ${t.session}` } })).status, 200, "the terminal's session stays");
});

test("workspaces: only memberships, another team's workspace is a 404, a guest is refused", async () => {
  const owner = fetchAs(await asUser(ws.ownerId));
  const slugs = ((await (await owner(url("/sync/workspaces"))).json()) as { slug: string }[]).map((w) => w.slug);
  assert.ok(slugs.includes(ws.slug));
  assert.ok(!slugs.includes(other.slug));
  assert.equal((await owner(url(`/sync/bootstrap?ws=${other.slug}`))).status, 404);
  const { issue } = await issueWithRefs(other.workspaceId);
  assert.equal((await owner(url(`/sync/history/${issue.id}`))).status, 404);
  assert.equal((await owner(url(`/api/v1/workspaces/${other.slug}/issues/CORE-1`))).status, 404);
  assert.equal(await socketOutcome(await asUser(ws.ownerId), other.slug), CLOSE_NOT_FOUND);

  const guest = await addMember(ws.workspaceId, "guest");
  const g = await asUser(guest.id);
  assert.equal((await fetch(url(`/sync/bootstrap?ws=${ws.slug}`), { headers: g })).status, 403);
  assert.equal(await socketOutcome(g, ws.slug), CLOSE_FORBIDDEN);
});

test("roles in transactions: members edit issues, settings ops need an admin", async () => {
  const member = await addMember(ws.workspaceId, "member");
  const { issue, project } = await issueWithRefs(ws.workspaceId);
  const c = await Client.open(server.url, await asUser(member.id));
  await c.next((f) => f.t === "hello", 3000, true);
  c.send({ t: "sub", ws: ws.slug, s: 0 });
  const ok = randomUUID();
  c.send({ t: "tx", id: ok, ops: [{ op: "update", m: "Issue", id: issue.id, set: { title: `by a member ${ok}` } }] });
  assert.equal((await c.next((f) => (f.t === "ack" || f.t === "rej") && f.id === ok)).t, "ack");
  const no = randomUUID();
  c.send({ t: "tx", id: no, ops: [{ op: "create", m: "WorkflowState", id: randomUUID(), set: { projectId: project.id, name: "X" } }] });
  const rej = await c.next((f) => f.t === "rej" && f.id === no);
  assert.equal(rej.t === "rej" && rej.code, "forbidden");
  c.close();
});

test("tokens: one workspace, read or write, revocable, never minting tokens", async () => {
  const { issue, project } = await issueWithRefs(ws.workspaceId);
  const key = `${project.key}-${issue.number}`;
  const read = await asToken(ws.workspaceId, ws.agentId, "read");
  const issueUrl = url(`/api/v1/workspaces/${ws.slug}/issues/${key}`);
  assert.equal((await fetch(issueUrl, { headers: read })).status, 200);
  const patch = (h: Record<string, string>) => fetch(issueUrl, { method: "PATCH", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ priority: 2 }) });
  const denied = await patch(read);
  assert.equal(denied.status, 403);
  assert.match(((await denied.json()) as { message: string }).message, /read-only/);
  assert.equal((await fetch(url(`/api/v1/workspaces/${other.slug}/issues/CORE-1`), { headers: read })).status, 404);
  assert.equal((await fetch(url(`/sync/bootstrap?ws=${other.slug}`), { headers: read })).status, 404);
  assert.equal((await fetch(url(`/api/v1/workspaces/${ws.slug}/tokens`), { headers: read })).status, 403);

  // Tokens are managed from a browser session: an admin makes one for the agent, then revokes it. Not the shared owner:
  // making a token counts under the per-person limit the passkey tests spend (RSVA-188).
  const owner = await asUser((await addMember(ws.workspaceId, "admin")).id);
  const made = await post(`/api/v1/workspaces/${ws.slug}/tokens`, { name: "claude", scope: "write", user: `bot@${ws.slug}.test` }, owner);
  assert.equal(made.status, 201);
  const t = (await made.json()) as { id: string; secret: string };
  assert.match(t.secret, /^rsva_/);
  const write = { authorization: `Bearer ${t.secret}` };
  assert.equal((await patch(write)).status, 200);
  // Only rsva_ is read: a secret of another prefix is refused even when its hash is stored (pln_ until PLNR-319).
  const before = (await (await post(`/api/v1/workspaces/${ws.slug}/tokens`, { name: "old", scope: "read" }, owner)).json()) as { id: string; secret: string };
  const old = `pln_${before.secret.slice("rsva_".length)}`;
  await db.update(schema.apiToken).set({ hash: sha256(old) }).where(eq(schema.apiToken.id, before.id));
  assert.equal((await fetch(issueUrl, { headers: { authorization: `Bearer ${old}` } })).status, 401);
  const list = (await (await fetch(url(`/api/v1/workspaces/${ws.slug}/tokens`), { headers: owner })).json()) as { tokens: { id: string; user: string }[] };
  assert.ok(list.tokens.some((x) => x.id === t.id && x.user === `bot@${ws.slug}.test`));
  assert.ok(!JSON.stringify(list).includes(t.secret));
  const sock = await Client.open(server.url, write);
  const closed = new Promise<number>((r) => sock.ws.once("close", (code) => r(code)));
  assert.equal((await fetch(url(`/api/v1/workspaces/${ws.slug}/tokens/${t.id}`), { method: "DELETE", headers: owner })).status, 204);
  assert.equal(await closed, CLOSE_UNAUTHORIZED);
  assert.equal((await fetch(issueUrl, { headers: write })).status, 401);

  // A member makes tokens for themselves, not for agents.
  const member = await asUser((await addMember(ws.workspaceId, "member")).id);
  assert.equal((await post(`/api/v1/workspaces/${ws.slug}/tokens`, { name: "mine", scope: "read" }, member)).status, 201);
  assert.equal((await post(`/api/v1/workspaces/${ws.slug}/tokens`, { name: "x", scope: "write", user: `bot@${ws.slug}.test` }, member)).status, 403);
  assert.equal((await post(`/api/v1/workspaces/${ws.slug}/tokens`, { name: "x", scope: "write", user: ownerEmail }, member)).status, 403);
  assert.equal((await post(`/api/v1/workspaces/${ws.slug}/tokens`, { name: "x", scope: "admin" }, member)).status, 400);
});

test("tokens: a member sees and revokes only their own, an admin any in the workspace, and nobody another workspace's", async () => {
  const tokens = `/api/v1/workspaces/${ws.slug}/tokens`;
  const member = await asUser((await addMember(ws.workspaceId, "member")).id);
  const owner = await asUser((await addMember(ws.workspaceId, "admin")).id);
  const made = async (headers: Record<string, string>, name: string) => ((await (await post(tokens, { name, scope: "read" }, headers)).json()) as { id: string; secret: string });
  const mine = await made(member, "member's");
  const theirs = await made(owner, "owner's");
  const list = async (headers: Record<string, string>) => ((await (await fetch(url(tokens), { headers })).json()) as { tokens: { id: string }[] }).tokens.map((t) => t.id);
  assert.deepEqual(await list(member), [mine.id]);
  assert.ok((await list(owner)).includes(mine.id));
  const revoke = (id: string, headers: Record<string, string>) => fetch(url(`${tokens}/${id}`), { method: "DELETE", headers: { ...headers, origin: ORIGIN } });
  assert.equal((await revoke(theirs.id, member)).status, 404);
  assert.equal((await fetch(url(`/sync/bootstrap?ws=${ws.slug}`), { headers: { authorization: `Bearer ${theirs.secret}` } })).status, 200, "still live");

  // Another workspace: its admin does not reach this one's token, by its own workspace's address or by this one's.
  const elsewhere = await asUser(other.ownerId);
  assert.equal((await fetch(url(`/api/v1/workspaces/${other.slug}/tokens/${mine.id}`), { method: "DELETE", headers: { ...elsewhere, origin: ORIGIN } })).status, 404);
  assert.equal((await revoke(mine.id, elsewhere)).status, 404);
  assert.equal((await fetch(url(tokens), { headers: elsewhere })).status, 404);

  // A guest has no access yet, tokens included.
  const guest = await asUser((await addMember(ws.workspaceId, "guest")).id);
  assert.equal((await fetch(url(tokens), { headers: guest })).status, 403);
  assert.equal((await post(tokens, { name: "x", scope: "read" }, guest)).status, 403);

  assert.equal((await revoke(mine.id, owner)).status, 204);
});

test("tokens: a new one needs a fresh sign-in: a stolen cookie must not outlive itself as a token", async () => {
  const { id } = await addMember(ws.workspaceId, "member");
  const cookie = await asUser(id);
  const tokens = `/api/v1/workspaces/${ws.slug}/tokens`;
  await agedSession(cookie);
  const r = await post(tokens, { name: "x", scope: "read" }, cookie);
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { error: string }).error, "reauth_required");
  // Seeing and revoking stay open to it.
  assert.equal((await fetch(url(tokens), { headers: cookie })).status, 200);
});

test("tokens: a new one is mailed, an agent's to the owners and a person's own to that person, never with the secret (RSVA-188)", async () => {
  const tokens = `/api/v1/workspaces/${ws.slug}/tokens`;
  const admin = await addMember(ws.workspaceId, "admin");
  const agentEmail = `bot@${ws.slug}.test`;
  const r = await post(tokens, { name: "deploy bot", scope: "write", user: agentEmail, expiresInDays: 30 }, await asUser(admin.id));
  assert.equal(r.status, 201);
  const { secret } = (await r.json()) as { secret: string };
  const toOwner = await mailFor(ownerEmail, (m) => m.text.includes('"deploy bot"'));
  assert.match(toOwner.subject, /^An API token was made for /);
  assert.ok(toOwner.text.includes(admin.email));
  assert.ok(!(toOwner.text + toOwner.html).includes(secret));
  assert.ok(!mails.some((m) => m.to === admin.email && m.subject.includes("API token")), "an admin who is not an owner is not mailed");

  const member = await addMember(ws.workspaceId, "member");
  const own = await post(tokens, { name: "my laptop", scope: "read" }, await asUser(member.id));
  const ownSecret = ((await own.json()) as { secret: string }).secret;
  const toMember = await mailFor(member.email, (m) => m.subject.startsWith("An API token was made for your"));
  assert.match(toMember.text, /"my laptop"/);
  assert.match(toMember.text, /sign out your other devices in Settings › Security/);
  assert.ok(!(toMember.text + toMember.html).includes(ownSecret));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!mails.some((m) => m.to === ownerEmail && m.text.includes('"my laptop"')), "owners are not mailed for a member's own token");
});

test("tokens: a widened one is mailed as a new one is, with the access before and after; a narrowed one is not (RSVA-507)", async () => {
  const tokens = `/api/v1/workspaces/${ws.slug}/tokens`;
  const patch = (id: string, body: unknown, headers: Record<string, string>) => fetch(url(`${tokens}/${id}`), { ...json(body, headers), method: "PATCH" });
  const sent = (name: string) => mails.filter((m) => m.text.includes(`"${name}"`)).length;

  const member = await addMember(ws.workspaceId, "member");
  const own = await createToken({ workspaceId: ws.workspaceId, userId: member.id, name: "laptop 507", scope: "read", createdById: member.id });
  const cookie = await asUser(member.id);
  assert.equal((await patch(own.id, { scope: "write" }, cookie)).status, 204);
  const toMember = await mailFor(member.email, (m) => m.text.includes('"laptop 507"'));
  assert.equal(toMember.subject, `The access of your recursiva API token was widened in "${(await db.select({ name: schema.workspace.name }).from(schema.workspace).where(eq(schema.workspace.id, ws.workspaceId)))[0]!.name}"`);
  assert.match(toMember.text, /It now acts as you with write access \(before: read access\)/);
  assert.match(toMember.text, /sign out your other devices in Settings › Security/);
  assert.ok(!(toMember.text + toMember.html).includes(own.secret));
  // Narrowing, and a change that adds nothing, mail no one.
  assert.equal((await patch(own.id, { scope: "read" }, cookie)).status, 204);
  assert.equal((await patch(own.id, { scope: "read" }, cookie)).status, 204);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent("laptop 507"), 0);

  // An agent's: to the owners, naming who widened it; not to the admin who did.
  const admin = await addMember(ws.workspaceId, "admin");
  const adminCookie = await asUser(admin.id);
  const made = (await (await post(tokens, { name: "widened bot", scope: "read", user: `bot@${ws.slug}.test` }, adminCookie)).json()) as { id: string };
  await mailFor(ownerEmail, (m) => m.text.includes('"widened bot"'));
  assert.equal((await patch(made.id, { scope: "custom", grants: ["issues.write"] }, adminCookie)).status, 204);
  const toOwner = await mailFor(ownerEmail, (m) => m.text.includes('"widened bot"'));
  assert.match(toOwner.subject, /^The access of .+'s API token was widened in /);
  assert.match(toOwner.text, /with read access and issues\.write \(before: read access\)/);
  assert.ok(toOwner.text.includes(admin.email));
  assert.ok(toOwner.html.includes("Widened by"));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!mails.some((m) => m.to === admin.email && m.text.includes('"widened bot"')), "an admin who is not an owner is not mailed");
});

test("tokens: custom to write is a widening even when it reaches nothing more today: write follows its member's later rights (RSVA-606)", async () => {
  const tokens = `/api/v1/workspaces/${ws.slug}/tokens`;
  const member = await addMember(ws.workspaceId, "member");
  // Everything a member may change today (labels are open to members by default), as custom grants: write reaches the
  // same now, and more once the member may, as states or projects opened to members or a promotion to admin.
  const own = await createToken({ workspaceId: ws.workspaceId, userId: member.id, name: "all 606", scope: "custom", grants: ["issues.write", "comments.write", "cycles.write", "views.write", "labels.write"], createdById: member.id });
  const patch = (body: unknown, headers: Record<string, string>) => fetch(url(`${tokens}/${own.id}`), { ...json(body, headers), method: "PATCH" });
  const terminal = { authorization: `Session ${(await createSession(member.id, "cli", "test")).token}` };
  assert.equal((await patch({ scope: "write" }, terminal)).status, 403, "a terminal session does not widen");
  const stale = await patch({ scope: "write" }, await agedSession(await asUser(member.id)));
  assert.equal(((await stale.json()) as { error: string }).error, "reauth_required", "a stale session does not widen");
  assert.equal((await patch({ scope: "write" }, await asUser(member.id))).status, 204);
  const notice = await mailFor(member.email, (m) => m.text.includes('"all 606"'));
  assert.match(notice.text, /It now acts as you with write access \(before: read access and /);
  // Back to the same grants is narrowing, from any session.
  assert.equal((await patch({ scope: "custom", grants: ["issues.write", "comments.write", "cycles.write", "views.write", "labels.write"] }, terminal)).status, 204);
});

test("tokens: widening counts under the per-person limit of mailed steps, narrowing does not (RSVA-249, RSVA-507)", async () => {
  const member = await addMember(ws.workspaceId, "member");
  const cookie = await asUser(member.id);
  const t = await createToken({ workspaceId: ws.workspaceId, userId: member.id, name: "loop", scope: "read", createdById: member.id });
  const patch = (scope: string) => fetch(url(`/api/v1/workspaces/${ws.slug}/tokens/${t.id}`), { ...json({ scope }, cookie), method: "PATCH" });
  for (let i = 0; i < 10; i++) {
    assert.equal((await patch("write")).status, 204);
    assert.equal((await patch("read")).status, 204);
  }
  assert.equal((await patch("write")).status, 429);
  assert.equal((await patch("read")).status, 204, "narrowing is never held back");
});

test("tokens: a failed notice does not fail making or widening the token (RSVA-188, RSVA-507)", async () => {
  const own = await startServer({ mailer: async () => Promise.reject(new Error("mail down")) });
  after(() => own.close());
  const cookie = await asUser((await addMember(ws.workspaceId, "member")).id);
  const r = await post(`/api/v1/workspaces/${ws.slug}/tokens`, { name: "x", scope: "read" }, cookie, own.url);
  assert.equal(r.status, 201);
  const { id } = (await r.json()) as { id: string };
  const widen = await fetch(`${own.url}/api/v1/workspaces/${ws.slug}/tokens/${id}`, { ...json({ scope: "write" }, cookie), method: "PATCH" });
  assert.equal(widen.status, 204);
});

test("tokens: Read or Write per resource, never past the member; member rights open labels to members and agents alike", async () => {
  const { project } = await issueWithRefs(ws.workspaceId);
  const tokens = `/api/v1/workspaces/${ws.slug}/tokens`;
  const agentEmail = `bot@${ws.slug}.test`;
  const admin = await addMember(ws.workspaceId, "admin");
  const adminCookie = await asUser(admin.id);
  const send = (method: string, path: string, body: unknown, headers: Record<string, string>) =>
    fetch(url(path), { method, headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
  const rights = (r: string[]) => applyTx(ws.workspaceId, ws.ownerId, randomUUID(), [{ op: "update", m: "Workspace", id: ws.workspaceId, set: { memberRights: r } }]);
  await rights(["labels.write"]);

  // What may be given: never members or tokens, never past the member, even by an admin.
  assert.equal((await post(tokens, { name: "x", scope: "custom", user: agentEmail, grants: ["members.manage"] }, adminCookie)).status, 400);
  assert.equal((await post(tokens, { name: "x", scope: "custom", user: agentEmail, grants: [] }, adminCookie)).status, 400);
  assert.equal((await post(tokens, { name: "x", scope: "write", grants: ["issues.write"] }, adminCookie)).status, 400);
  assert.equal((await post(tokens, { name: "x", scope: "custom", user: agentEmail, grants: ["labels.create"] }, adminCookie)).status, 400, "no Create level");
  const past = await post(tokens, { name: "x", scope: "custom", user: agentEmail, grants: ["states.write"] }, adminCookie);
  assert.equal(past.status, 403);
  assert.match(((await past.json()) as { message: string }).message, /never goes past its member: a member here cannot states\.write/);
  const member = await asUser((await addMember(ws.workspaceId, "member")).id);
  const mine = (await (await post(tokens, { name: "mine", scope: "custom", grants: ["comments.write", "labels.write"] }, member)).json()) as { id: string };

  const made = await post(tokens, { name: "labeller", scope: "custom", user: agentEmail, grants: ["issues.write", "labels.write"] }, adminCookie);
  assert.equal(made.status, 201);
  const t = (await made.json()) as { id: string; secret: string };
  const agent = { authorization: `Bearer ${t.secret}` };
  const me = (await (await fetch(url(`/api/v1/workspaces/${ws.slug}/workspace`), { headers: agent })).json()) as { memberRights: string[]; me: { scope: string; grants: string[] } };
  assert.deepEqual(me.memberRights, ["labels.write"]);
  assert.deepEqual(me.me, { ...me.me, scope: "custom", grants: ["issues.write", "labels.write"] });

  const labels = `/api/v1/workspaces/${ws.slug}/labels`;
  assert.equal((await send("POST", labels, { project: project.key, name: "made-a" }, agent)).status, 201);
  assert.equal((await send("PATCH", `${labels}/made-a?project=${project.key}`, { name: "made-b" }, agent)).status, 200, "Write makes and changes");
  const comment = await send("POST", `/api/v1/workspaces/${ws.slug}/issues/${project.key}-1/comments`, { body: "hi" }, agent);
  assert.equal(comment.status, 403, "comments were not given");
  assert.match(((await comment.json()) as { message: string }).message, /the token lacks Comments: write/);

  // A label only people change: the agent neither renames nor deletes it, nor makes another that reads as it.
  const guardId = randomUUID();
  await applyTx(ws.workspaceId, ws.ownerId, randomUUID(), [{ op: "create", m: "Label", id: guardId, set: { projectId: project.id, name: "proposed", color: "#8D8D86", position: 99, onlyPeople: true } }]);
  // One that reads as it comes guarded: it can take nothing's place.
  assert.equal((await send("POST", labels, { project: project.key, name: "pr0posed" }, agent)).status, 201);
  const guardedLabel = ((await (await fetch(url(`${labels}?project=${project.key}`), { headers: agent })).json()) as { name: string; onlyPeople: boolean }[]).find((l) => l.name === "pr0posed");
  assert.equal(guardedLabel?.onlyPeople, true);
  const renamed = await send("PATCH", `${labels}/proposed?project=${project.key}`, { name: "idea" }, agent);
  assert.deepEqual(await renamed.json(), { error: "forbidden", message: 'agents cannot rename or delete the label "proposed": only people change it' });
  assert.equal((await send("PATCH", `${labels}/proposed?project=${project.key}`, { color: "#E5484D" }, agent)).status, 200, "a recolor is not a rename");

  // Closed to members, labels stop for the agent at once, its stored grant held back, not dropped; opened, it is back.
  await rights([]);
  const closed = await send("POST", labels, { project: project.key, name: "made-c" }, agent);
  assert.equal(closed.status, 403);
  assert.match(((await closed.json()) as { message: string }).message, /a member cannot change Label; an admin can open Labels to members in Settings › Members/);
  const listed = (await (await fetch(url(tokens), { headers: adminCookie })).json()) as { tokens: { id: string; grants: string[]; held: string[] }[] };
  assert.deepEqual(listed.tokens.find((x) => x.id === t.id), { ...listed.tokens.find((x) => x.id === t.id)!, grants: ["issues.write", "labels.write"], held: ["issues.write"] });
  await rights(["labels.write"]);
  assert.equal((await send("POST", labels, { project: project.key, name: "made-c" }, agent)).status, 201);

  // Narrowing needs no fresh sign-in; widening does. A widened token's open sockets close and reconnect.
  await agedSession(adminCookie);
  assert.equal((await send("PATCH", `${tokens}/${t.id}`, { scope: "custom", grants: ["issues.write"] }, adminCookie)).status, 204);
  assert.equal((await send("POST", labels, { project: project.key, name: "made-d" }, agent)).status, 403, "the cached lookup went with the change");
  const widen = await send("PATCH", `${tokens}/${t.id}`, { scope: "custom", grants: ["issues.write", "labels.write"] }, adminCookie);
  assert.equal(widen.status, 403);
  assert.equal(((await widen.json()) as { error: string }).error, "reauth_required");
  const fresh = await asUser(admin.id);
  const sock = await Client.open(server.url, agent);
  const reconnect = new Promise<number>((r) => sock.ws.once("close", (code) => r(code)));
  assert.equal((await send("PATCH", `${tokens}/${t.id}`, { scope: "custom", grants: ["issues.write", "labels.write"] }, fresh)).status, 204);
  await reconnect;
  assert.equal((await send("POST", labels, { project: project.key, name: "made-d" }, agent)).status, 201);
  const list = (await (await fetch(url(tokens), { headers: fresh })).json()) as { tokens: { id: string; scope: string; grants: string[]; grantedBy: string | null }[] };
  assert.deepEqual(list.tokens.find((x) => x.id === t.id), { ...list.tokens.find((x) => x.id === t.id)!, scope: "custom", grants: ["issues.write", "labels.write"], grantedBy: admin.email });

  // A member changes only their own tokens; an admin does not change another person's, only revokes it.
  assert.equal((await send("PATCH", `${tokens}/${t.id}`, { scope: "read" }, member)).status, 404);
  assert.equal((await send("PATCH", `${tokens}/${mine.id}`, { scope: "read" }, fresh)).status, 404);
  assert.equal((await send("PATCH", `${tokens}/${mine.id}`, { scope: "read" }, member)).status, 204);
});

test("tokens: grants follow a role down and do not come back; a guarded state stays guarded when people rename it", async () => {
  const { project, issue } = await issueWithRefs(ws.workspaceId);
  const admin = await addMember(ws.workspaceId, "admin");
  const own = await createToken({ workspaceId: ws.workspaceId, userId: admin.id, name: "own", scope: "custom", grants: ["issues.write", "states.write"], createdById: admin.id });
  const role = (r: string) => applyTx(ws.workspaceId, ws.ownerId, randomUUID(), [{ op: "update", m: "User", id: admin.id, set: { role: r } }]);
  await role("member");
  await role("admin");
  const [row] = await db.select({ grants: schema.apiToken.grants }).from(schema.apiToken).where(eq(schema.apiToken.id, own.id));
  assert.deepEqual(row!.grants, ["issues.write"], "dropped from the row, not asleep");

  // States opened to members: the agent sets up workflows, but never Todo.
  await applyTx(ws.workspaceId, ws.ownerId, randomUUID(), [{ op: "update", m: "Workspace", id: ws.workspaceId, set: { memberRights: ["labels.write", "states.write"] } }]);
  const { secret } = await createToken({ workspaceId: ws.workspaceId, userId: ws.agentId, name: "states", scope: "custom", grants: ["issues.write", "states.write"], createdById: ws.ownerId });
  const agent = { authorization: `Bearer ${secret}` };
  const send = (method: string, path: string, body: unknown) => fetch(url(path), { method, headers: { "content-type": "application/json", origin: ORIGIN, ...agent }, body: JSON.stringify(body) });
  const states = `/api/v1/workspaces/${ws.slug}/states`;
  // Made the default, Todo would take every issue a person makes without picking a state; moved to another group, it
  // would complete (or reopen) every issue in it.
  const todoDefault = await send("PATCH", `${states}/Todo?project=${project.key}`, { default: true });
  assert.deepEqual(await todoDefault.json(), { error: "forbidden", message: 'agents cannot make "Todo" the default state or move it to another group: people set it' });
  const regroup = await send("PATCH", `${states}/Todo?project=${project.key}`, { group: "completed" });
  assert.deepEqual(await regroup.json(), { error: "forbidden", message: 'agents cannot make "Todo" the default state or move it to another group: people set it' });
  // A new one that reads as Todo comes guarded: the agent cannot move issues into it either.
  assert.equal((await send("POST", states, { project: project.key, name: "TODO", group: "unstarted" })).status, 201);
  const shouty = ((await (await fetch(url(`${states}?project=${project.key}`), { headers: agent })).json()) as { name: string; onlyPeople: boolean }[]).find((x) => x.name === "TODO");
  assert.equal(shouty?.onlyPeople, true);
  const into = await send("PATCH", `/api/v1/workspaces/${ws.slug}/issues/${project.key}-${issue.number}`, { state: "TODO" });
  assert.deepEqual(await into.json(), { error: "forbidden", message: 'agents cannot move issues to "TODO": people set this state' });
  assert.equal((await send("POST", states, { project: project.key, name: "Ready for QA", group: "started" })).status, 201);

  // Renamed by a person, Todo keeps its guard: the switch is on the row (before ADR 0037, renaming dropped it).
  const [todo] = await db
    .select({ id: schema.workflowState.id })
    .from(schema.workflowState)
    .where(and(eq(schema.workflowState.projectId, project.id), eq(schema.workflowState.name, "Todo")));
  await applyTx(ws.workspaceId, ws.ownerId, randomUUID(), [{ op: "update", m: "WorkflowState", id: todo!.id, set: { name: "Ready to start" } }], true);
  const moved = await send("PATCH", `/api/v1/workspaces/${ws.slug}/issues/${project.key}-${issue.number}`, { state: "Ready to start" });
  assert.deepEqual(await moved.json(), { error: "forbidden", message: 'agents cannot move issues to "Ready to start": people set this state' });
  await applyTx(ws.workspaceId, ws.ownerId, randomUUID(), [{ op: "update", m: "WorkflowState", id: todo!.id, set: { name: "Todo" } }], true);
  await applyTx(ws.workspaceId, ws.ownerId, randomUUID(), [{ op: "update", m: "Workspace", id: ws.workspaceId, set: { memberRights: ["labels.write"] } }]);
});

test("tokens: a guard comes off only by a signed-in admin: neither a member opened to labels nor an admin's token drops it by delete and remake", async () => {
  const { project } = await issueWithRefs(ws.workspaceId);
  const labels = `/api/v1/workspaces/${ws.slug}/labels`;
  const admin = await addMember(ws.workspaceId, "admin");
  const adminCookie = await asUser(admin.id);
  const member = await addMember(ws.workspaceId, "member");
  const { secret } = await createToken({ workspaceId: ws.workspaceId, userId: admin.id, name: "admin's", scope: "write", createdById: admin.id });
  const byToken = { authorization: `Bearer ${secret}` };
  const { secret: memberSecret } = await createToken({ workspaceId: ws.workspaceId, userId: member.id, name: "member's", scope: "write", createdById: member.id });
  const byMember = { authorization: `Bearer ${memberSecret}` };
  const send = (method: string, path: string, body: unknown, headers: Record<string, string>) =>
    fetch(url(path), { method, headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
  await applyTx(ws.workspaceId, ws.ownerId, randomUUID(), [{ op: "create", m: "Label", id: randomUUID(), set: { projectId: project.id, name: "owner", color: "#8D8D86", position: 98, onlyPeople: true } }]);

  for (const [who, headers] of [["member", byMember], ["admin's token", byToken]] as const) {
    const del = await send("DELETE", `${labels}/owner?project=${project.key}`, undefined, headers);
    assert.deepEqual(await del.json(), { error: "forbidden", message: 'only a signed-in admin can rename or delete the label "owner": only people change it' }, who);
    const away = await send("PATCH", `${labels}/owner?project=${project.key}`, { name: "owner-old" }, headers);
    assert.equal(away.status, 403, `${who}: renamed away, a new "owner" would take its place`);
    assert.equal((await send("PATCH", `${labels}/owner?project=${project.key}`, { color: "#E5484D" }, headers)).status, 200, `${who}: a recolor keeps it`);
  }
  // A new label that reads as it comes guarded: it cannot take the place of the one people set.
  assert.equal((await send("POST", labels, { project: project.key, name: "0wner" }, byMember)).status, 201);
  const shadow = ((await (await fetch(url(`${labels}?project=${project.key}`), { headers: byMember })).json()) as { name: string; onlyPeople: boolean }[]).find((l) => l.name === "0wner");
  assert.equal(shadow?.onlyPeople, true);
  // A signed-in admin may: it is theirs to set.
  assert.equal((await send("DELETE", `${labels}/owner?project=${project.key}`, undefined, adminCookie)).status, 200);
});

test("sessions: a person sees their own, ends them by a handle that is not the key, and keeps the one in use", async () => {
  const { id: userId } = await addMember(ws.workspaceId, "member");
  const { id: strangerId } = await addMember(ws.workspaceId, "member");
  const here = await asUser(userId);
  const phone = await asUser(userId);
  const tablet = await asUser(userId);
  const stranger = await asUser(strangerId);
  const del = (id: string, headers: Record<string, string>) => fetch(url(`/auth/sessions/${id}`), { method: "DELETE", headers: { ...headers, origin: ORIGIN } });
  const sessions = async (headers: Record<string, string>) => ((await (await fetch(url("/auth/security"), { headers })).json()) as AccountSecurity).sessions;

  const seen = await sessions(here);
  assert.equal(seen.length, 3);
  assert.equal(seen.filter((s) => s.current).length, 1);
  const rows = await db.select({ id: schema.session.id }).from(schema.session).where(eq(schema.session.userId, userId));
  for (const r of rows) assert.ok(!JSON.stringify(seen).includes(r.id), "the session's key stays on the server");

  // Not someone else's, and not the one in use: that leaves by sign-out, which clears its cookies.
  const other = seen.find((s) => !s.current)!;
  assert.equal((await del(other.id, stranger)).status, 404);
  assert.equal((await del(seen.find((s) => s.current)!.id, here)).status, 400);
  assert.equal((await del("nonsense", here)).status, 404);

  // Ending one closes its sockets at once, and the cached session does not outlive it. Which of the two it was is
  // told by the list: `current` from each of their own requests.
  const [victim, survivor] = (await sessions(phone)).find((s) => s.current)!.id === other.id ? [phone, tablet] : [tablet, phone];
  const sock = await Client.open(server.url, victim);
  const closed = new Promise<number>((r) => sock.ws.once("close", (code) => r(code)));
  assert.equal((await del(other.id, here)).status, 204);
  assert.equal(await closed, CLOSE_UNAUTHORIZED);
  assert.equal((await fetch(url("/auth/me"), { headers: victim })).status, 401);
  assert.equal((await fetch(url("/auth/me"), { headers: survivor })).status, 200);

  // Every other device at once.
  const left = await Client.open(server.url, survivor);
  const leftClosed = new Promise<number>((r) => left.ws.once("close", (code) => r(code)));
  const ended = await fetch(url("/auth/sessions/end-others"), { method: "POST", headers: { ...here, origin: ORIGIN } });
  assert.deepEqual(await ended.json(), { ended: 1 });
  assert.equal(await leftClosed, CLOSE_UNAUTHORIZED);
  assert.equal((await fetch(url("/auth/me"), { headers: survivor })).status, 401);
  assert.equal((await fetch(url("/auth/me"), { headers: here })).status, 200);
  assert.equal((await sessions(here)).length, 1);
});

test("sessions: tokens cannot reach them, and a forged request without Origin is refused", async () => {
  const token = await asToken(ws.workspaceId, ws.ownerId, "write");
  const owner = await asUser(ws.ownerId);
  assert.equal((await fetch(url("/auth/security"), { headers: token })).status, 403);
  assert.equal((await fetch(url("/auth/sessions/end-others"), { method: "POST", headers: { ...token, origin: ORIGIN } })).status, 403);
  assert.equal((await fetch(url("/auth/sessions/end-others"), { method: "POST", headers: { cookie: owner.cookie! } })).status, 403);
  assert.equal((await fetch(url("/auth/sessions/end-others"), { method: "POST", headers: { ...owner, origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(url("/auth/me"), { headers: owner })).status, 200);
});

test("sessions: confirming it's you replaces the session: one browser stays one row, and it is fresh", async () => {
  const own = await ownServer();
  const { id, email } = await addMember(ws.workspaceId, "member");
  const old = await asUser(id);
  await own.post("/auth/code", { email });
  const signedIn = await own.post("/auth/verify", { email, code: await codeFor(email) }, old);
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
  assert.equal((await fetch(url("/auth/me"), { headers: old })).status, 401, "the old cookie is over");
  const fresh = { cookie: cookieOf(signedIn) };
  const { sessions } = (await (await fetch(url("/auth/security"), { headers: fresh })).json()) as AccountSecurity;
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0]!.current);
});

test("sessions: a socket that never subscribed does not outlive its session: a late sub is refused", async () => {
  const { id } = await addMember(ws.workspaceId, "member");
  const headers = await asUser(id);
  const sock = await Client.open(server.url, headers);
  const closed = new Promise<number>((r) => sock.ws.once("close", (code) => r(code)));
  // The session ends with nothing closing its sockets, as a replaced one does for a moment.
  const rows = await db.select({ id: schema.session.id }).from(schema.session).where(eq(schema.session.userId, id));
  await endSession(rows[0]!.id);
  sock.send({ t: "sub", ws: ws.slug, s: 0 });
  assert.equal(await closed, CLOSE_UNAUTHORIZED);
});

test("sessions: replacing a session closes its sockets a moment later, once the new cookie has landed", async () => {
  const own = await ownServer();
  const { id, email } = await addMember(ws.workspaceId, "member");
  const old = await asUser(id);
  const sock = await Client.open(own.url, old);
  const closed = new Promise<number>((r) => sock.ws.once("close", (code) => r(code)));
  await own.post("/auth/code", { email });
  const started = Date.now();
  assert.equal((await own.post("/auth/verify", { email, code: await codeFor(email) }, old)).status, 200);
  assert.equal(await closed, CLOSE_UNAUTHORIZED);
  assert.ok(Date.now() - started >= 1000, "not before the answer has had time to arrive");
});

test("sessions: an old cookie cannot lock its owner out: it ends older sessions only, a fresh sign-in ends any", async () => {
  const { id } = await addMember(ws.workspaceId, "member");
  const opened = async (min: number) => agedSession(await asUser(id), min);
  const older = await opened(60);
  const stolen = await opened(30);
  const owner = await asUser(id);
  const alive = async (h: Record<string, string>) => (await fetch(url("/auth/me"), { headers: h })).status === 200;
  const del = (sid: string, h: Record<string, string>) => fetch(url(`/auth/sessions/${sid}`), { method: "DELETE", headers: { ...h, origin: ORIGIN } });
  const sessions = async (h: Record<string, string>) => ((await (await fetch(url("/auth/security"), { headers: h })).json()) as AccountSecurity).sessions;
  const newest = (await sessions(owner)).find((s) => s.current)!;

  // The stale cookie cannot end the session signed in after it, one by one or all at once.
  const one = await del(newest.id, stolen);
  assert.equal(one.status, 403);
  assert.equal(((await one.json()) as { error: string }).error, "reauth_required");
  const all = await fetch(url("/auth/sessions/end-others"), { method: "POST", headers: { ...stolen, origin: ORIGIN } });
  assert.equal(all.status, 403);
  assert.equal(((await all.json()) as { error: string }).error, "reauth_required");
  assert.ok(await alive(owner));
  // Older ones it can, and did: that is what a person on a stale session comes for.
  assert.ok(!(await alive(older)));

  // The owner's fresh sign-in ends the stolen one, which is older in any case.
  const ended = await fetch(url("/auth/sessions/end-others"), { method: "POST", headers: { ...owner, origin: ORIGIN } });
  assert.deepEqual(await ended.json(), { ended: 1 });
  assert.ok(!(await alive(stolen)));
});

test("passkeys: register while signed in, then sign in with them; ES256 and EdDSA", async () => {
  for (const kind of ["ES256", "EdDSA"] as const) {
    const auth = new SoftAuthenticator(kind);
    const owner = await asUser(ws.ownerId);
    const opts = (await (await post("/auth/passkeys/options", {}, owner)).json()) as { challenge: string; rp: { id: string }; user: { id: string } };
    assert.equal(opts.rp.id, "127.0.0.1");
    const reg = await post("/auth/passkeys", { credential: auth.register(opts, ORIGIN), name: `Mac ${kind}` }, owner);
    assert.equal(reg.status, 201, await reg.clone().text());

    const login = (await (await post("/auth/passkey/options", {})).json()) as { challenge: string; rpId: string };
    const r = await post("/auth/passkey", { credential: auth.assert(login, ORIGIN) });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await fetch(url("/auth/me"), { headers: { cookie: cookieOf(r) } })).status, 200);
  }
  const me = (await (await fetch(url("/auth/me"), { headers: await asUser(ws.ownerId) })).json()) as { passkeys: { name: string }[] };
  assert.deepEqual(me.passkeys.map((p) => p.name), ["Mac ES256", "Mac EdDSA"]);
});

test("passkeys: wrong origin, RP, type, flags, signature, a replayed challenge and a counter going back are refused", async () => {
  const auth = new SoftAuthenticator();
  const owner = await asUser(ws.ownerId);
  const regOpts = async () => (await (await post("/auth/passkeys/options", {}, owner)).json()) as { challenge: string; rp: { id: string }; user: { id: string } };
  const failsReg = async (t: Parameters<SoftAuthenticator["register"]>[2]) =>
    assert.equal((await post("/auth/passkeys", { credential: auth.register(await regOpts(), ORIGIN, t) }, owner)).status, 400, JSON.stringify(t));
  await failsReg({ origin: "http://localhost:1" });
  await failsReg({ rpId: "evil.example" });
  await failsReg({ type: "webauthn.get" });
  await failsReg({ flags: 0x41 }); // not user-verified
  await failsReg({ challenge: "AAAA" });
  assert.equal((await post("/auth/passkeys", { credential: auth.register(await regOpts(), ORIGIN) }, owner)).status, 201);

  const loginOpts = async () => (await (await post("/auth/passkey/options", {})).json()) as { challenge: string; rpId: string };
  const failsLogin = async (cred: object) => assert.equal((await post("/auth/passkey", { credential: cred })).status, 400);
  await failsLogin(auth.assert(await loginOpts(), "http://localhost:1"));
  await failsLogin(auth.assert(await loginOpts(), ORIGIN, { flags: 0x01 }));
  await failsLogin({ ...auth.assert(await loginOpts(), ORIGIN), signature: auth.assert(await loginOpts(), ORIGIN).signature });
  const opts = await loginOpts();
  const good = auth.assert(opts, ORIGIN);
  assert.equal((await post("/auth/passkey", { credential: good })).status, 200);
  await failsLogin(good); // replay
  await failsLogin(auth.assert(await loginOpts(), ORIGIN, { signCount: 1 })); // counter went back
  // A foreign page cannot even start a ceremony (the guard refuses its Origin).
  assert.equal((await post("/auth/passkey/options", {}, { origin: "https://evil.example" })).status, 403);
});

test("auth refusals answer with their status, { error, message } and, over a limit, retry-after (thrown, sendError)", async () => {
  const refusal = async (r: Response | Promise<Response>, status: number, error: string, message: string | RegExp) => {
    const res = await r;
    assert.equal(res.status, status);
    const body = (await res.json()) as { error: string; message: string };
    assert.deepEqual(Object.keys(body).sort(), ["error", "message"]);
    assert.equal(body.error, error);
    if (typeof message === "string") assert.equal(body.message, message);
    else assert.match(body.message, message);
    return res;
  };
  const owner = await asUser(ws.ownerId);
  const call = (path: string, method: string, headers: Record<string, string>) => fetch(url(path), { method, headers });
  await refusal(post("/auth/code", { email: "not an address" }), 400, "invalid", /email/);
  await refusal(fetch(url("/auth/me")), 401, "unauthorized", "sign in first");
  await refusal(fetch(url("/auth/me"), { headers: await asToken(ws.workspaceId, ws.ownerId) }), 403, "forbidden", "only a signed-in person can do this, not a token");
  await refusal(call("/auth/sessions/end-others", "POST", { cookie: owner.cookie! }), 403, "forbidden_origin", "a browser write needs an Origin header");
  const { sessions } = (await (await fetch(url("/auth/security"), { headers: owner })).json()) as AccountSecurity;
  await refusal(call(`/auth/sessions/${sessions.find((s) => s.current)!.id}`, "DELETE", owner), 400, "current_session", "this is the session in use: sign out instead");
  await refusal(call(`/auth/passkeys/${randomUUID()}`, "DELETE", owner), 404, "not_found", "no such passkey");
  await refusal(fetch(url("/auth/passkey/options"), { method: "POST" }), 400, "invalid", "passkeys need an Origin header");
  const login = (await (await post("/auth/passkey/options", {})).json()) as { challenge: string; rpId: string };
  await refusal(post("/auth/passkey", { credential: new SoftAuthenticator().assert(login, ORIGIN) }), 400, "passkey_failed", /./);
  await refusal(post("/auth/terminal", { code: "nope" }), 400, "invalid_code", "This code no longer works: show a new one in Settings › Security.");
  await refusal(post("/auth/terminal/code", {}, await agedSession(await asUser(ws.ownerId))), 403, "reauth_required", "Confirm it's you: sign in again to sign a terminal in.");
  // A limiter (http.ts, limit): 30 terminal codes per address, then 429. A server of its own: the count is per process.
  const own = await ownServer();
  for (let i = 0; i < 30; i++) assert.equal((await own.post("/auth/terminal", { code: "nope" })).status, 400);
  const over = await refusal(own.post("/auth/terminal", { code: "nope" }), 429, "rate_limited", "Too many attempts. Try again later.");
  assert.ok(Number(over.headers.get("retry-after")) > 0);
});

test("an open socket follows role changes: demoted to guest, its next transaction closes it", async () => {
  const m = await addMember(ws.workspaceId, "member");
  const { issue } = await issueWithRefs(ws.workspaceId);
  const c = await Client.open(server.url, await asUser(m.id));
  const closed = new Promise<number>((r) => c.ws.once("close", (code) => r(code)));
  await c.next((f) => f.t === "hello", 3000, true);
  c.send({ t: "sub", ws: ws.slug, s: 0 });
  await db.update(schema.member).set({ role: "guest" }).where(eq(schema.member.userId, m.id));
  forgetRoles();
  c.send({ t: "tx", id: randomUUID(), ops: [{ op: "update", m: "Issue", id: issue.id, set: { priority: 1 } }] });
  assert.equal(await closed, CLOSE_FORBIDDEN);
});

test("code guesses are limited per email across new codes", async () => {
  const m = await addMember(ws.workspaceId, "member");
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await post("/auth/verify", { email: m.email, code: "000000" })).status);
  assert.equal(statuses.at(-1), 429);
  assert.ok(statuses.slice(0, 10).every((s) => s === 400));
});

test("an https deployment accepts only the __Host- cookie: a sibling subdomain cannot plant rsva_sid", () => {
  assert.deepEqual(sessionCookieNames("https://plan.example.com"), ["__Host-rsva_sid"]);
  assert.deepEqual(sessionCookieNames("http://127.0.0.1:5173, https://rsva.localhost"), ["__Host-rsva_sid"]);
  assert.deepEqual(sessionCookieNames(undefined), ["__Host-rsva_sid", "rsva_sid"]);
});

test("codes go to the log only when asked, and never behind a proxy", () => {
  const log = () => {};
  assert.throws(() => mailerFromEnv({}, log), /no mailer/);
  assert.throws(() => mailerFromEnv({ RSVA_MAIL: "log", RSVA_TRUST_PROXY: "203.0.113.7" }, log), /proxy/);
  assert.throws(() => mailerFromEnv({ RSVA_MAIL: "log", HOST: "0.0.0.0" }, log), /loopback/);
  assert.equal(typeof mailerFromEnv({ RSVA_MAIL: "log" }, log), "function");
  assert.equal(typeof mailerFromEnv({ RSVA_MAIL: "log", HOST: "0.0.0.0", RSVA_ALLOW_LOG_MAIL: "1" }, log), "function");
  assert.throws(() => mailerFromEnv({ RESEND_API_KEY: "re_test" }, log), /RSVA_MAIL_FROM/);
});

test("a fixed dev code only on a loopback-only server without a proxy, mail key or not", () => {
  assert.equal(devCodeFromEnv({}), null);
  assert.equal(devCodeFromEnv({ RSVA_DEV_CODE: "000000" }), "000000");
  assert.equal(devCodeFromEnv({ RSVA_DEV_CODE: "000000", RESEND_API_KEY: "re_test" }), "000000");
  assert.throws(() => devCodeFromEnv({ RSVA_DEV_CODE: "0000" }), /six digits/);
  assert.throws(() => devCodeFromEnv({ RSVA_DEV_CODE: "000000", HOST: "0.0.0.0" }), /loopback/);
  assert.throws(() => devCodeFromEnv({ RSVA_DEV_CODE: "000000", RSVA_TRUST_PROXY: "203.0.113.7" }), /proxy/);
});

test("the sender's name is the product's on every server; the environment gives only the address", () => {
  assert.equal(senderFromEnv("plan@rsva.dev"), "recursiva <plan@rsva.dev>");
  for (const named of ["Plan <plan@rsva.dev>", "recursiva <plan@rsva.dev>", "<plan@rsva.dev>", "plan@rsva.dev, x@y.z", "plan"])
    assert.throws(() => senderFromEnv(named), /bare address/, named);
});

test("past the daily cap of wrong codes the code stops working, and the mail brings a one-time link instead", async () => {
  // Its own server: the per-IP and per-email limits count every call here (verify and link share them).
  const { url: base, post } = await ownServer();
  const m = await addMember(ws.workspaceId, "member");
  const stranger = `nobody-${randomUUID().slice(0, 8)}@example.test`;
  const fail = (email: string, n: number) => db.insert(schema.loginFailure).values(Array.from({ length: n }, () => ({ email })));
  const failures = async (email: string) => (await db.select().from(schema.loginFailure).where(eq(schema.loginFailure.email, email))).length;
  const answer = async (path: string, body: object) => {
    const r = await post(path, body);
    return [r.status, await r.text()];
  };
  /** The address's code row once it starts with `prefix`: the route answers before it writes, and an older row may be there. */
  const codeRow = async (email: string, prefix = "") => {
    for (let i = 0; i < 100; i++) {
      const [row] = await db.select().from(schema.loginCode).where(eq(schema.loginCode.email, email));
      if (row?.codeHash.startsWith(prefix)) return row;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no code row for ${email}`);
  };
  /** The secret and address of the next link mailed to this address. */
  const linkFor = async (email: string) => {
    for (let i = 0; i < 100; i++) {
      const mail = mails.findLast((x) => x.to === email && /sign-in link/.test(x.subject));
      if (mail) {
        mails.splice(mails.indexOf(mail), 1);
        const params = new URLSearchParams(/#(\S+)/.exec(mail.text)![1]!);
        return { secret: params.get("signin")!, email: params.get("email")! };
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no link to ${email}`);
  };
  await Promise.all([fail(m.email, DAILY_FAILURES - 1), fail(stranger, DAILY_FAILURES - 1)]);
  // Failures older than a day do not count.
  await db.insert(schema.loginFailure).values({ email: m.email, at: new Date(Date.now() - 86_400_000 - 1000).toISOString() });

  assert.equal((await post("/auth/code", { email: m.email })).status, 204);
  const code = await codeFor(m.email);
  const wrong = code === "000000" ? "111111" : "000000";
  assert.equal((await post("/auth/code", { email: stranger })).status, 204);
  await codeRow(stranger);
  // The last allowed wrong guess, then the right code is refused as a wrong one: for the member as for the decoy.
  assert.deepEqual(await answer("/auth/verify", { email: m.email, code: wrong }), await answer("/auth/verify", { email: stranger, code: wrong }));
  const refused = await answer("/auth/verify", { email: m.email, code });
  assert.deepEqual(refused, [400, JSON.stringify({ error: "invalid_code", message: "Wrong code." })]);
  assert.deepEqual(refused, await answer("/auth/verify", { email: stranger, code }));
  assert.equal(await failures(m.email), DAILY_FAILURES + 1, "nothing recorded past the cap");
  assert.equal(await failures(stranger), DAILY_FAILURES);

  // Past the cap the same 204, and the member's mail carries a link (in the fragment, never sent to a server).
  assert.equal((await post("/auth/code", { email: m.email })).status, 204);
  assert.equal((await post("/auth/code", { email: stranger })).status, 204);
  const link = await linkFor(m.email);
  assert.equal(link.email, m.email);
  assert.equal(mails.some((x) => x.to === stranger), false, "a decoy gets no mail");
  await codeRow(stranger, "L:"); // a decoy looks like a link row too
  // Codes are still refused, and do not void the link: the row is left alone past the cap.
  for (let i = 0; i < 2; i++) await post("/auth/verify", { email: m.email, code: wrong });
  // Someone else asking again does not replace the live link either.
  assert.equal((await post("/auth/code", { email: m.email })).status, 204);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mails.some((x) => x.to === m.email && /sign-in link/.test(x.subject)), false);

  // A wrong secret, another address, a code in its place: the same refusal.
  const bad = [400, JSON.stringify({ error: "invalid_link", message: "This sign-in link no longer works. Ask for a new one." })];
  assert.deepEqual(await answer("/auth/link", { email: m.email, secret: "A".repeat(43) }), bad);
  assert.deepEqual(await answer("/auth/link", { email: stranger, secret: link.secret }), bad);
  assert.equal((await post("/auth/link", { email: m.email, secret: code })).status, 400);
  // The link signs in once, like a right code.
  const ok = await post("/auth/link", link);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { user: { email: string } }).user.email, m.email);
  assert.equal((await fetch(url("/auth/me", base), { headers: { cookie: cookieOf(ok) } })).status, 200);
  assert.deepEqual(await answer("/auth/link", link), bad, "single use");

  // An expired link is refused, and a new one is sent after it.
  assert.equal((await post("/auth/code", { email: m.email })).status, 204);
  const late = await linkFor(m.email);
  await db.update(schema.loginCode).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.loginCode.email, m.email));
  assert.deepEqual(await answer("/auth/link", late), bad);
  assert.equal((await post("/auth/code", { email: m.email })).status, 204);
  assert.notEqual((await linkFor(m.email)).secret, late.secret);
});

test("a passkey is added only from a fresh sign-in, and the account gets a notice", async () => {
  const auth = new SoftAuthenticator();
  const { url: base, post } = await ownServer();
  const headers = await agedSession(await asUser(ws.ownerId));
  const stale = await post("/auth/passkeys/options", {}, headers);
  assert.equal(stale.status, 403);
  assert.equal(((await stale.json()) as { error: string }).error, "reauth_required");
  // Still signed in for everything else.
  assert.equal((await fetch(url("/auth/me", base), { headers })).status, 200);

  // A code sign-in is fresh: the same person adds the passkey, and a notice goes to their address.
  await post("/auth/code", { email: ownerEmail });
  const fresh = cookieOf(await post("/auth/verify", { email: ownerEmail, code: await codeFor(ownerEmail) }));
  const opts = (await (await post("/auth/passkeys/options", {}, { cookie: fresh })).json()) as { challenge: string; rp: { id: string }; user: { id: string } };
  const reg = await post("/auth/passkeys", { credential: auth.register(opts, ORIGIN), name: "Evil\nPhone https://x.example" }, { cookie: fresh });
  assert.equal(reg.status, 201);
  const notice = await mailFor(ownerEmail, (x) => /passkey was added/.test(x.subject) && /Evil/.test(x.text));
  assert.match(notice.text, /"Evil Phone https:\/\/x\.example"/);
  assert.match(notice.text, /If it was not/);
});

test("ten passkey ceremonies a person may start in an hour; one started under the limit still finishes and is mailed (RSVA-249)", async () => {
  const auth = new SoftAuthenticator();
  const m = await addMember(ws.workspaceId, "member");
  const me = await asUser(m.id);
  const opts = (await (await tenThenLimited(() => post("/auth/passkeys/options", {}, me))).json()) as { challenge: string; rp: { id: string }; user: { id: string } };

  // The finish is never limited: the change goes through and its owner hears of it, once.
  assert.equal((await post("/auth/passkeys", { credential: auth.register(opts, ORIGIN), name: "Late" }, me)).status, 201);
  await mailFor(m.email, (x) => /passkey was added/.test(x.subject));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mails.filter((x) => x.to === m.email).length, 0);
});

/** The browser's device cookie from a sign-in answer (devices.ts), as a Cookie header. */
const deviceOf = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith("rsva_device="))!.split(";", 1)[0]!;
/** A whole sign-in by a mailed code, with the browser's `headers`. */
async function codeSignIn(post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<Response>, email: string, headers: Record<string, string> = {}) {
  await post("/auth/code", { email });
  const r = await post("/auth/verify", { email, code: await codeFor(email) }, headers);
  assert.equal(r.status, 200);
  return r;
}
const isNewSignIn = (m: Mail) => /^New sign-in/.test(m.subject);
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

test("a sign-in from a browser the person had not signed in from mails the account; the first sign-in and a known browser do not", async () => {
  const own = await ownServer();
  const { email } = await addMember(ws.workspaceId, "member");
  const signIn = (headers?: Record<string, string>) => codeSignIn(own.post, email, headers);
  const quiet = () => assert.ok(!mails.some((m) => m.to === email && isNewSignIn(m)), "no new sign-in mail");

  // The first sign-in of an account: nothing to compare with. The browser keeps its token for 400 days, HttpOnly.
  const first = await signIn();
  quiet();
  const set = first.headers.getSetCookie().find((c) => c.startsWith("rsva_device="))!;
  assert.match(set, /HttpOnly/);
  assert.match(set, /Max-Age=34560000/);
  const browser = deviceOf(first);

  // Signing out keeps the device token: the same browser is known at its next sign-in.
  const out = await own.post("/auth/sign-out", {}, { cookie: cookieOf(first) });
  assert.ok(!out.headers.getSetCookie().some((c) => c.startsWith("rsva_device=")), "sign-out leaves the device token");
  assert.equal(deviceOf(await signIn({ cookie: browser })), browser, "the same token again");
  quiet();

  // Another browser: the account hears of it, with the browser, the way in and the address.
  const other = await signIn({ "user-agent": CHROME_MAC });
  assert.notEqual(deviceOf(other), browser);
  const notice = await mailFor(email, isNewSignIn);
  assert.match(notice.text, /Chrome on macOS, with an email code, from 127\.0\.0\.1/);
  assert.match(notice.text, /sign that session out in Settings › Security,/);
  assert.match(notice.html, /Security emails can’t be turned off/);

  // A token this person never signed in with is a new browser, whatever it looks like; a malformed one is replaced.
  await signIn({ cookie: `rsva_device=${"A".repeat(43)}` });
  await mailFor(email, isNewSignIn);
  assert.notEqual(deviceOf(await signIn({ cookie: "rsva_device=short" })), "rsva_device=short");
  await mailFor(email, isNewSignIn);
});

test("new sign-in mail: a browser is known per person, confirming it's you makes it known, 400 days unseen forget it", async () => {
  const own = await ownServer();
  const a = await addMember(ws.workspaceId, "member");
  const b = await addMember(ws.workspaceId, "member");
  const signIn = (email: string, headers?: Record<string, string>) => codeSignIn(own.post, email, headers);
  // b signed in somewhere before (a session from the CLI), then confirms it's there: same browser, no device token yet.
  const old = await asUser(b.id);
  const confirmed = await signIn(b.email, old);
  assert.ok(!mails.some((m) => m.to === b.email && isNewSignIn(m)), "the browser was b's already");
  const shared = deviceOf(confirmed);
  await own.post("/auth/sign-out", {}, { cookie: cookieOf(confirmed) });
  await signIn(b.email, { cookie: shared });
  assert.ok(!mails.some((m) => m.to === b.email && isNewSignIn(m)), "and is known from then on");
  // Until it is unseen for 400 days.
  const id = sha256(shared.split("=")[1]!);
  await db.update(schema.signInDevice).set({ lastSeenAt: new Date(Date.now() - 401 * 86_400_000).toISOString() }).where(eq(schema.signInDevice.id, id));
  await sweepDevices();
  await signIn(b.email, { cookie: shared });
  await mailFor(b.email, isNewSignIn);

  // a, who has signed in elsewhere before, signs in on b's browser: new for a.
  await signIn(a.email);
  await signIn(a.email, { cookie: shared });
  await mailFor(a.email, isNewSignIn);
});

test("new sign-in mail: a person who signed in before and has no session left still hears of a new browser", async () => {
  const own = await ownServer();
  // As migration 0030 leaves everyone who existed before it, or a person whose sessions all ended.
  const { id, email } = await addMember(ws.workspaceId, "member");
  await db.insert(schema.signInDevice).values({ userId: id, id: SIGNED_IN_BEFORE });
  await codeSignIn(own.post, email);
  const notice = await mailFor(email, isNewSignIn);
  // A new browser's code went by email alone (RSVA-464): the mail says to secure the mailbox, not Telegram.
  assert.match(notice.text, /got the sign-in code from this address/);
  assert.doesNotMatch(notice.text, /Telegram/);
  // The sweep forgets every browser of theirs unseen for 400 days, the same moment or not, but keeps that they signed in.
  await db.update(schema.signInDevice).set({ lastSeenAt: new Date(Date.now() - 900 * 86_400_000).toISOString() }).where(eq(schema.signInDevice.userId, id));
  await sweepDevices();
  assert.deepEqual((await db.select({ id: schema.signInDevice.id }).from(schema.signInDevice).where(eq(schema.signInDevice.userId, id))).map((r) => r.id), [SIGNED_IN_BEFORE]);
});

test("/auth/me tells whether the person may create workspaces (RSVA_WORKSPACE_CREATORS)", async () => {
  const before = process.env.RSVA_WORKSPACE_CREATORS;
  const may = async () => ((await (await fetch(url("/auth/me"), { headers: await asUser(ws.ownerId) })).json()) as { mayCreateWorkspaces: boolean }).mayCreateWorkspaces;
  try {
    delete process.env.RSVA_WORKSPACE_CREATORS;
    assert.equal(await may(), false);
    process.env.RSVA_WORKSPACE_CREATORS = ` someone@else.test , ${ownerEmail.toUpperCase()} `;
    assert.equal(await may(), true);
    process.env.RSVA_WORKSPACE_CREATORS = "";
    assert.equal(await may(), false);
  } finally {
    if (before === undefined) delete process.env.RSVA_WORKSPACE_CREATORS;
    else process.env.RSVA_WORKSPACE_CREATORS = before;
  }
});
