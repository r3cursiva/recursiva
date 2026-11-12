// Changing the sign-in email (PLNR-197, docs/decisions/0033-email-change.md).
//
// The email is how a person signs in, so a stolen session must not be able to take the account by changing it:
// - asking for a change needs a fresh sign-in (routes.ts, FRESH_MS), as adding a passkey does;
// - the change happens only after the code sent to the new address is typed: six digits, ten minutes, five guesses, and
//   the wrong ones count towards that address's daily cap (codes.ts), so a code is no easier to guess here;
// - the replaced address gets a mail with a link that puts it back and ends every session, for 7 days: whoever took the
//   account cannot keep it from its owner, who no longer gets sign-in codes. It also removes the passkeys and API tokens
//   made from the start of that fresh sign-in on, and the personal Telegram chat: none of them is left as a way back in.
//
// An address that already has an account gets a mail saying so instead of a code, and the request answers as for any
// other address: the person asking learns nothing a sign-in form would not tell them, and the address's owner learns
// someone tried. Their row holds a hash nobody knows, so a guess there reads as a wrong code.
//
// The address lives in `user`, which every workspace's snapshot carries: as a new name does (account.ts), it reaches
// every workspace of the person as a User action, all of them in one transaction with the row. Open invites to the old
// address move to the new one: they were sent to this person, and an account that has only invites keeps its session.
import { randomBytes, randomInt } from "node:crypto";
import { and, eq, gte, inArray, sql as dsql } from "drizzle-orm";
import { db, schema, type Tx } from "../db.ts";
import { emailChangedMail, emailCodeMail, emailRevertedMail, emailTakenMail } from "../mail/emails.ts";
import { unlinkChat } from "../telegram/chats.ts";
import { uniqueViolation } from "../sync/retry.ts";
import { TxError } from "../sync/tx-error.ts";
import { changeOwnRow } from "./account.ts";
import { capped, countFailure, normalizeEmail } from "./codes.ts";
import { openInvite } from "./eligibility.ts";
import type { Mail } from "./mail.ts";
import { randomSecret, sameSecret, sha256 } from "./secret.ts";
import { deleteSessionsIn, forgetUser, FRESH_MS } from "./sessions.ts";
import { forgetTokens, revokeTokensSince } from "./tokens.ts";

const { emailChange, emailRevert, invite, loginCode, passkey, user } = schema;

const CODE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
/** How long the link back works. */
const REVERT_MS = 7 * 86_400_000;
/** A link back's secret: randomSecret()'s 43 base64url characters. */
export const REVERT_SECRET = /^[A-Za-z0-9_-]{43}$/;

/** Bound to the person and the address: a code for one change confirms no other. */
const hashCode = (userId: string, email: string, code: string) => sha256(`email-change\n${userId}\n${email}\n${code}`);

/** Whoever has an account with this (lower-cased) address, of any kind, or null. */
async function holder(email: string, q: Tx | typeof db = db): Promise<string | null> {
  const [u] = await q.select({ id: user.id }).from(user).where(eq(dsql`lower(${user.email})`, email)).limit(1);
  return u?.id ?? null;
}

/**
 * Step 1: a new code for this person and address, replacing any earlier one. Returns the mail to send (a code, or the
 * "already has an account" notice), or null when the address is the person's own already.
 */
export async function requestEmailChange(userId: string, rawEmail: string, origin: string): Promise<Mail | null> {
  const email = normalizeEmail(rawEmail);
  const [me] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  if (me!.email.toLowerCase() === email) return null;
  const taken = (await holder(email)) !== null;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const row = {
    email,
    codeHash: taken ? randomBytes(32).toString("base64url") : hashCode(userId, email, code),
    attempts: 0,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + CODE_MS).toISOString(),
  };
  await db.insert(emailChange).values({ userId, ...row }).onConflictDoUpdate({ target: emailChange.userId, set: row });
  return taken ? emailTakenMail(email, origin) : emailCodeMail(email, code, new Date(row.expiresAt), origin);
}

export type ChangeResult = { from: string; to: string; mail: Mail } | { error: "invalid_code" | "expired_code" | "email_taken" };

/**
 * Step 2: a right code changes the address and returns the mail for the old one, with its link back. A wrong code
 * counts, and the fifth ends the change. An address taken since the code went out is refused, the code used up.
 */
export async function confirmEmailChange(userId: string, code: string, userAgent: string, origin: string): Promise<ChangeResult> {
  const checked = await db.transaction(async (tx): Promise<{ email: string; from: string } | { error: "invalid_code" | "expired_code" }> => {
    const [row] = await tx.select().from(emailChange).where(eq(emailChange.userId, userId)).for("update");
    if (!row) return { error: "expired_code" };
    if (Date.parse(row.expiresAt) <= Date.now()) {
      await tx.delete(emailChange).where(eq(emailChange.userId, userId));
      return { error: "expired_code" };
    }
    if (await capped(row.email, tx)) return { error: "invalid_code" };
    if (!/^\d{6}$/.test(code) || !sameSecret(hashCode(userId, row.email, code), row.codeHash)) {
      if (row.attempts + 1 >= MAX_ATTEMPTS) await tx.delete(emailChange).where(eq(emailChange.userId, userId));
      else await tx.update(emailChange).set({ attempts: row.attempts + 1 }).where(eq(emailChange.userId, userId));
      await countFailure(row.email, tx);
      return { error: "invalid_code" };
    }
    await tx.delete(emailChange).where(eq(emailChange.userId, userId));
    const [u] = await tx.select({ email: user.email }).from(user).where(eq(user.id, userId));
    return { email: row.email, from: u!.email };
  });
  if ("error" in checked) return checked;

  const secret = randomSecret();
  try {
    const from = await setEmail(userId, checked.email, async (tx, old) => {
      // A link back used since the code was checked put another address on the account: this change is void, or it
      // would undo what the owner just took back.
      if (old !== checked.from) throw new TxError("expired_code", "changed meanwhile");
      await tx.insert(emailRevert).values({ hash: sha256(secret), userId, oldEmail: old.toLowerCase(), newEmail: checked.email, expiresAt: new Date(Date.now() + REVERT_MS).toISOString() });
    });
    const revert = `${origin}/#${new URLSearchParams({ "email-revert": secret })}`;
    return { from, to: checked.email, mail: emailChangedMail({ to: from, newEmail: checked.email, userAgent, revert, origin }) };
  } catch (e) {
    if (e instanceof TxError && (e.code === "email_taken" || e.code === "expired_code")) return { error: e.code };
    throw e;
  }
}

/** What taking back a change removed: keys to the account made since the session that changed the address could make them. */
interface Removed {
  passkeys: number;
  tokens: number;
  telegram: number;
}

export type RevertResult = { userId: string; restored: string; removed: Removed; ended: string[]; mail: Mail | null } | { error: "invalid_link" | "email_taken" };

/**
 * The link from the old address: puts it back, whatever the address is now (a second change does not void the first
 * link), and voids the links made after it, so the addresses that came later cannot undo this; earlier links stay.
 * Removes the keys made since the change's fresh sign-in could begin and ends every session; the caller closes their
 * sockets (`ended`). Returns the mail for the address that was on the account.
 */
export async function revertEmailChange(secret: string, origin: string): Promise<RevertResult> {
  if (!REVERT_SECRET.test(secret)) return { error: "invalid_link" };
  const [row] = await db
    .select()
    .from(emailRevert)
    .where(and(eq(emailRevert.hash, sha256(secret)), dsql`${emailRevert.expiresAt} > now()`));
  if (!row) return { error: "invalid_link" };
  // The change was asked for from a sign-in at most FRESH_MS old (routes.ts) and confirmed at most CODE_MS later: the
  // session behind it signed in no earlier than that, and passkeys and tokens need a fresh sign-in. Earlier ones were
  // made by someone who could sign in as the owner anyway. The personal Telegram chat goes whenever it was linked:
  // sign-in codes go there, and until PLNR-223 linking took a session of any age.
  const since = new Date(Date.parse(row.createdAt) - FRESH_MS - CODE_MS).toISOString();
  const removed: Removed = { passkeys: 0, tokens: 0, telegram: 0 };
  let revoked: string[] = [];
  let ended: string[] = [];
  try {
    const from = await setEmail(row.userId, row.oldEmail, async (tx) => {
      // This link and the ones made after it go; older ones stay. Otherwise whoever took the address could change it once
      // more, use the link that mail brings them, and void the owner's link to the first address. Racing uses: the first
      // to delete its row wins.
      const gone = await tx
        .delete(emailRevert)
        .where(and(eq(emailRevert.userId, row.userId), dsql`${emailRevert.createdAt} >= ${row.createdAt}`))
        .returning({ hash: emailRevert.hash });
      if (!gone.some((g) => g.hash === row.hash)) throw new TxError("invalid_link", "used");
      await tx.delete(emailChange).where(eq(emailChange.userId, row.userId));
      removed.passkeys = (await tx.delete(passkey).where(and(eq(passkey.userId, row.userId), gte(passkey.createdAt, since))).returning({ id: passkey.id })).length;
      revoked = await revokeTokensSince(tx, row.userId, since);
      removed.tokens = revoked.length;
      removed.telegram = await unlinkChat(tx, row.userId, since);
      // In the same transaction: a session that is still live cannot add a key after the keys went.
      ended = await deleteSessionsIn(tx, row.userId);
    });
    forgetTokens(revoked);
    forgetUser(row.userId);
    return { userId: row.userId, restored: row.oldEmail, removed, ended, mail: from.toLowerCase() === row.oldEmail ? null : emailRevertedMail(from, row.oldEmail, origin) };
  } catch (e) {
    if (e instanceof TxError && (e.code === "email_taken" || e.code === "invalid_link")) return { error: e.code };
    throw e;
  }
}

/**
 * Sets the person's address and moves their open invites with it, in every workspace's log; `also` runs in the same
 * transaction with the address being replaced. Returns that address. TxError email_taken if another account has `to`.
 * Outside the limit on changes of one's own row (account.ts): the codes bound it, and taking back must never wait.
 */
async function setEmail(userId: string, to: string, also: (tx: Tx, from: string) => Promise<void>): Promise<string> {
  let from = "";
  try {
    await changeOwnRow(userId, async (tx) => {
      const [u] = await tx.select({ email: user.email }).from(user).where(eq(user.id, userId)).for("update");
      from = u!.email;
      const other = await holder(to, tx);
      if (other && other !== userId) throw new TxError("email_taken", "That address already has an account.");
      await also(tx, from);
      if (from === to) return null;
      await tx.update(user).set({ email: to }).where(eq(user.id, userId));
      await moveInvites(tx, from.toLowerCase(), to);
      // A sign-in code on its way to the old address signs nobody in any more; this drops it now.
      await tx.delete(loginCode).where(eq(loginCode.email, from.toLowerCase()));
      return { d: { email: to }, p: { email: from } };
    }, { limited: false });
  } catch (e) {
    // Two accounts taking one address at once: the unique index stops the second.
    if (uniqueViolation(e)) throw new TxError("email_taken", "That address already has an account.");
    throw e;
  }
  return from;
}

/** Open invites to `from` go to `to`; where `to` has an open invite of its own in that workspace, that one stays. */
async function moveInvites(tx: Tx, from: string, to: string): Promise<void> {
  const theirs = tx.select({ ws: invite.workspaceId }).from(invite).where(and(eq(invite.email, to), openInvite()));
  await tx.update(invite).set({ revokedAt: dsql`now()` }).where(and(eq(invite.email, from), openInvite(), inArray(invite.workspaceId, theirs)));
  await tx.update(invite).set({ email: to }).where(and(eq(invite.email, from), openInvite()));
}

/** Deletes changes and links back past their time; run now and then (main.ts). */
export async function sweepEmailChanges(): Promise<void> {
  await db.delete(emailChange).where(dsql`${emailChange.expiresAt} < now()`);
  await db.delete(emailRevert).where(dsql`${emailRevert.expiresAt} < now()`);
}
