import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { guardConfig } from "./guard.ts";
import { fetchAs, mailbox, ORIGIN, slug, startServer } from "./test/helpers.ts";
import { admit, listWaitlist } from "./waitlist.ts";

const { waitlist } = schema;
const LANDING = "https://rsva.dev";
const json = { "content-type": "application/json" };

let server: Awaited<ReturnType<typeof startServer>>;
const { mailer, mailTo } = mailbox();
before(async () => {
  server = await startServer({ mailer, guard: guardConfig({ RSVA_WAITLIST_ORIGINS: LANDING }) });
});
after(() => server.close());

const address = (name = "person") => `${name}-${randomUUID().slice(0, 8)}@example.test`;
const ask = (body: unknown, origin = LANDING) => fetch(`${server.url}/api/waitlist`, { method: "POST", headers: { ...json, origin }, body: JSON.stringify(body) });
const post = (headers: Record<string, string>, path: string, body?: unknown) =>
  fetchAs(headers)(`${server.url}${path}`, { method: "POST", headers: json, body: JSON.stringify(body ?? {}) });
const entry = async (email: string) => (await db.select().from(waitlist).where(eq(waitlist.email, email.toLowerCase())))[0];


test("the landing puts an address on the list; asking again changes nothing and answers the same", async () => {
  const email = address("Ann");
  const r = await ask({ email: email.toUpperCase(), note: "  We build\nboats‮,  in  Turku " });
  assert.equal(r.status, 204);
  // Only the landing's page may read the answer.
  assert.equal(r.headers.get("access-control-allow-origin"), LANDING);
  const row = await entry(email);
  assert.equal(row?.email, email.toLowerCase());
  assert.equal(row?.note, "We build boats , in Turku", "one line, no control or format characters");
  assert.equal(row?.admittedAt, null);

  const again = await ask({ email, note: "something else" });
  assert.equal(again.status, 204, "nobody learns who is on the list");
  assert.equal((await entry(email))?.note, "We build boats , in Turku");

  assert.equal((await ask({ email: "not an address" })).status, 400);
  assert.equal((await ask({ email, note: "x".repeat(1000) })).status, 400);
});

test("only the landing's origin reaches the list, and only the list", async () => {
  const pre = await fetch(`${server.url}/api/waitlist`, { method: "OPTIONS", headers: { origin: LANDING, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), LANDING);
  assert.equal(pre.headers.get("access-control-allow-methods"), "POST");

  assert.equal((await ask({ email: address() }, "https://elsewhere.example")).status, 403);
  // The landing's origin is nobody to the rest of the API.
  assert.equal((await post({ origin: LANDING }, "/auth/code", { email: address() })).status, 403);
});

test("a let-in address signs in with a code, creates one workspace, and stays a member", async () => {
  // Stored as the list stores it: lower-cased.
  const email = address("bo");
  await db.insert(waitlist).values({ email });
  const waiting = await listWaitlist();
  assert.ok(waiting.some((e) => e.email === email));

  assert.deepEqual(await admit({ emails: [email.toUpperCase()] }, mailer, "https://app.example"), [email]);
  const welcome = await mailTo(email);
  assert.match(welcome.subject, /You're in/);
  assert.match(welcome.text, /https:\/\/app\.example/);
  assert.deepEqual(await admit({ emails: [email] }, mailer, "https://app.example"), [], "let in once, mailed once");

  assert.equal((await post({ origin: ORIGIN }, "/auth/code", { email })).status, 204);
  const code = /(\d{6})/.exec((await mailTo(email)).text)![1]!;
  const signed = await post({ origin: ORIGIN }, "/auth/verify", { email, code });
  assert.equal(signed.status, 200);
  assert.equal(((await signed.json()) as { mayCreateWorkspaces: boolean }).mayCreateWorkspaces, true);
  const cookie = signed.headers.getSetCookie().find((c) => c.startsWith("rsva_sid="))!.split(";")[0]!;
  const me = { cookie, origin: ORIGIN };

  const make = (s: string) => post(me, "/api/v1/workspaces", { name: "Boats", slug: s, color: null, projects: [{ key: "BOAT", name: "Boats" }] });
  // Two at once: the entry is used up once, so one workspace is made.
  const [a, b] = await Promise.all([make(slug("boats")), make(slug("boats"))]);
  assert.deepEqual([a.status, b.status].toSorted(), [201, 403]);
  assert.notEqual((await entry(email))?.usedAt, null);

  // Used up, the entry lets in no more; the workspace keeps the person signed in.
  const now = (await (await fetchAs(me)(`${server.url}/auth/me`)).json()) as { mayCreateWorkspaces: boolean };
  assert.equal(now.mayCreateWorkspaces, false);
  assert.equal((await make(slug("more"))).status, 403);
});

test("admit --next lets in who waited longest, and nobody twice", async () => {
  const [first, second, third] = [address("first"), address("second"), address("third")];
  for (const [i, email] of [first, second, third].entries())
    await db.insert(waitlist).values({ email, createdAt: new Date(Date.UTC(2020, 0, 1 + i)).toISOString() });
  const let1 = await admit({ next: 2 }, mailer, "https://app.example");
  assert.deepEqual(let1, [first, second].toSorted());
  const let2 = await admit({ next: 2 }, mailer, "https://app.example");
  assert.ok(let2.includes(third) && !let2.includes(first) && !let2.includes(second));
});

// Last: it uses up the limit per IP of every test above.
test("past its limits the list answers 429", async () => {
  let status = 204;
  for (let i = 0; i < 20 && status !== 429; i++) status = (await ask({ email: address("flood") })).status;
  assert.equal(status, 429);
});
