// Replies by email (PLNR-211, ADR 0034). A single notification email carries its own reply address,
// `<issue key>.<token>@<RSVA_REPLY_DOMAIN>`; the token is random and only its hash is kept, in the notification's
// notify_outbox row, which names the person, the issue and the thread, as a Telegram reply finds them by messageId.
//
// Mail to that domain goes to Resend Receiving, which calls POST /api/mail/inbound with the mail's id. The webhook has
// no session: its Svix signature over the raw body is checked before anything of the body is believed, and the mail
// itself is then read from Resend's API, not from the request, and only when the signed event already names a reply
// address we gave and the person's address as its sender: mail to a made-up address costs one query, not a download.
//
// A reply posts only when the sender is proven: the address's token matches a sent email, the From header is the
// person's account address and nothing else, and the receiving side found the mail authentic for that address's domain
// (Resend's `authentication`: DMARC passing, or the domain's own DKIM signature where its policy is none). Anything
// short of that is dropped without an answer, since an answer to a forged From would mail a stranger. A proven sender
// whose reply cannot post (an old address, access lost, the issue in the trash, nothing above the quote) is told why,
// at the account's address.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { REPLY_DAYS, uuidOf } from "@rsva/protocol";
import { fromHtml } from "@rsva/editor/html";
import { toMarkdown } from "@rsva/editor/markdown";
import { COMMENT_MAX, issuePath } from "@rsva/schema/models";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Mail, Mailer } from "../auth/mail.ts";
import { sha256 } from "../auth/secret.ts";
import { db, schema } from "../db.ts";
import { postReply, type ReplyOutcome } from "../notify/reply.ts";
import { prefsOf } from "../notify/prefs.ts";
import type { Outbox } from "../notify/send.ts";
import { rawWebhook } from "../webhook.ts";
import { REPLY_LINE, replyRefusedMail } from "./emails.ts";

const { notifyOutbox, user, workspace } = schema;

/** A received mail as Resend's API returns it (GET /emails/receiving/{id}); only what is read here. */
export interface ReceivedEmail {
  id: string;
  /** The bare address Resend took from the From header; the header itself, with any display name, is `headers.from`. */
  from: string;
  to: string[];
  cc?: string[] | null;
  text: string | null;
  html: string | null;
  headers?: Record<string, unknown> | null;
  /** The receiving server's verdicts: pass, fail, gray, processing_failed or unknown. */
  authentication?: { spf?: string; dkim?: string; dmarc?: string } | null;
}

export interface InboundConfig {
  domain: string;
  /** The webhook's signing secret, `whsec_<base64>`. */
  secret: string;
  /** The mail, or why it is not taken (too big, or Resend refused it for good); throws when trying again may help. */
  fetchEmail: (id: string) => Promise<ReceivedEmail | { dropped: string }>;
}

/**
 * The most of a mail read: replies are short, and inline images stay `cid:` references. Anything bigger is dropped
 * before it is parsed, so a few large mails at once cannot take the server's memory.
 */
const MAIL_MAX = 2 * 2 ** 20;

/** The body of `res`, or null past `max` bytes (counted as they arrive: a length header may be missing or compressed). */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body?.cancel();
    return null;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > max) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Replies are on only with all three: a Reply-To nobody reads would lose what people write. */
export function inboundFromEnv(env: NodeJS.ProcessEnv = process.env): InboundConfig | null {
  const domain = env.RSVA_REPLY_DOMAIN?.trim().toLowerCase();
  const secret = env.RESEND_WEBHOOK_SECRET;
  const key = env.RESEND_RECEIVING_KEY;
  if (!domain || !secret || !key) return null;
  return {
    domain,
    secret,
    fetchEmail: async (id) => {
      const url = `https://api.resend.com/emails/receiving/${encodeURIComponent(id)}?html_format=cid`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      // A 429 or 5xx passes: Resend delivers the event again. Another refusal will not change by asking again.
      if (res.status === 429 || res.status >= 500) throw new Error(`Resend answered HTTP ${res.status} for a received email`);
      if (!res.ok) return { dropped: `Resend answered HTTP ${res.status}` };
      const text = await readCapped(res, MAIL_MAX);
      return text === null ? { dropped: `the mail is over ${MAIL_MAX} bytes` } : (JSON.parse(text) as ReceivedEmail);
    },
  };
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** 80 random bits as 16 letters and digits: short enough for a readable address, nothing to guess. */
function token(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (let i = 0; i < 16; i++) {
    const bit = i * 5;
    const v = ((bytes[bit >> 3]! << 8) | (bytes[(bit >> 3) + 1] ?? 0)) >> (11 - (bit & 7));
    out += BASE32[v & 31];
  }
  return out;
}

/** A new reply address for the row's email; its token replaces any earlier one of the row (a resend after a failure). */
export async function replyAddress(row: Outbox, issueKey: string, domain: string): Promise<string> {
  const t = token();
  await db.update(notifyOutbox).set({ replyHash: sha256(t) }).where(eq(notifyOutbox.id, row.id));
  return `${issueKey.toLowerCase()}.${t}@${domain}`;
}

/**
 * An address as it is compared: printable ASCII only, then lower case. Lower-casing Unicode is not safe to compare by:
 * the Kelvin sign "K" lower-cases to "k", so `Kate@corp.com` with it would pass as `kate@corp.com`.
 */
const comparable = (address: string): string | null => (/^[\x21-\x7e]+$/.test(address) ? address.toLowerCase() : null);

const ADDRESS = String.raw`[^\s<>@,;:"()\[\]\\]+@[^\s<>@,;:"()\[\]\\]+`;
/**
 * The one address of a From header: `Ann <ann@example.com>`, `"Ann B" <ann@example.com>` or a bare `ann@example.com`,
 * comparable. Anything else is null: several addresses, or a display name holding `<`, `>`, `@` or a comma, so that
 * `"<them@x>" <me@evil>` cannot pass as theirs while DMARC was checked for evil.
 *
 * Linear on any header: the value is trimmed first, and no two quantifiers may take the same spaces. An unquoted name
 * already takes the spaces before `<`; with a `\s*` after it, and one before it, a run of spaces that fails to match
 * was tried in every split, cubic time (PLNR-268).
 */
const FROM = new RegExp(String.raw`^(?:(?:"[^"<>@,\\]*"\s*|[^"<>@,;:\\]*)<(${ADDRESS})>|(${ADDRESS}))$`);
export function senderOf(from: string): string | null {
  const m = FROM.exec(from.trim());
  return m ? comparable((m[1] ?? m[2])!) : null;
}

/**
 * A recipient's address, `Ann <a@b>` or bare, lower case; a recipient only picks the token, the sender proves nothing.
 * Linear: the address takes no `@` in its two halves, so a run of `@`s has one split, not every one (RSVA-601).
 */
const addressOf = (s: string): string => (/<([^<>\s@]+@[^<>\s@]+)>\s*$/.exec(s)?.[1] ?? s).trim().toLowerCase();

/**
 * What of a signed event's recipients is read at all. A reply address is under 100 characters, an address is at most 254;
 * 998 is the longest line of a mail (RFC 5322), room for a long display name, and what is longer cannot be our address.
 * 100 recipients is the least an SMTP server must take (RFC 5321). Cut off before any parsing, so what a sender
 * packs into a header costs a length check, not a scan.
 */
const MAX_RECIPIENT = 998;
const MAX_RECIPIENTS = 100;

/** The token of the first recipient at our domain that has the shape of a reply address. */
export function tokenOf(recipients: string[], domain: string): string | null {
  for (const r of recipients.slice(0, MAX_RECIPIENTS)) {
    if (r.length > MAX_RECIPIENT) continue;
    const m = /^[a-z0-9-]{1,40}\.([a-z2-7]{16})@(.+)$/.exec(addressOf(r));
    if (m && m[2] === domain) return m[1]!;
  }
  return null;
}

/**
 * A Resend webhook signature (Svix, Standard Webhooks): HMAC-SHA256 over `<id>.<timestamp>.<raw body>` with the base64
 * key after `whsec_`, sent as `v1,<base64>`, several space-separated while a secret rotates. Five minutes either way.
 */
export function validWebhook(body: Buffer, headers: Record<string, string | string[] | undefined>, secret: string, nowMs = Date.now()): boolean {
  const one = (name: string) => {
    const v = headers[`svix-${name}`] ?? headers[`webhook-${name}`];
    return typeof v === "string" ? v : undefined;
  };
  const id = one("id");
  const ts = one("timestamp");
  const signatures = one("signature");
  if (!id || !ts || !signatures || !/^\d{1,12}$/.test(ts) || Math.abs(nowMs / 1000 - Number(ts)) > 300) return false;
  const want = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
    .update(`${id}.${ts}.`)
    .update(body)
    .digest();
  return signatures.split(" ").some((s) => {
    const [version, b64] = s.split(",");
    const got = version === "v1" && b64 ? Buffer.from(b64, "base64") : null;
    return !!got && got.length === want.length && timingSafeEqual(got, want);
  });
}

/** A header's value; a header given twice (whatever shape Resend gives it then) is no value. */
const header = (mail: ReceivedEmail, name: string): string | undefined => {
  const h = mail.headers ?? {};
  const keys = Object.keys(h).filter((k) => k.toLowerCase() === name);
  const v = keys.length === 1 ? h[keys[0]!] : undefined;
  return typeof v === "string" ? v : undefined;
};

/** An out-of-office answer or a list's mail (RFC 3834 and the usual markers) is not a person replying. */
function automatic(mail: ReceivedEmail): boolean {
  const auto = header(mail, "auto-submitted");
  if (auto && auto.trim().toLowerCase() !== "no") return true;
  if (header(mail, "x-autoreply") || header(mail, "x-autorespond")) return true;
  return /^(bulk|junk|list|auto_reply)$/i.test(header(mail, "precedence")?.trim() ?? "");
}

/**
 * A mail with only an HTML part, as the Markdown of a comment: the editor's linear HTML reader, so bold and links stay,
 * and a `<blockquote>` becomes `>` lines, where replyText cuts.
 */
const htmlText = (html: string): string => toMarkdown(fromHtml(html));

/** Where a client starts the quoted original: Outlook's block of fields, or a separator line. */
function quoteStarts(lines: string[], i: number): boolean {
  const l = lines[i]!.trim();
  if (/^-{2,}\s*(Original Message|Исходное сообщение)\s*-{2,}$/i.test(l) || /^_{20,}$/.test(l)) return true;
  if (!/^(From|От):\s/.test(l)) return false;
  return lines.slice(i + 1, i + 5).some((n) => /^(Sent|Date|Отправлено|Дата):\s/.test(n.trim()));
}

/** The attribution a client writes over the quote: "On … wrote:", "…, Ann <a@b>:". Bounded and `@`-free so that no hostile line is tried in every split: `\S*` after "написал" ran to the end from each of 100 KB of "написал"s, and `<a@a@a@…` was split at every `@`; "написал(а)" and "написали" are 3 and 1 characters past the verb, 8 is room. */
const attribution = (s: string) => /(wrote|написал\S{0,8}|пишет)\s*:$/i.test(s) || /<[^<>\s@]+@[^<>\s]+>[^<>]*:$/.test(s);

/**
 * What the person wrote: the text above the quoted email and above their signature. The quote starts at our own first
 * line (REPLY_LINE), at the first `>` line or at Outlook's fields, whichever comes first; the client's attribution line
 * over it goes too.
 */
export function replyText(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.findIndex((l, i) => l.includes(REPLY_LINE) || l.trimStart().startsWith(">") || quoteStarts(lines, i));
  if (end < 0) end = lines.length;
  let kept = lines.slice(0, end);
  const signature = kept.findIndex((l) => l === "-- ");
  if (signature >= 0) kept = kept.slice(0, signature);
  const trimEnd = () => {
    while (kept.length && !kept.at(-1)!.trim()) kept.pop();
  };
  trimEnd();
  const last = kept.at(-1)?.trim() ?? "";
  if (attribution(last)) {
    kept.pop();
    // Gmail wraps a long one: "On Tue, …, recursiva <" over "plan@rsva.dev> wrote:". Only a line that starts with the
    // address is the second half; the line over a whole attribution is the person's.
    if (/^<?[^\s<>@]+@[^\s<>]+>/.test(last) && kept.length && /(<|^On\s.*\d.*)$/.test(kept.at(-1)!.trim())) kept.pop();
  }
  trimEnd();
  if (kept.length && /^(Sent from my |Sent with \[?Proton Mail|Get Outlook for |Отправлено (с|из) )/i.test(kept.at(-1)!.trim())) kept.pop();
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A transaction id of a mail: Resend's id hashed into a UUID (version 8), so a second delivery replays the first. */
export function txIdOf(emailId: string): string {
  return uuidOf(Buffer.from(sha256(`rsva-reply:${emailId}`), "base64url"), 8);
}

/** What came of a received mail: posted, refused with an answer to the person, or dropped (and why, for the log). */
type InboundOutcome = { posted: string } | { answer: Mail } | { dropped: string };

const WHY: Record<Exclude<ReplyOutcome, { posted: string }>["refused"], string> = {
  access: "You no longer have access to this issue.",
  trash: "The issue is in the trash.",
  // The write path's refusal is worded for Telegram's HTML; by email, the gist.
  write: "recursiva could not post it as your comment: you may not comment there now, or too many changes came at once. Try again in the app.",
};

type Addressed = { outbox: Outbox; email: string; slug: string };

/**
 * The notification a received mail answers, from the signed event alone: a reply address we gave among its recipients,
 * and the person's address as its sender. Only then is the mail worth reading.
 */
async function addressed(data: { from?: unknown; to?: unknown; cc?: unknown }, domain: string): Promise<Addressed | { dropped: string }> {
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const t = tokenOf([...strings(data.to), ...strings(data.cc)], domain);
  if (!t) return { dropped: "no reply address" };
  const [row] = await db
    .select({ outbox: notifyOutbox, email: user.email, slug: workspace.slug })
    .from(notifyOutbox)
    .innerJoin(user, eq(user.id, notifyOutbox.userId))
    .innerJoin(workspace, eq(workspace.id, notifyOutbox.workspaceId))
    .where(and(eq(notifyOutbox.replyHash, sha256(t)), eq(notifyOutbox.channel, "email")));
  if (!row) return { dropped: "an unknown reply address" };
  if (typeof data.from !== "string" || comparable(data.from.trim()) !== row.email.toLowerCase()) return { dropped: "From is not the person the address was made for" };
  return row;
}

/**
 * The receiving side proved the From domain sent it: DMARC passed, or the domain has no DMARC policy to apply (`gray`:
 * none, or `p=none`, as gmail.com, yandex.ru and outlook.com publish) and the mail carries its DKIM signature. Resend's
 * `dkim` is pass only when the signing domain is the From domain: a mail signed by another domain gets gray (seen on test
 * mails, PLNR-269). A policy only tells a receiver what to do with mail
 * that fails; a fail is dropped here whatever it says. SPF alone is not enough: it checks the envelope's domain, not From.
 */
const authentic = (a: ReceivedEmail["authentication"]): boolean => a?.dmarc === "pass" || (a?.dmarc === "gray" && a.dkim === "pass");

async function handleInbound(mail: ReceivedEmail, row: Addressed, origin: string, now = new Date()): Promise<InboundOutcome> {
  if (automatic(mail)) return { dropped: "an automatic reply" };
  if (/^fail$/i.test(header(mail, "x-ses-spam-verdict") ?? "") || /^fail$/i.test(header(mail, "x-ses-virus-verdict") ?? "")) return { dropped: "spam or a virus" };
  // Resend's `from` is an address it took out of the header; the header must hold that one address and nothing else.
  const email = row.email.toLowerCase();
  if (typeof mail.from !== "string" || comparable(mail.from.trim()) !== email || senderOf(header(mail, "from") ?? "") !== email) return { dropped: "From is not the person the address was made for" };
  if (!authentic(mail.authentication)) {
    const v = (x: unknown) => String(x ?? "none").slice(0, 20);
    return { dropped: `not proven to come from the sender's domain (dmarc ${v(mail.authentication?.dmarc)}, dkim ${v(mail.authentication?.dkim)})` };
  }

  // The person, proven: from here on they hear why a reply did not post.
  const refuse = (why: string, more: { key?: string; stale?: boolean } = {}): InboundOutcome => ({
    answer: replyRefusedMail({ to: row.email, why, origin, ...(more.stale ? { stale: true } : {}), ...(more.key ? { issueKey: more.key, link: `${origin}${issuePath(row.slug, more.key)}` } : {}) }, now),
  });
  // Days from when the email went: in quiet hours that is later than the row was made.
  const sent = Date.parse(row.outbox.doneAt ?? row.outbox.createdAt);
  if (now.getTime() - sent > REPLY_DAYS * 86_400_000) return refuse(`This email is more than ${REPLY_DAYS} days old, so replies to it are no longer taken.`, { stale: true });
  if (!(await prefsOf([row.outbox.userId])).get(row.outbox.userId)!.prefs.email.reply) return refuse("Replying by email is off in Settings › Notifications › Email.");
  const body = replyText(mail.text ?? htmlText(mail.html ?? ""));
  if (!body) return refuse(`There was no text above the quoted email. Write your reply above the line “${REPLY_LINE}”.`);
  if (body.length > COMMENT_MAX) return refuse("The reply is longer than a comment may be.");
  const r = await postReply(row.outbox, body, "email", txIdOf(mail.id));
  if ("posted" in r) return r;
  return refuse(WHY[r.refused], "key" in r ? { key: r.key } : {});
}

/** Resend's events are small: an email's id and its envelope, not its body. */
const BODY_MAX = 256 * 1024;

/** Mails read from Resend at once: each holds up to MAIL_MAX in memory. Past it, a 503, and Resend delivers again. */
const FETCH_MAX = 4;

export function registerInbound(root: FastifyInstance, cfg: InboundConfig | null, mailer: Mailer, origin: string): void {
  void root.register(async (app) => {
    // Without the whole setup there is no such path, and nothing here reads a body.
    if (!cfg) return;
    let fetching = 0;
    app.post("/api/mail/inbound", rawWebhook(app, BODY_MAX), async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || !validWebhook(body, req.headers, cfg.secret)) return reply.code(401).send({ error: "unauthorized", message: "signature does not match" });
      let event: { type?: unknown; data?: { email_id?: unknown; from?: unknown; to?: unknown; cc?: unknown } };
      try {
        event = JSON.parse(body.toString("utf8")) as typeof event;
      } catch {
        return reply.code(400).send({ error: "invalid", message: "the body is not JSON" });
      }
      const id = event.data?.email_id;
      if (event.type !== "email.received" || typeof id !== "string" || !/^[\w-]{1,100}$/.test(id)) return { ignored: true };
      const drop = (why: string) => {
        req.log.info({ email: id }, `reply by email dropped: ${why}`);
        return { ok: true };
      };
      const row = await addressed(event.data!, cfg.domain);
      if ("dropped" in row) return drop(row.dropped);
      if (fetching >= FETCH_MAX) return reply.code(503).header("retry-after", "10").send({ error: "busy", message: "too many mails at once" });
      fetching++;
      let mail: ReceivedEmail | { dropped: string };
      try {
        // A failure here answers 5xx, and Resend delivers the event again: the transaction id makes that a replay.
        mail = await cfg.fetchEmail(id);
      } finally {
        fetching--;
      }
      if ("dropped" in mail) return drop(mail.dropped);
      const outcome = await handleInbound(mail, row, origin);
      if ("dropped" in outcome) return drop(outcome.dropped);
      if ("answer" in outcome) await mailer(outcome.answer).catch((e: unknown) => req.log.error(e, "reply by email: the answer was not sent"));
      return { ok: true };
    });
  });
}
