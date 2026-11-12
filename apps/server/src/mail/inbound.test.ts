import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { NOTIFY_DEFAULTS, type NotifySettingsView } from "@rsva/protocol";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { forgetRoles } from "../auth/access.ts";
import type { Mail } from "../auth/mail.ts";
import { sha256 } from "../auth/secret.ts";
import { db, schema } from "../db.ts";
import { follow } from "../notify/follow.ts";
import { notifyFixture, setPrefs } from "../notify/fixture.ts";
import { sendDue } from "../notify/send.ts";
import { addMember, asUser, fetchAs, startServer } from "../test/helpers.ts";
import { REPLY_LINE } from "./emails.ts";
import { replyText, senderOf, tokenOf, txIdOf, validWebhook, type ReceivedEmail } from "./inbound.ts";

const { notifyOutbox, comment, member, issue } = schema;
const ORIGIN = "https://plan.example.test";
const DOMAIN = "reply.example.test";
const SECRET = `whsec_${Buffer.from("inbound-test-secret-0123456789").toString("base64")}`;

const received = new Map<string, ReceivedEmail | { dropped: string }>();
/** The ids of the mails the server read from "Resend". */
const fetched = new Set<string>();
const answers: Mail[] = [];
const { f, tx, newIssue, mentionedInThread } = notifyFixture();
let server: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  server = await startServer({
    inbound: {
      domain: DOMAIN,
      secret: SECRET,
      fetchEmail: async (id) => {
        fetched.add(id);
        return received.get(id) ?? Promise.reject(new Error("no such email"));
      },
    },
    mailer: async (m) => void answers.push(m),
  });
});
after(() => server.close());

const sign = (id: string, ts: string, body: string, secret = SECRET) => createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${ts}.${body}`).digest("base64");

/**
 * Resend's webhook for a received email, signed as Resend signs it; the event carries the envelope Resend read, the
 * mail itself is what the API gives (`served`, by default the mail).
 */
async function deliver(mail: ReceivedEmail, secret = SECRET, served: ReceivedEmail | { dropped: string } = mail) {
  received.set(mail.id, served);
  const body = JSON.stringify({ type: "email.received", created_at: new Date().toISOString(), data: { email_id: mail.id, from: mail.from, to: mail.to, cc: mail.cc ?? [] } });
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${server.url}/api/mail/inbound`, {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": `msg_${mail.id}`, "svix-timestamp": ts, "svix-signature": `v1,${sign(`msg_${mail.id}`, ts, body, secret)}` },
    body,
  });
}

/** A member mentioned in a thread, and the notification email the notifier sends them, with its reply address. */
async function mentionedByEmail() {
  const me = await addMember(f.ws.workspaceId, "member");
  await setPrefs(me.id, { ...NOTIFY_DEFAULTS, seen: false, quiet: null });
  const { id, root, now } = await mentionedInThread(me.id);
  const mails: Mail[] = [];
  await sendDue(async (m) => void mails.push(m), ORIGIN, new Date(now.getTime() + 11 * 60_000), f.ws.workspaceId, DOMAIN);
  const mail = mails.find((m) => m.to === me.email);
  assert.ok(mail?.replyTo, "the mention went by email with a reply address");
  return { me, id, root, mail, to: mail.replyTo };
}

/**
 * A reply as Resend hands it over (its retrieve example): `from` the bare address it took out of the header, the
 * header itself with the display name in `headers.from`; from the person, DMARC passing, the text above the quote.
 */
const reply = (to: string, from: string, text: string, more: Partial<ReceivedEmail> = {}): ReceivedEmail => ({
  id: randomUUID(),
  from,
  to: [to],
  text,
  html: null,
  headers: { from: `Ann <${from}>` },
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
  ...more,
});
const theirComments = (issueId: string, userId: string) => db.select().from(comment).where(and(eq(comment.issueId, issueId), eq(comment.authorId, userId)));
const answersTo = (email: string) => answers.filter((m) => m.to === email);

test("a single notification has its own reply address, the first line says where to write, and only a hash is kept", async () => {
  const { me, id, mail, to } = await mentionedByEmail();
  const key = mail.subject.slice(1, mail.subject.indexOf("]"));
  assert.match(to, new RegExp(`^${key.toLowerCase()}\\.[a-z2-7]{16}@${DOMAIN.replaceAll(".", "\\.")}$`));
  assert.ok(mail.text.startsWith(`${REPLY_LINE} to comment on ${key}`));
  assert.ok(mail.html.includes(REPLY_LINE));
  const [row] = await db.select().from(notifyOutbox).where(and(eq(notifyOutbox.userId, me.id), eq(notifyOutbox.issueId, id), eq(notifyOutbox.channel, "email")));
  assert.equal(row!.replyHash, sha256(tokenOf([to], DOMAIN)!));
});

test("a recipient is parsed in linear time: a hostile 100 KB string, a long list and real recipients (RSVA-601)", () => {
  const token = "abcdefghijklmnop";
  const real = `slug-1.${token}@${DOMAIN}`;
  assert.equal(tokenOf([real], DOMAIN), token);
  assert.equal(tokenOf([`Ann B <${real}>`], DOMAIN), token);
  assert.equal(tokenOf([`"Ann, B" <${real.toUpperCase()}> `], DOMAIN), token);
  assert.equal(tokenOf(["other@example.com", `x <${real}>`], DOMAIN), token);
  assert.equal(tokenOf([`slug-1.${token}@elsewhere.test`], DOMAIN), null);

  // "<a@a@a@…" made the address regex try every split of the @s: quadratic, 100 KB took seconds.
  const hostile = ["<" + "a@".repeat(50_000), "<" + "a@a>".repeat(25_000) + " x", `<${"a".repeat(100_000)}@${"b".repeat(100_000)}`];
  for (const h of hostile) {
    const t0 = performance.now();
    assert.equal(tokenOf([h], DOMAIN), null);
    const ms = performance.now() - t0;
    assert.ok(ms < 20, `${h.length} chars took ${ms.toFixed(1)} ms`);
  }
  const t0 = performance.now();
  assert.equal(tokenOf(Array.from({ length: 20_000 }, () => "<a@a@a@a@a@a@a@a@a@a@a@a@a@a@a@a@a@a@"), DOMAIN), null);
  assert.ok(performance.now() - t0 < 20, "a long list is cut off");
  assert.equal(tokenOf([...Array.from({ length: 150 }, () => "x@y.test"), real], DOMAIN), null, "past 100 recipients nothing is read");
  const t1 = performance.now();
  assert.equal(replyText("Thanks\n\n<" + "a@".repeat(50_000)), "Thanks\n\n<" + "a@".repeat(50_000));
  assert.ok(performance.now() - t1 < 20, "the attribution check of a reply's last line is linear too");
  for (const line of ["написал".repeat(14_285), "wrote ".repeat(16_000), "a@b> wrote:".repeat(9_000)]) {
    const t2 = performance.now();
    replyText(`Hi\n${line}`);
    assert.ok(performance.now() - t2 < 20, "a long line of one verb is linear");
  }
  for (const ok of ["написал:", "написала:", "написал(а):", "Ann <a@b>:", "x wrote :"]) assert.equal(replyText(`Done\n\n${ok}`), "Done", ok);
  assert.equal(replyText("Done\n\nAnn B <ann@example.com>:"), "Done");
  assert.equal(tokenOf([`${"n".repeat(1000)} <${real}>`], DOMAIN), null, "a recipient over 998 characters is skipped");
});

test("a reply posts once as the person, in the thread; a second delivery of it posts nothing new", async () => {
  const { me, id, root, to } = await mentionedByEmail();
  const r = reply(to, me.email.toUpperCase(), `Looks good, ship it.\n\nOn Tue, Nov 4, 2026 at 6:00 PM recursiva <\nplan@example.test> wrote:\n\n> ${REPLY_LINE} to comment on X-1\n> Have a look`);
  assert.equal((await deliver(r)).status, 200);
  assert.equal((await deliver(r)).status, 200, "Resend delivers again");
  const posted = await theirComments(id, me.id);
  assert.deepEqual(
    posted.map((c) => [c.body, c.parentId, c.via]),
    [["Looks good, ship it.", root, "email"]],
  );
  assert.deepEqual(answersTo(me.email), [], "a posted reply gets no mail");
});

test("a reply from a domain with no DMARC policy, or p=none, posts when the domain signed it", async () => {
  // As an iCloud custom domain without a DMARC record replied on 2026-11-04: spf=pass, dkim=pass, dmarc=none (gray).
  const { me, id, to } = await mentionedByEmail();
  await deliver(reply(to, me.email, "Signed, no policy.", { authentication: { spf: "pass", dkim: "pass", dmarc: "gray" } }));
  assert.deepEqual((await theirComments(id, me.id)).map((c) => c.body), ["Signed, no policy."]);
});

test("a reply with only an HTML part posts its text above Gmail's quote", async () => {
  const { me, id, to } = await mentionedByEmail();
  const html =
    `<div dir="ltr">Ship it <b>now</b> &amp; tell &#x6F;ps &#99999999;.<br>Thanks</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">` +
    `On Tue, Nov 4, 2026 at 6:00 PM recursiva &lt;<a href="mailto:plan@rsva.dev">plan@rsva.dev</a>&gt; wrote:<br></div><blockquote class="gmail_quote">${REPLY_LINE}</blockquote></div>`;
  await deliver(reply(to, me.email, "", { text: null, html }));
  // A code point past Unicode stays text (escaped, so the comment shows it as written), and does not fail the delivery.
  assert.deepEqual((await theirComments(id, me.id)).map((c) => c.body), ["Ship it **now** & tell ops \\&#99999999;.\\\nThanks"]);
});

test("nothing posts and nothing is answered without proof of the sender", async () => {
  const { me, id, to } = await mentionedByEmail();
  const other = await addMember(f.ws.workspaceId, "member");
  const tries = [
    reply(to, other.email, "forged: another member's address"),
    // Resend took the person's address out of a header that names another; authentication was checked for that other.
    reply(to, me.email, "their address in the display name", { headers: { from: `"<${me.email}>" <attacker@evil.test>` } }),
    reply(to, me.email, "two senders", { headers: { from: `${me.email}, attacker@evil.test` } }),
    reply(to, me.email, "two From headers", { headers: { from: `Ann <${me.email}>`, From: "attacker@evil.test" } }),
    reply(to, me.email, "no From header", { headers: {} }),
    reply(to, me.email, "DMARC failed", { authentication: { spf: "pass", dkim: "fail", dmarc: "fail" } }),
    reply(to, me.email, "DMARC failed with a signature", { authentication: { spf: "fail", dkim: "pass", dmarc: "fail" } }),
    reply(to, me.email, "no policy, SPF alone", { authentication: { spf: "pass", dkim: "gray", dmarc: "gray" } }),
    reply(to, me.email, "no policy, a bad signature", { authentication: { spf: "pass", dkim: "fail", dmarc: "gray" } }),
    // What Resend gave for a test mail signed by another domain (PLNR-269): its header says pass, its verdict is gray.
    reply(to, me.email, "no policy, signed by another domain", {
      headers: { from: `Ann <${me.email}>`, "authentication-results": "amazonses.com; dkim=pass header.i=@evil.test; dmarc=none" },
      authentication: { spf: "gray", dkim: "gray", dmarc: "gray" },
    }),
    reply(to, me.email, "the check failed", { authentication: { spf: "pass", dkim: "pass", dmarc: "processing_failed" } }),
    reply(to, me.email, "no verdict", { authentication: null }),
    reply(to.replace(/\.[a-z2-7]{16}@/, ".aaaaaaaaaaaaaaaa@"), me.email, "a token nobody was given"),
    reply(to.replace(DOMAIN, "elsewhere.test"), me.email, "another domain"),
    reply(to, me.email, "I am out of office", { headers: { "Auto-Submitted": "auto-replied" } }),
  ];
  for (const t of tries) assert.equal((await deliver(t)).status, 200);
  assert.ok(!fetched.has(tries[0]!.id) && !fetched.has(tries.at(-3)!.id) && !fetched.has(tries.at(-2)!.id), "a mail whose envelope proves nothing is not read");
  assert.deepEqual(await theirComments(id, me.id), []);
  assert.deepEqual(answersTo(me.email), []);
  assert.deepEqual(answersTo(other.email), []);
});

test("a bad signature is refused before the mail is read", async () => {
  const { me, id, to } = await mentionedByEmail();
  const r = reply(to, me.email, "signed with another secret");
  assert.equal((await deliver(r, `whsec_${Buffer.from("not-the-secret").toString("base64")}`)).status, 401);
  assert.ok(!fetched.has(r.id));
  assert.deepEqual(await theirComments(id, me.id), []);
});

test("a mail Resend will not hand over, or one too big to read, is dropped and not delivered again", async () => {
  const { me, id, to } = await mentionedByEmail();
  for (const why of ["the mail is over 2097152 bytes", "Resend answered HTTP 404"]) assert.equal((await deliver(reply(to, me.email, "big"), SECRET, { dropped: why })).status, 200);
  assert.deepEqual(await theirComments(id, me.id), []);
  assert.deepEqual(answersTo(me.email), []);
});

test("a proven sender whose reply cannot post is told why, at the account's address", async () => {
  const quoteOnly = await mentionedByEmail();
  await deliver(reply(quoteOnly.to, quoteOnly.me.email, `> ${REPLY_LINE}\n> Have a look`));
  assert.match(answersTo(quoteOnly.me.email)[0]!.text, /no text above the quoted email/);

  const off = await mentionedByEmail();
  await setPrefs(off.me.id, { ...NOTIFY_DEFAULTS, email: { ...NOTIFY_DEFAULTS.email, reply: false } });
  await deliver(reply(off.to, off.me.email, "still on?"));
  assert.match(answersTo(off.me.email)[0]!.text, /Replying by email is off/);

  const old = await mentionedByEmail();
  // The days count from when the email went, not from when the row was made (quiet hours hold it).
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  await db.update(notifyOutbox).set({ createdAt: ago(40), doneAt: ago(29) }).where(eq(notifyOutbox.replyHash, sha256(tokenOf([old.to], DOMAIN)!)));
  await deliver(reply(old.to, old.me.email, "in time"));
  assert.deepEqual((await theirComments(old.id, old.me.id)).map((c) => c.body), ["in time"]);
  await db.update(notifyOutbox).set({ doneAt: ago(31) }).where(eq(notifyOutbox.replyHash, sha256(tokenOf([old.to], DOMAIN)!)));
  await deliver(reply(old.to, old.me.email, "late"));
  assert.match(answersTo(old.me.email)[0]!.text, /more than 30 days old/);
  assert.match(answersTo(old.me.email)[0]!.html, /Reply to the newest notification/);
  assert.doesNotMatch(answersTo(off.me.email)[0]!.html, /Reply to the newest notification/, "that advice only where a newer address helps");

  const trashed = await mentionedByEmail();
  await db.update(issue).set({ deletedAt: new Date().toISOString() }).where(eq(issue.id, trashed.id));
  await deliver(reply(trashed.to, trashed.me.email, "anyone?"));
  const t = answersTo(trashed.me.email)[0]!;
  assert.match(t.subject, /^Your reply was not posted to [A-Z]+-\d+$/);
  assert.match(t.text, /in the trash/);

  const gone = await mentionedByEmail();
  await db.update(member).set({ role: "guest" }).where(and(eq(member.workspaceId, f.ws.workspaceId), eq(member.userId, gone.me.id)));
  forgetRoles();
  await deliver(reply(gone.to, gone.me.email, "still here?"));
  assert.match(answersTo(gone.me.email)[0]!.text, /no longer have access/);
  assert.doesNotMatch(answersTo(gone.me.email)[0]!.text, /browse/, "no link to an issue they cannot see");

  for (const x of [quoteOnly, off, trashed, gone]) assert.deepEqual(await theirComments(x.id, x.me.id), []);
});

test("a bundle carries no reply address; the Email page shows the domain the server takes replies at", async () => {
  const me = await addMember(f.ws.workspaceId, "member");
  await setPrefs(me.id, { ...NOTIFY_DEFAULTS, seen: false, quiet: null, email: { ...NOTIFY_DEFAULTS.email, bundle: true } });
  for (const id of [await newIssue(f.ws.ownerId), await newIssue(f.ws.ownerId)]) await tx(f.ws.ownerId, [{ op: "update", m: "Issue", id, set: { assigneeIds: [me.id] } }]);
  const now = new Date("2026-11-04T10:00:00Z");
  await follow(f.ws.workspaceId, now);
  const mails: Mail[] = [];
  await sendDue(async (m) => void mails.push(m), ORIGIN, new Date("2026-11-04T10:30:00Z"), f.ws.workspaceId, DOMAIN);
  const bundle = mails.filter((m) => m.to === me.email);
  assert.equal(bundle.length, 1);
  assert.equal(bundle[0]!.replyTo, undefined);
  assert.ok(!bundle[0]!.text.includes(REPLY_LINE));

  const view = (await (await fetchAs(await asUser(me.id))(`${server.url}/auth/notifications`)).json()) as NotifySettingsView;
  assert.equal(view.replyDomain, DOMAIN);
  assert.equal(view.prefs.email.reply, true, "on by default");
});

test("the webhook signature: Svix's scheme, a rotated secret among several, and five minutes of tolerance", () => {
  const body = Buffer.from('{"type":"email.received"}');
  const now = 1_790_000_000_000;
  const ts = String(now / 1000);
  const good = sign("msg_1", ts, body.toString());
  assert.ok(validWebhook(body, { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": `v1,${good}` }, SECRET, now));
  assert.ok(validWebhook(body, { "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": `v1,AAAA v1,${good}` }, SECRET, now));
  assert.ok(!validWebhook(Buffer.from(`${body} `), { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": `v1,${good}` }, SECRET, now));
  assert.ok(!validWebhook(body, { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": `v1,${good}` }, SECRET, now + 6 * 60_000));
  assert.ok(!validWebhook(body, { "svix-id": "msg_1", "svix-timestamp": ts }, SECRET, now));
});

test("the signature checks as Svix's documented example signs it", () => {
  // docs.svix.com, "Verifying webhooks manually": that secret, id, timestamp and body give that signature.
  const body = Buffer.from(`{"test": 2432232314}`);
  const headers = { "svix-id": "msg_p5jXN8AQM9LWM0D4loKWxJek", "svix-timestamp": "1614265330", "svix-signature": "v1,bm9ldHUjKzFob2VudXRob2VodWUzMjRvdWVvdW9ldQo= v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=" };
  assert.ok(validWebhook(body, headers, "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", 1614265330_000));
  assert.ok(!validWebhook(Buffer.from(`{"test": 2432232315}`), headers, "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", 1614265330_000));
});

test("the sender is the From's one address; a display name cannot carry another", () => {
  assert.equal(senderOf("Ann <Ann@Example.com>"), "ann@example.com");
  assert.equal(senderOf('"Ann B." <ann@example.com>'), "ann@example.com");
  assert.equal(senderOf("ann@example.com"), "ann@example.com");
  for (const bad of ['"<ann@example.com>" <x@evil.test>', "ann@example.com <x@evil.test>", "ann@example.com, x@evil.test", "Ann <ann@example.com>, <x@evil.test>", "<ann@example.com> <x@evil.test>", ""])
    assert.equal(senderOf(bad), null, bad);
  assert.equal(senderOf("\u212Aate@corp.test"), null, "the Kelvin sign lower-cases to k");
  assert.equal(senderOf(" \t Ann  <ann@example.com>\r\n "), "ann@example.com", "spaces around and before < are fine");
});

test("a From with a long run of spaces is read in linear time", () => {
  // The old pattern took ~2 s on 2,000 spaces and grew with the cube; a million must be instant.
  const spaces = " ".repeat(1_000_000);
  const started = performance.now();
  for (const from of [`${spaces}!`, `${spaces}<ann@example.com> x`, `a${spaces}b`, `"Ann"${spaces}x`]) assert.equal(senderOf(from), null);
  assert.equal(senderOf(`Ann${spaces}<ann@example.com>`), "ann@example.com");
  assert.ok(performance.now() - started < 1000, `${Math.round(performance.now() - started)} ms`);
});

test("a mail's transaction id is a valid UUID, the same for the same mail", () => {
  assert.ok(z.uuid().safeParse(txIdOf("4ef9a417-02e9-4d39-ad75-9611e0fcc33c")).success);
  assert.equal(txIdOf("a"), txIdOf("a"));
  // The id of a mail never changes (a second delivery must replay the first), whatever builds it (RSVA-428: uuidOf).
  assert.equal(txIdOf("a"), "d0531d56-1eec-826d-a462-d5b79331980c");
  assert.notEqual(txIdOf("a"), txIdOf("b"));
});

test("the reply's own text, as mail clients quote the email under it", () => {
  const samples: [client: string, raw: string][] = [
    ["Gmail", `Ship it.\n\nOn Tue, Nov 4, 2026 at 6:00 PM recursiva <plan@rsva.dev> wrote:\n\n> ${REPLY_LINE} to comment on INFRA-112\n> Ann mentioned you`],
    ["Gmail, wrapped", `Ship it.\n\nOn Tue, Nov 4, 2026 at 6:00 PM recursiva <\nplan@rsva.dev> wrote:\n\n> ${REPLY_LINE}`],
    ["Gmail in Russian", `Ship it.\n\nвт, 4 нояб. 2026 г. в 18:00, recursiva <plan@rsva.dev>:\n\n> ${REPLY_LINE}`],
    ["Apple Mail", `Ship it.\n\nSent from my iPhone\n\n> On 4 Nov 2026, at 18:00, recursiva <plan@rsva.dev> wrote:\n> \n> ${REPLY_LINE}`],
    ["Yandex", `Ship it.\n\n04.11.2026, 18:00, "recursiva" <plan@rsva.dev>:\n> ${REPLY_LINE}`],
    ["Outlook", `Ship it.\n\n________________________________\nFrom: recursiva <plan@rsva.dev>\nSent: Tuesday, November 4, 2026 6:00 PM\nTo: Ann <ann@example.com>\nSubject: [INFRA-112] Rotate\n\n${REPLY_LINE} to comment on INFRA-112`],
    ["Outlook without a rule", `Ship it.\n\nFrom: recursiva <plan@rsva.dev>\nSent: Tuesday, November 4, 2026 6:00 PM\nSubject: [INFRA-112] Rotate`],
    ["a signature", `Ship it.\n-- \nAnn, ops`],
    ["our line unquoted", `Ship it.\n${REPLY_LINE} to comment on INFRA-112`],
    // Proton's defaults as its help pages describe them; not taken from a real mail.
    ["Proton Mail", `Ship it.\n\nSent with Proton Mail secure email.\n\nOn Tuesday, November 4th, 2026 at 6:00 PM, recursiva <plan@rsva.dev> wrote:\n\n> ${REPLY_LINE}`],
    ["Proton Mail, linked", `Ship it.\n\nSent with [Proton Mail](https://proton.me/mail/home) secure email.\n\nOn Tuesday, November 4th, 2026 at 6:00 PM, recursiva <plan@rsva.dev> wrote:\n\n> ${REPLY_LINE}`],
  ];
  for (const [client, raw] of samples) assert.equal(replyText(raw), "Ship it.", client);
  assert.equal(replyText("First line\n\nSecond paragraph\r\n\r\n\r\n\r\nThird"), "First line\n\nSecond paragraph\n\nThird", "paragraphs kept, CRLF and runs of blank lines folded");
  assert.equal(replyText(`> ${REPLY_LINE}\n> Have a look`), "", "a quote alone is nothing");
  assert.equal(replyText(`Sure.\nOn 5 Nov we deploy\nOn Tue, Nov 4, 2026 at 6:00 PM recursiva <plan@rsva.dev> wrote:\n> x`), "Sure.\nOn 5 Nov we deploy", "the line over a whole attribution stays");
  assert.equal(replyText("Step one\n--\nStep two"), "Step one\n--\nStep two", "only \"-- \" starts a signature");
});
