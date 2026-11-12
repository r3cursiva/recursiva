import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { DeltaFrame, TerminalCode } from "@rsva/protocol";
import { and, eq, isNull } from "drizzle-orm";
import postgres from "postgres";
import { db, schema } from "../db.ts";
import { addMember, agedSession, asToken, asUser, Client, delay, fetchAs, importFixture, startServer, type Fixture } from "../test/helpers.ts";
import type { Mail } from "./mail.ts";
import { sha256 } from "./secret.ts";
import { setTokenGrants } from "./tokens.ts";

const { invite, user } = schema;

const mails: Mail[] = [];
let server: Awaited<ReturnType<typeof startServer>>;
let a: Fixture;
let b: Fixture;
before(async () => {
  [server, a, b] = await Promise.all([startServer({ mailer: async (m) => void mails.push(m) }), importFixture(), importFixture()]);
});
after(() => server.close());

const post = (headers: Record<string, string>, path: string, body: unknown) =>
  fetchAs(headers)(`${server.url}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1" }, body: JSON.stringify(body) });
const error = async (r: Response) => ((await r.json()) as { error: string }).error;
const newAddress = () => `new-${randomUUID().slice(0, 8)}@example.test`;

/** The mail to this address whose subject matches, waiting for it: mail goes out after the answer. */
async function mailTo(to: string, subject: RegExp): Promise<Mail> {
  for (let i = 0; i < 100; i++) {
    const m = mails.findLast((x) => x.to === to && subject.test(x.subject));
    if (m) return m;
    await delay(20);
  }
  throw new Error(`no mail to ${to} matching ${subject}`);
}
const codeIn = (m: Mail) => /code: (\d{6})/.exec(m.text)![1]!;
const revertIn = (m: Mail) => new URLSearchParams(/#(email-revert=[^\s]+)/.exec(m.text)![1]!).get("email-revert")!;

/** A member of both workspaces, signed in just now. */
async function person() {
  const p = await addMember(a.workspaceId, "member");
  await db.insert(schema.member).values({ workspaceId: b.workspaceId, userId: p.id, role: "member" });
  return { ...p, headers: await asUser(p.id) };
}

async function emailOf(id: string): Promise<string> {
  return (await db.select({ email: user.email }).from(user).where(eq(user.id, id)))[0]!.email;
}

/** Asks for the change and types the code; returns the mail to the old address. */
async function change(p: { email: string; headers: Record<string, string> }, to: string): Promise<Mail> {
  assert.equal((await post(p.headers, "/auth/email", { email: to })).status, 204);
  const r = await post(p.headers, "/auth/email/confirm", { code: codeIn(await mailTo(to.toLowerCase(), /confirms your new recursiva email/)) });
  assert.equal(r.status, 200);
  return mailTo(p.email, /email was changed$/);
}

test("only a fresh session asks for a change; a token, a stale session and the same address are refused", async () => {
  const p = await person();
  assert.equal((await post(await asToken(a.workspaceId, p.id), "/auth/email", { email: newAddress() })).status, 403);
  assert.equal((await post({}, "/auth/email", { email: newAddress() })).status, 401);
  assert.equal(await error(await post(p.headers, "/auth/email", { email: ` ${p.email.toUpperCase()} ` })), "same_email");
  const stale = await post(await agedSession(p.headers), "/auth/email", { email: newAddress() });
  assert.equal(stale.status, 403);
  assert.equal(await error(stale), "reauth_required");
});

test("the code to the new address changes it in every workspace, live, and the old one hears of it", async () => {
  const p = await person();
  const to = newAddress();
  const [ca, cb] = await Promise.all([(await Client.open(server.url, await asUser(a.ownerId))).subscribe(a), (await Client.open(server.url, await asUser(b.ownerId))).subscribe(b)]);
  const changed = (f: { t: string }) => f.t === "d" && (f as DeltaFrame).a.some((x) => x.m === "User" && x.mid === p.id && x.d?.email === to);
  const seen = [ca.next(changed), cb.next(changed)];

  assert.equal((await post(p.headers, "/auth/email", { email: to.toUpperCase() })).status, 204);
  const code = codeIn(await mailTo(to, /confirms your new recursiva email/));
  assert.equal(await error(await post(p.headers, "/auth/email/confirm", { code: code === "000000" ? "000001" : "000000" })), "invalid_code");
  assert.equal(await emailOf(p.id), p.email);

  const r = await post(p.headers, "/auth/email/confirm", { code });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { user: { email: string } }).user.email, to);
  await Promise.all(seen);
  assert.equal(await emailOf(p.id), to);
  const notice = await mailTo(p.email, /email was changed$/);
  assert.match(notice.text, new RegExp(`to ${to}`));
  assert.match(revertIn(notice), /^[A-Za-z0-9_-]{43}$/);
  // The code is used up, and the session that made the change goes on.
  assert.equal(await error(await post(p.headers, "/auth/email/confirm", { code })), "expired_code");
  assert.equal((await fetchAs(p.headers)(`${server.url}/auth/me`)).status, 200);
  ca.close();
  cb.close();
});

test("an address with an account gets a notice instead of a code, and the answer is the same", async () => {
  const p = await person();
  const other = await addMember(a.workspaceId, "member");
  const r = await post(p.headers, "/auth/email", { email: other.email });
  assert.equal(r.status, 204);
  const notice = await mailTo(other.email, /was not changed/);
  assert.doesNotMatch(notice.text, /\d{6}/);
  assert.doesNotMatch(notice.text, new RegExp(p.email));
  for (const code of ["000000", "123456"]) assert.equal(await error(await post(p.headers, "/auth/email/confirm", { code })), "invalid_code");
  assert.equal(await emailOf(p.id), p.email);
});

test("five wrong codes end the change", async () => {
  const p = await person();
  const to = newAddress();
  await post(p.headers, "/auth/email", { email: to });
  const code = codeIn(await mailTo(to, /confirms/));
  const wrong = code === "000000" ? "000001" : "000000";
  for (let i = 0; i < 5; i++) assert.equal(await error(await post(p.headers, "/auth/email/confirm", { code: wrong })), "invalid_code");
  assert.equal(await error(await post(p.headers, "/auth/email/confirm", { code })), "expired_code");
  assert.equal(await emailOf(p.id), p.email);
});

test("open invites move to the new address; one the new address has already stays", async () => {
  const p = await addMember(a.workspaceId, "member");
  const headers = await asUser(p.id);
  const to = newAddress();
  const third = await importFixture();
  const row = (workspaceId: string, email: string) => ({ workspaceId, email, role: "member", hash: randomUUID(), invitedById: a.ownerId, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  await db.insert(invite).values([row(b.workspaceId, p.email), row(third.workspaceId, p.email), row(third.workspaceId, to)]);

  await change({ email: p.email, headers }, to);
  const open = await db.select({ ws: invite.workspaceId, email: invite.email }).from(invite).where(and(eq(invite.email, to), isNull(invite.revokedAt), isNull(invite.acceptedAt)));
  assert.deepEqual(open.map((i) => i.ws).sort(), [b.workspaceId, third.workspaceId].sort());
  const left = await db.select({ id: invite.id }).from(invite).where(and(eq(invite.email, p.email), isNull(invite.revokedAt)));
  assert.equal(left.length, 0);
});

test("the link back restores the old address, ends every session, and voids later links", async () => {
  const p = await person();
  const mid = newAddress();
  const last = newAddress();
  const first = revertIn(await change(p, mid));
  // A second change: its link goes to `mid`.
  const second = revertIn(await change({ email: mid, headers: p.headers }, last));
  const elsewhere = await asUser(p.id);
  // A terminal code the thief keeps unused: no session left to show it, so it no longer works (RSVA-598).
  const { code } = (await (await post(p.headers, "/auth/terminal/code", {})).json()) as TerminalCode;

  const r = await post({}, "/auth/email/revert", { secret: first });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { email: p.email, removed: { passkeys: 0, tokens: 0, telegram: 0 } });
  assert.equal(await emailOf(p.id), p.email);
  for (const h of [p.headers, elsewhere]) assert.equal((await fetchAs(h)(`${server.url}/auth/me`)).status, 401);
  assert.equal(await error(await post({}, "/auth/terminal", { code })), "invalid_code");
  await mailTo(last, /changed back/);

  assert.equal(await error(await post({}, "/auth/email/revert", { secret: first })), "invalid_link");
  assert.equal(await error(await post({}, "/auth/email/revert", { secret: second })), "invalid_link");
  assert.equal(await error(await post({}, "/auth/email/revert", { secret: "x".repeat(43) })), "invalid_link");
});

test("a link back to an address that has another account now is refused and keeps working", async () => {
  const p = await person();
  const to = newAddress();
  const secret = revertIn(await change(p, to));
  const [squatter] = await db.insert(user).values({ email: p.email.toUpperCase(), name: "x" }).returning({ id: user.id });
  assert.equal(await error(await post({}, "/auth/email/revert", { secret })), "email_taken");
  assert.equal(await emailOf(p.id), to);
  await db.delete(user).where(eq(user.id, squatter!.id));
  assert.equal((await post({}, "/auth/email/revert", { secret })).status, 200);
});

test("a later link used first does not void an earlier one: whoever changed the address twice cannot lock its owner out", async () => {
  const p = await person();
  const stolen = newAddress();
  const again = newAddress();
  const owners = revertIn(await change(p, stolen));
  const thiefs = revertIn(await change({ email: stolen, headers: await asUser(p.id) }, again));

  assert.equal((await post({}, "/auth/email/revert", { secret: thiefs })).status, 200);
  assert.equal(await emailOf(p.id), stolen);
  const r = await post({}, "/auth/email/revert", { secret: owners });
  assert.equal(r.status, 200);
  assert.equal(await emailOf(p.id), p.email);
});

test("the link back removes the passkeys, tokens and Telegram links made or widened since the change's sign-in, and keeps older ones", async () => {
  const p = await person();
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const key = (id: string, createdAt: string) => ({ id, userId: p.id, publicKey: "x", algorithm: -7, name: id, createdAt });
  const [oldKey, newKey] = [randomUUID(), randomUUID()];
  await db.insert(schema.passkey).values([key(oldKey, ago(60)), key(newKey, ago(1))]);
  const oldToken = await asToken(a.workspaceId, p.id);
  await db.update(schema.apiToken).set({ createdAt: ago(60) }).where(eq(schema.apiToken.userId, p.id));

  // An agent's tokens made an hour ago by someone else: one the person widened an hour ago, one they widen after the change.
  const agentToken = async (grantedAt: string) => {
    const t = await asToken(a.workspaceId, a.agentId);
    await db.update(schema.apiToken).set({ createdAt: ago(60), scope: "custom", grants: ["issues.write"], grantedById: p.id, grantedAt }).where(eq(schema.apiToken.hash, sha256(t.authorization!.slice(7))));
    return t;
  };
  const keptAgent = await agentToken(ago(60));

  const secret = revertIn(await change(p, newAddress()));
  const newToken = await asToken(a.workspaceId, p.id);
  const widened = await agentToken(new Date().toISOString());
  // Read to write is a widening too: whoever changed the access is recorded whatever the scope.
  const readOne = await asToken(a.workspaceId, a.agentId, "read");
  const readHash = sha256(readOne.authorization!.slice(7));
  await db.update(schema.apiToken).set({ createdAt: ago(60) }).where(eq(schema.apiToken.hash, readHash));
  const [row] = await db.select({ id: schema.apiToken.id }).from(schema.apiToken).where(eq(schema.apiToken.hash, readHash));
  assert.ok(await setTokenGrants(a.workspaceId, row!.id, "write", [], p.id));
  const issues = (h: Record<string, string>) => fetchAs(h)(`${server.url}/api/v1/workspaces/${a.slug}/issues?limit=1`);
  assert.equal((await issues(newToken)).status, 200);
  // Linked an hour ago: the personal chat, where sign-in codes go, goes whenever it was linked.
  await db.insert(schema.telegramChat).values({ userId: p.id, chatId: 42, name: "x", linkedAt: ago(60) });

  const r = await post({}, "/auth/email/revert", { secret });
  assert.deepEqual(((await r.json()) as { removed: unknown }).removed, { passkeys: 1, tokens: 3, telegram: 1 });
  const keys = await db.select({ id: schema.passkey.id }).from(schema.passkey).where(eq(schema.passkey.userId, p.id));
  assert.deepEqual(keys.map((k) => k.id), [oldKey]);
  assert.equal((await issues(newToken)).status, 401);
  assert.equal((await issues(oldToken)).status, 200);
  assert.equal((await issues(widened)).status, 401, "widened since the change: the change's grants go with it");
  assert.equal((await issues(readOne)).status, 401, "turned from read to write since the change");
  assert.equal((await issues(keptAgent)).status, 200);
  assert.equal((await db.select().from(schema.telegramChat).where(eq(schema.telegramChat.userId, p.id))).length, 0);
});

test("a code confirmed while the owner takes the address back changes nothing", async () => {
  const p = await person();
  const [stolen, next] = [newAddress(), newAddress()];
  const secret = revertIn(await change(p, stolen));
  assert.equal((await post(p.headers, "/auth/email", { email: next })).status, 204);
  const code = codeIn(await mailTo(next, /confirms/));

  // The person's row held from another connection: the link back takes it first, the code waits behind it.
  const lock = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await lock.unsafe("begin");
  await lock`select 1 from "user" where id = ${p.id} for update`;
  const back = post({}, "/auth/email/revert", { secret });
  await delay(200);
  const confirmed = post(p.headers, "/auth/email/confirm", { code });
  await delay(200);
  await lock.unsafe("commit");
  await lock.end();
  assert.equal((await back).status, 200);
  assert.notEqual((await confirmed).status, 200);
  assert.equal(await emailOf(p.id), p.email);
});
