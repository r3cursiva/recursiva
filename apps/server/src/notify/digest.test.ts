import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { NOTIFY_DEFAULTS, type NotifyPrefs } from "@rsva/protocol";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { writeMarks } from "../sync/inbox.ts";
import { addMember } from "../test/helpers.ts";
import { sendDigests } from "./digest.ts";
import { follow } from "./follow.ts";
import { collect, notifyFixture } from "./fixture.ts";
import { sendDue } from "./send.ts";

const { notifyOutbox, accountSettings } = schema;
const ORIGIN = "https://plan.example.test";
const log = { error: (e: unknown) => assert.fail(String(e)) };

const { f, tx, newIssue, person, newCycle } = notifyFixture();

test("bundled, two notifications go on the half hour as one mail; text only has no HTML; every mail can unsubscribe", async () => {
  const me = await person({ email: { bundle: true, textOnly: true, reply: true } });
  const [a, b] = [await newIssue(f.ws.ownerId), await newIssue(f.ws.ownerId)];
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id: a, set: { assigneeIds: [me.id] } }]);
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id: b, set: { assigneeIds: [me.id] } }]);
  const now = new Date("2026-11-02T10:07:00Z");
  await follow(f.ws.workspaceId, now);
  const rows = await db.select().from(notifyOutbox).where(eq(notifyOutbox.userId, me.id));
  assert.deepEqual(rows.map((r) => r.dueAt.slice(0, 16)), ["2026-11-02 10:30", "2026-11-02 10:30"]);
  const { mails, mailer } = collect();
  await sendDue(mailer, ORIGIN, new Date("2026-11-02T10:30:00Z"), f.ws.workspaceId);
  const mine = mails.filter((m) => m.to === me.email);
  assert.equal(mine.length, 1);
  assert.match(mine[0]!.subject, /^2 updates on 2 issues/);
  assert.equal(mine[0]!.html, "");
  assert.match(mine[0]!.headers!["List-Unsubscribe"]!, new RegExp(`^<${ORIGIN}/notify/unsubscribe\\?u=${me.id}&k=`));
  assert.equal(mine[0]!.headers!["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

  // The link: a page with a button, then a one-click POST turns every email off; a wrong key changes nothing. A mail
  // client posts multipart or urlencoded; the page's form posts with the page's Origin.
  const link = mine[0]!.headers!["List-Unsubscribe"]!.slice(1, -1).replace(ORIGIN, f.server.url);
  assert.equal((await fetch(link)).status, 200);
  assert.equal((await fetch(link.replace(/k=[^&]+/, "k=nope"), { method: "POST" })).status, 404);
  const form = new FormData();
  form.set("List-Unsubscribe", "One-Click");
  assert.equal((await fetch(link, { method: "POST", body: form })).status, 200);
  const r = await fetch(link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: f.server.url }, body: "List-Unsubscribe=One-Click" });
  assert.equal(r.status, 200);
  const [s] = await db.select({ n: accountSettings.notifications }).from(accountSettings).where(eq(accountSettings.userId, me.id));
  const p = s!.n as NotifyPrefs;
  assert.equal(p.rules.assigned?.email, "off");
  assert.equal(p.digest.on, false);
});

test("the morning digest: what waits on you, what is due today and what went to the digest; once a day; empty skipped", async () => {
  const me = await person({ digest: { on: true, time: "08:00", days: [0, 1, 2, 3, 4, 5, 6], skipEmpty: true } });
  const quiet = await person({ digest: { on: true, time: "08:00", days: [0, 1, 2, 3, 4, 5, 6], skipEmpty: true } });
  const review = await newIssue(me.id);
  const started = f.refs.states.filter((s) => s.group === "started");
  await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id: review, set: { stateId: started[1]!.id } }]); // into review: instant, not digest
  const due = await newIssue(f.ws.ownerId, { assigneeIds: [me.id], dueDate: "2026-11-02" });
  await tx(f.ws.ownerId, [{ op: "create", m: "Comment", id: randomUUID(), set: { issueId: review, body: "Ready for a look" } }]); // a comment: the digest by default
  await follow(f.ws.workspaceId);
  assert.equal((await db.select().from(notifyOutbox).where(and(eq(notifyOutbox.userId, me.id), eq(notifyOutbox.channel, "digest")))).length, 1);

  const { mails, mailer } = collect();
  assert.equal(await sendDigests(mailer, ORIGIN, log, new Date("2026-11-02T07:59:00Z")), 0, "not before 08:00");
  await sendDigests(mailer, ORIGIN, log, new Date("2026-11-02T08:01:00Z"));
  const mine = mails.filter((m) => m.to === me.email);
  assert.equal(mine.length, 1);
  assert.match(mine[0]!.headers!["List-Unsubscribe"]!, /\/notify\/unsubscribe\?u=/, "a digest can unsubscribe too");
  assert.match(mine[0]!.text, /Waiting on you\n- \S+ Rotate the edge nodes \(Review requested\)/);
  assert.match(mine[0]!.text, /Due today\n- \S+ Rotate the edge nodes/);
  assert.match(mine[0]!.text, /Since the last digest\n- \S+ Rotate the edge nodes \(.+ commented on/);
  assert.equal(mails.filter((m) => m.to === quiet.email).length, 0, "an empty one is skipped");
  assert.ok(due);

  await sendDigests(mailer, ORIGIN, log, new Date("2026-11-02T12:00:00Z"));
  assert.equal(mails.filter((m) => m.to === me.email).length, 1, "once a day");
  assert.deepEqual((await db.select({ s: notifyOutbox.status }).from(notifyOutbox).where(and(eq(notifyOutbox.userId, me.id), eq(notifyOutbox.channel, "digest")))).map((r) => r.s), ["sent"]);
});

test("the weekly summary goes on Monday at 09:00 to those who turned it on", async () => {
  const me = await person({ weekly: true, digest: { ...NOTIFY_DEFAULTS.digest, on: false } });
  const off = await person({ digest: { ...NOTIFY_DEFAULTS.digest, on: false } });
  const done = f.refs.states.find((s) => s.group === "completed")!;
  const id = await newIssue(f.ws.ownerId);
  await tx(f.ws.agentId, [{ op: "update", m: "Issue", id, set: { stateId: done.id } }]);
  const { mails, mailer } = collect();
  await sendDigests(mailer, ORIGIN, log, new Date("2026-11-03T09:30:00Z")); // a Tuesday
  assert.equal(mails.filter((m) => m.to === me.email).length, 0);
  await sendDigests(mailer, ORIGIN, log, new Date("2026-11-09T09:30:00Z")); // a Monday
  const mine = mails.filter((m) => m.to === me.email);
  assert.equal(mine.length, 1);
  assert.match(mine[0]!.subject, /^Week of /);
  assert.match(mine[0]!.text, /by agents/);
  assert.equal(mails.filter((m) => m.to === off.email).length, 0);
});

test("the first time the digest meets a person, today counts as sent: a deploy does not mail everyone at once", async () => {
  const me = await addMember(f.ws.workspaceId, "member");
  await db.insert(accountSettings).values({ userId: me.id, timeZone: "UTC", notifications: { ...NOTIFY_DEFAULTS, digest: { ...NOTIFY_DEFAULTS.digest, days: [0, 1, 2, 3, 4, 5, 6], skipEmpty: false } } });
  const { mails, mailer } = collect();
  await sendDigests(mailer, ORIGIN, log, new Date("2026-11-04T09:00:00Z"));
  assert.equal(mails.filter((m) => m.to === me.email).length, 0);
  await sendDigests(mailer, ORIGIN, log, new Date("2026-11-05T09:00:00Z"));
  assert.equal(mails.filter((m) => m.to === me.email).length, 1);
});

test("digest rows read in the app or turned off are closed, not kept for ever", async () => {
  const me = await person({ digest: { on: true, time: "08:00", days: [0, 1, 2, 3, 4, 5, 6], skipEmpty: true }, seen: true });
  const id = await newIssue(me.id);
  const r = await tx(f.ws.ownerId, [{ op: "create", m: "Comment", id: randomUUID(), set: { issueId: id, body: "Read this in the app" } }]);
  await follow(f.ws.workspaceId);
  await writeMarks(f.ws.workspaceId, me.id, [{ issueId: id, readId: r.s, archivedId: 0, snoozedId: 0, snoozedUntil: null }]);
  const { mails, mailer } = collect();
  await sendDigests(mailer, ORIGIN, log, new Date("2026-11-06T08:30:00Z"));
  assert.equal(mails.filter((m) => m.to === me.email).length, 0, "nothing left: skipped");
  assert.deepEqual((await db.select({ s: notifyOutbox.status }).from(notifyOutbox).where(eq(notifyOutbox.userId, me.id))).map((x) => x.s), ["seen"]);
});

test("due today is in the digest by default, a cycle set to Digest joins it, and Off leaves due today out", async () => {
  const every = { on: true, time: "08:00", days: [0, 1, 2, 3, 4, 5, 6], skipEmpty: true };
  const me = await person({ digest: every, rules: { cycle: { email: "digest" } } });
  const off = await person({ digest: every, rules: { due: { email: "off" } } });
  await newIssue(f.ws.ownerId, { title: "Pay the domain", assigneeIds: [me.id, off.id], dueDate: "2026-11-07" });
  const c = await newCycle({ leadId: me.id, startDate: "2026-11-07", endDate: "2026-11-07" });
  const { mails, mailer } = collect();
  await sendDigests(mailer, ORIGIN, log, new Date("2026-11-07T08:05:00Z"));
  const mine = mails.filter((m) => m.to === me.email);
  assert.equal(mine.length, 1);
  assert.match(mine[0]!.text, /Due today\n- \S+ Pay the domain/);
  assert.match(mine[0]!.text, new RegExp(`Cycles\n- ${c} Sprint \\d+ \\(Starts and ends today\\)`));
  assert.equal(mails.filter((m) => m.to === off.email).length, 0, "nothing else for them: the empty digest is skipped");
});
