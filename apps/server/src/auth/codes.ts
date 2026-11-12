// Sign-in by a code sent to the email: six digits, ten minutes, five guesses, one live code per email.
//
// Only members and invited people sign in: an unknown email gets the same answer as a known one and no mail, so the
// form does not tell who has an account. It also gets a code row nobody knows (a random hash), so /auth/verify answers
// it exactly as it answers a member's: "wrong code" until the decoy expires. Agents have no mailbox and sign in with
// tokens only. An invited address without an account gets one at its first sign-in (docs/decisions/0011-members-invites.md).
//
// Wrong guesses are also counted per address over a rolling day, in the database (login_failure): the limits in
// routes.ts live in memory and reset with every deploy. After DAILY_FAILURES the six-digit code stops working for that
// address, a right one too, until the oldest failures are a day old; a six-digit code then falls to a determined guesser
// with odds of 20 in a million a day, instead of 600. The person is not locked out: past the cap the mail carries a
// one-time link with a 256-bit secret instead of a code (nothing to guess), and the link signs in like a right code.
// The link sits in the URL's fragment (/#signin=…), which browsers never send, so no proxy or request log sees it; the
// page posts it to /auth/link. The answers to the requester stay those of a wrong code, and decoys are kept the same
// way, so neither the cap nor the link tells who has an account.
//
// Considered (2026-10-29): counting failures per address and network (/24, /48) instead. It keeps the code working for
// the person's own network, but an attacker with addresses in many networks (IPv6 /48s are cheap) gets the cap many
// times over, and a person behind a shared NAT can still be locked out. The link keeps one cap per address and no lockout.
//
// One live code or link per address. Past the cap a live link is kept rather than replaced, so requests made by someone
// else only mail the person a link that works, and do not void the one they are about to open. A code is kept for its
// first minute the same way (RSVA-600): requests right after the person's own mail nothing and leave the code they are
// typing; the answer is the 204 it always is, sent before any of this. Later requests still replace it: the person may
// ask for a new code because the first did not come. The sign-in screen offers "Send a new code" after that minute. A
// code that cannot be used any more (used, or out of guesses) has no row, so a request then always sends a new one.
//
// A member with a linked Telegram chat gets the code there too (telegram/sign-in.ts, PLNR-215), when they ask from a
// browser they have signed in from (RSVA-464); from another, the chat only hears that a code was asked. The link, email only.
//
// A local run may fix the code (RSVA_DEV_CODE, mail.ts): then nothing is mailed, the code is that one.
import { randomBytes, randomInt } from "node:crypto";
import { CODE_RESEND_MS } from "@rsva/protocol";
import { and, count, eq, gt, lt, sql as dsql } from "drizzle-orm";
import { db, schema, type Tx } from "../db.ts";
import { mayHaveSession, wayInFor } from "./eligibility.ts";
import { signInCodeMail, signInLinkMail } from "../mail/emails.ts";
import { devCodeFromEnv, type Mailer } from "./mail.ts";
import type { TelegramApi } from "../telegram/api.ts";
import { codeToTelegram, dropTelegramCode, newBrowserToTelegram, type Asker } from "../telegram/sign-in.ts";
import { knownDevice } from "./devices.ts";
import { randomSecret, sameSecret, sha256 } from "./secret.ts";

const { loginCode, loginFailure, user } = schema;

const CODE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
/** Read once at start: a wrong setting stops the server before it answers anything. */
const DEV_CODE = devCodeFromEnv(process.env);
/** Wrong codes an address may send in a rolling 24 hours. */
export const DAILY_FAILURES = 20;
const DAY_MS = 86_400_000;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const hashCode = (email: string, code: string) => sha256(`${email}\n${code}`);
/** A link's row is told from a code's by this prefix: a code never matches it, and a link is never a code. */
const LINK = "L:";
/** A decoy's row (an address that may not sign in) is told by this prefix: once the address may sign in, a new request replaces it at once. */
const DECOY = "D:";
/** A link secret: randomSecret()'s 43 base64url characters. */
export const LINK_SECRET = /^[A-Za-z0-9_-]{43}$/;

/** A human member with this email, or null. */
async function memberByEmail(email: string, q: Tx | typeof db = db): Promise<{ id: string } | null> {
  const [u] = await q
    .select({ id: user.id })
    .from(user)
    .where(and(eq(dsql`lower(${user.email})`, email), mayHaveSession()))
    .limit(1);
  return u ?? null;
}

/** Whether a code may go to this address: a member's, or an invited or let-in one without an account yet. */
async function maySignInByEmail(email: string, q: Tx | typeof db = db): Promise<boolean> {
  if (await memberByEmail(email, q)) return true;
  const [r] = await q.execute<{ ok: boolean }>(dsql`select (${wayInFor(dsql`${email}`)} and not exists (select 1 from ${user} where lower(${user.email}) = ${email})) as ok`);
  return !!r?.ok;
}

/** Whether the address used up its wrong guesses of the last 24 hours; codes that confirm a new address count too (email-change.ts). */
export async function capped(email: string, q: Tx | typeof db = db): Promise<boolean> {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const [r] = await q.select({ n: count() }).from(loginFailure).where(and(eq(loginFailure.email, email), gt(loginFailure.at, since)));
  return (r?.n ?? 0) >= DAILY_FAILURES;
}

/** Counts one wrong code sent for this address towards its daily cap. */
export async function countFailure(email: string, q: Tx | typeof db = db): Promise<void> {
  await q.insert(loginFailure).values({ email });
}

/** "sam.reyes@x" → "Sam Reyes": a first name for a new account until the person sets their own. */
function nameFromEmail(email: string): string {
  const words = email.split("@", 1)[0]!.split(/[._+-]+/).filter(Boolean);
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ") || email;
}

/**
 * Sends a new code if the email may sign in, or past the cap a sign-in link to `origin`; resolves the same either way.
 * The answer to the request goes out before this runs (routes.ts), so its timing tells nothing either. With `telegram`
 * the member's linked chat gets the code too if the asker's browser is one they signed in from, else a notice without
 * it; either channel failing does not stop the other.
 */
export async function requestCode(rawEmail: string, mailer: Mailer, origin: string, telegram: { api: TelegramApi; asker: Asker } | null = null): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const over = await capped(email);
  const member = await maySignInByEmail(email);
  const [live] = await db.select({ codeHash: loginCode.codeHash, createdAt: loginCode.createdAt, expiresAt: loginCode.expiresAt }).from(loginCode).where(eq(loginCode.email, email));
  if (live && Date.parse(live.expiresAt) > Date.now()) {
    const link = live.codeHash.startsWith(LINK);
    // A decoy is kept as a code is, or its guesses would start over and tell it from a member's code; only an address
    // that may sign in now (invited within the minute) gets its real code in place of the decoy at once.
    const young = !link && Date.now() - Date.parse(live.createdAt) < CODE_RESEND_MS && !(member && live.codeHash.startsWith(DECOY));
    if (over ? link : young) return;
  }
  const secret = over ? randomSecret() : (DEV_CODE ?? String(randomInt(0, 1_000_000)).padStart(6, "0"));
  const codeHash = (over ? LINK : "") + (member ? hashCode(email, secret) : DECOY + randomBytes(32).toString("base64url"));
  const row = { codeHash, attempts: 0, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + CODE_MS).toISOString() };
  await db.insert(loginCode).values({ email, ...row }).onConflictDoUpdate({ target: loginCode.email, set: row });
  // The code a chat shows is dead now.
  dropTelegramCode(email);
  if (!member || (DEV_CODE && !over)) return;
  if (over) return mailer(signInLinkMail(email, `${origin}/#${new URLSearchParams({ signin: secret, email })}`, origin));
  const expiresAt = new Date(row.expiresAt);
  // An invited address without an account yet has no chat.
  const chatOwner = telegram ? await memberByEmail(email) : null;
  const toChat = async ({ api, asker }: { api: TelegramApi; asker: Asker }, userId: string) =>
    (await knownDevice(userId, asker.device)) ? codeToTelegram(api, userId, email, secret, expiresAt) : newBrowserToTelegram(api, userId, asker);
  const results = await Promise.allSettled([mailer(signInCodeMail(email, secret, expiresAt, origin)), telegram && chatOwner && toChat(telegram, chatOwner.id)]);
  const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "sign-in code sent by neither email nor Telegram");
}

export type CodeResult = { userId: string } | { error: "invalid_code" | "expired_code" };

/**
 * Checks a code; a right one is used up, a wrong one counts, and the fifth wrong one ends the code. A capped address
 * gets the wrong code's answer whatever it sends, and its row is left alone: guesses cannot void a link on its way.
 */
export async function verifyCode(rawEmail: string, code: string): Promise<CodeResult> {
  const email = normalizeEmail(rawEmail);
  // Set where the code's row goes: used up or out of guesses, the code a chat shows is dead.
  let ended = false;
  const result = await db.transaction(async (tx): Promise<CodeResult> => {
    const [row] = await tx.select().from(loginCode).where(eq(loginCode.email, email)).for("update");
    if (!row) return { error: "expired_code" };
    if (Date.parse(row.expiresAt) <= Date.now()) {
      await tx.delete(loginCode).where(eq(loginCode.email, email));
      return { error: "expired_code" };
    }
    if (await capped(email, tx)) return { error: "invalid_code" };
    if (!/^\d{6}$/.test(code) || !sameSecret(hashCode(email, code), row.codeHash)) {
      if (row.attempts + 1 >= MAX_ATTEMPTS) {
        await tx.delete(loginCode).where(eq(loginCode.email, email));
        ended = true;
      } else await tx.update(loginCode).set({ attempts: row.attempts + 1 }).where(eq(loginCode.email, email));
      await countFailure(email, tx);
      return { error: "invalid_code" };
    }
    await tx.delete(loginCode).where(eq(loginCode.email, email));
    ended = true;
    return (await signInByEmail(email, tx)) ?? { error: "invalid_code" };
  });
  if (ended) dropTelegramCode(email);
  return result;
}

/**
 * Checks a sign-in link: single use, until its row expires, only for its address. A wrong secret changes nothing (256
 * bits leave nothing to guess, and counting would let anyone void the person's link); every failure reads the same.
 */
export async function verifyLink(rawEmail: string, secret: string): Promise<{ userId: string } | null> {
  const email = normalizeEmail(rawEmail);
  if (!LINK_SECRET.test(secret)) return null;
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(loginCode).where(eq(loginCode.email, email)).for("update");
    if (!row || Date.parse(row.expiresAt) <= Date.now() || !sameSecret(LINK + hashCode(email, secret), row.codeHash)) return null;
    await tx.delete(loginCode).where(eq(loginCode.email, email));
    return signInByEmail(email, tx);
  });
}

/**
 * Who a used-up code or link signs in, checked again: the member may have been removed, or the invite revoked, since
 * it was sent. An invited address without an account gets one now.
 */
async function signInByEmail(email: string, tx: Tx): Promise<{ userId: string } | null> {
  const u = await memberByEmail(email, tx);
  if (u) return { userId: u.id };
  if (!(await maySignInByEmail(email, tx))) return null;
  await tx.insert(user).values({ email, name: nameFromEmail(email), kind: "human" }).onConflictDoNothing();
  const [created] = await tx.select({ id: user.id, kind: user.kind }).from(user).where(eq(dsql`lower(${user.email})`, email));
  return created?.kind === "human" ? { userId: created.id } : null;
}

/** Deletes codes past their time and failures older than a day; run now and then (main.ts). */
export async function sweepCodes(): Promise<void> {
  await db.delete(loginCode).where(lt(loginCode.expiresAt, new Date().toISOString()));
  await db.delete(loginFailure).where(lt(loginFailure.at, new Date(Date.now() - DAY_MS).toISOString()));
}
