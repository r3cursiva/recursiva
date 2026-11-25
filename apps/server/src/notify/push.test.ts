import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { type NotifySettingsView, type PushView } from "@rsva/protocol";
import { ISSUE_KEY } from "@rsva/schema/models";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { forgetSessions } from "../auth/sessions.ts";
import { asUser, fetchAs, startServer } from "../test/helpers.ts";
import { follow } from "./follow.ts";
import { notifyFixture, quietAround } from "./fixture.ts";
import { sendPushDue } from "./push.ts";
import type { PushApi, PushTarget } from "./web-push.ts";

const { notifyOutbox, pushDevice, session } = schema;
const ORIGIN = "https://plan.example.test";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1";

/** A push service that keeps what it is given and answers `status` (an endpoint's own answer first). */
function fakePush() {
  const pushed: { to: PushTarget; payload: { title: string; body: string; url: string; tag: string } }[] = [];
  const answers = new Map<string, number>();
  const api: PushApi = {
    publicKey: "BPublicKeyOfTheTestServer",
    async send(to, payload) {
      pushed.push({ to, payload: JSON.parse(payload) });
      return answers.get(to.endpoint) ?? 201;
    },
  };
  return { api, pushed, answers };
}

const { api, pushed, answers } = fakePush();
const { f, tx, newIssue, person } = notifyFixture();
let server: Awaited<ReturnType<typeof startServer>>;
let bare: Awaited<ReturnType<typeof startServer>>;
before(async () => void ([server, bare] = await Promise.all([startServer({ push: api }), startServer({ push: null })])));
after(() => Promise.all([server.close(), bare.close()]));

/** What a browser's PushSubscription.toJSON() gives, at Apple's push service. */
const subscription = (host = "web.push.apple.com") => ({
  endpoint: `https://${host}/${randomBytes(24).toString("base64url")}`,
  keys: { p256dh: Buffer.concat([Buffer.of(4), randomBytes(64)]).toString("base64url"), auth: randomBytes(16).toString("base64url") },
  expirationTime: null,
});

/** A person with push on one iPhone, and their browser's fetch. */
async function subscribed(prefs: Parameters<typeof person>[0] = {}) {
  const me = await person(prefs);
  const headers = await asUser(me.id);
  const as = fetchAs({ ...headers, "user-agent": IPHONE });
  const sub = subscription();
  const res = await as(`${server.url}/auth/push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) });
  assert.equal(res.status, 200);
  return { me, as, headers, sub, view: (await res.json()) as PushView };
}

/** The person is assigned a fresh issue, and the notifier of a server with push passes over it. */
async function assign(userId: string) {
  const id = await newIssue(f.ws.ownerId);
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [userId] } }]);
  const now = new Date();
  await follow(f.ws.workspaceId, now, false, true);
  return { id, now };
}

const pushRow = async (userId: string, issueId: string) =>
  (await db.select().from(notifyOutbox).where(and(eq(notifyOutbox.userId, userId), eq(notifyOutbox.issueId, issueId), eq(notifyOutbox.channel, "push"))))[0];

test("turning push on keeps the device, named after its browser, and the settings list it with the key", async () => {
  const { as, sub, view } = await subscribed();
  assert.equal(view.key, api.publicKey);
  assert.deepEqual(
    view.devices.map((d) => [d.name, d.endpoint]),
    [["Safari on iOS", sub.endpoint]],
  );
  const settings = (await (await as(`${server.url}/auth/notifications`)).json()) as NotifySettingsView;
  assert.deepEqual(settings.push, view);
});

test("only a push service's address is taken: the server posts to it", async () => {
  const me = await person({});
  const as = fetchAs(await asUser(me.id));
  for (const sub of [subscription("evil.example.test"), subscription("127.0.0.1"), { ...subscription(), endpoint: "http://web.push.apple.com/x" }, { ...subscription(), keys: { p256dh: "AAAA", auth: "AAAA" } }]) {
    const res = await as(`${server.url}/auth/push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) });
    assert.equal(res.status, 400, sub.endpoint);
  }
  assert.deepEqual(await db.select().from(pushDevice).where(eq(pushDevice.userId, me.id)), []);
});

test("a server without VAPID keys offers no push", async () => {
  const me = await person({});
  const as = fetchAs(await asUser(me.id));
  assert.deepEqual(((await (await as(`${bare.url}/auth/notifications`)).json()) as NotifySettingsView).push, { key: null, devices: [] });
  const res = await as(`${bare.url}/auth/push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(subscription()) });
  assert.equal(res.status, 404);
});

test("what the rules push goes to the device: what happened, the issue, and a link to it", async () => {
  const { me, sub } = await subscribed({ rules: { assigned: { push: "now" } } });
  const { id, now } = await assign(me.id);
  await sendPushDue(api, ORIGIN, now, f.ws.workspaceId);
  const got = pushed.filter((p) => p.to.endpoint === sub.endpoint);
  assert.equal(got.length, 1);
  assert.match(got[0]!.payload.title, new RegExp(`^Owner assigned ${ISSUE_KEY} to you$`));
  assert.equal(got[0]!.payload.body, "Rotate the edge nodes");
  assert.match(got[0]!.payload.url, new RegExp(`^https://plan\\.example\\.test/.+/browse/${ISSUE_KEY}$`));
  assert.equal(got[0]!.payload.tag, id);
  assert.equal((await pushRow(me.id, id))!.status, "sent");
  const [d] = await db.select().from(pushDevice).where(eq(pushDevice.endpoint, sub.endpoint));
  assert.ok(d!.sentAt);
});

test("a cell left Off pushes nothing, and a server that does not push writes no push rows", async () => {
  const { me } = await subscribed({ rules: { assigned: { push: "off" } } });
  const { id } = await assign(me.id);
  assert.equal(await pushRow(me.id, id), undefined);
  const { me: other } = await subscribed({ rules: { assigned: { push: "now" } } });
  const issue = await newIssue(f.ws.ownerId);
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id: issue, set: { assigneeIds: [other.id] } }]);
  await follow(f.ws.workspaceId, new Date());
  assert.equal(await pushRow(other.id, issue), undefined);
});

test("in quiet hours a push waits for their end", async () => {
  const now = new Date();
  const { me } = await subscribed({ rules: { assigned: { push: "now" } }, quiet: quietAround(now), urgent: true });
  const { id } = await assign(me.id);
  const row = await pushRow(me.id, id);
  assert.ok(Date.parse(row!.dueAt) > now.getTime() + 60 * 60_000);
});

test("a device its push service forgot (410) is removed, and the row with no device left is dropped", async () => {
  const { me, sub } = await subscribed({ rules: { assigned: { push: "now" } } });
  answers.set(sub.endpoint, 410);
  const { id, now } = await assign(me.id);
  await sendPushDue(api, ORIGIN, now, f.ws.workspaceId);
  assert.deepEqual(await db.select().from(pushDevice).where(eq(pushDevice.userId, me.id)), []);
  assert.equal((await pushRow(me.id, id))!.status, "dropped");
});

test("a push service that refuses for now leaves the row to try again", async () => {
  const { me, sub } = await subscribed({ rules: { assigned: { push: "now" } } });
  answers.set(sub.endpoint, 503);
  const { id, now } = await assign(me.id);
  await sendPushDue(api, ORIGIN, now, f.ws.workspaceId);
  const row = await pushRow(me.id, id);
  assert.equal(row!.status, "pending");
  assert.ok(Date.parse(row!.dueAt) > now.getTime());
  assert.equal((await db.select().from(pushDevice).where(eq(pushDevice.userId, me.id))).length, 1);
});

test("signing out ends the device's pushes with its session", async () => {
  const { me, headers } = await subscribed();
  const res = await fetchAs(headers)(`${server.url}/auth/sign-out`, { method: "POST" });
  assert.equal(res.status < 400, true, `logout: ${res.status}`);
  forgetSessions();
  assert.deepEqual(await db.select().from(pushDevice).where(eq(pushDevice.userId, me.id)), []);
  assert.deepEqual(await db.select().from(session).where(eq(session.userId, me.id)), []);
});

test("the same browser subscribing in another sign-in moves the device to it", async () => {
  const { sub } = await subscribed();
  const other = await person({});
  const as = fetchAs({ ...(await asUser(other.id)), "user-agent": IPHONE });
  const view = (await (await as(`${server.url}/auth/push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) })).json()) as PushView;
  assert.deepEqual(
    view.devices.map((d) => d.endpoint),
    [sub.endpoint],
  );
  const rows = await db.select().from(pushDevice).where(eq(pushDevice.endpoint, sub.endpoint));
  assert.deepEqual(
    rows.map((r) => r.userId),
    [other.id],
  );
});

test("Send a test reaches the device; Remove deletes it; another person's device is neither", async () => {
  const { as, sub, view } = await subscribed();
  const id = view.devices[0]!.id;
  const test = (await (await as(`${server.url}/auth/push/${id}/test`, { method: "POST" })).json()) as { sent: boolean };
  assert.equal(test.sent, true);
  assert.equal(pushed.filter((p) => p.to.endpoint === sub.endpoint).at(-1)!.payload.title, "Push works");
  const stranger = fetchAs(await asUser((await person({})).id));
  assert.equal((await stranger(`${server.url}/auth/push/${id}/test`, { method: "POST" })).status, 404);
  await stranger(`${server.url}/auth/push/${id}`, { method: "DELETE" });
  assert.equal((await db.select().from(pushDevice).where(eq(pushDevice.id, id))).length, 1);
  const after = (await (await as(`${server.url}/auth/push/${id}`, { method: "DELETE" })).json()) as PushView;
  assert.deepEqual(after.devices, []);
  assert.equal((await as(`${server.url}/auth/push/${randomUUID()}/test`, { method: "POST" })).status, 404);
});
