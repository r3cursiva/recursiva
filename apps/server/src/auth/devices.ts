// Browsers a person has signed in from (PLNR-252). A sign-in from a browser this person has not signed in from sends a
// security email to the account address, whatever the notification rules say.
//
// A browser is known by a random token in an HttpOnly cookie of its own (actor.ts, deviceCookie), set at every
// sign-in and left in place by signing out; the server keeps its hash per person. Considered (2026-11-04):
// - The session's User-Agent against the person's other sessions: no table, but signing out deletes the session, so
//   the same browser reads as new at its next sign-in; a browser update changes the string (Chrome every four weeks),
//   and a thief who copies it is never new.
// - A signed cookie (HMAC of the person and a nonce), no table either: needs a server key that the stands do not have
//   yet, a new secret in production.
// The cookie with a row per person and browser costs one upsert at a sign-in from a known browser, and a read besides
// from a new one.
//
// Whether a person has signed in before is not read from their sessions: those end after 30 idle days, and the first
// sign-in after that would read as the account's first and stay quiet (security review, 2026-11-04).
import { and, eq, exists, gt, lt, ne, or, sql as dsql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema } from "../db.ts";
import { randomSecret, sha256 } from "./secret.ts";

const { signInDevice } = schema;

/** How long a browser stays known after its last sign-in: the cookie's Max-Age, at the 400 days browsers allow. */
export const DEVICE_MS = 400 * 86_400_000;

/** A device token as the cookie holds it: what randomSecret makes. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface DeviceCheck {
  /** The token the browser keeps: its own, or a new one. */
  token: string;
  /** Whether the sign-in comes from a browser this person had not signed in from, and is not their first ever. */
  isNew: boolean;
}

/**
 * Remembers the browser for this person at a sign-in. `sameBrowser`: the request carried this person's live session
 * (a "confirm it's you" sign-in), so the browser is theirs even without the cookie, as every browser signed in before
 * PLNR-252 is. A person with no row at all signs in for the first time: nothing to warn about. Everyone who existed
 * before PLNR-252 has a row and the sweep keeps one per person (SIGNED_IN_BEFORE), so "no row" means just that: a
 * person whose sessions have all ended still hears of a new browser.
 */
export async function checkDevice(userId: string, cookieToken: string | undefined, sameBrowser: boolean): Promise<DeviceCheck> {
  const token = cookieToken && TOKEN.test(cookieToken) ? cookieToken : randomSecret();
  const id = sha256(token);
  // xmax is 0 on a row this statement inserted, not on one it updated: a known browser costs this one statement.
  const [row] = await db
    .insert(signInDevice)
    .values({ userId, id })
    .onConflictDoUpdate({ target: [signInDevice.userId, signInDevice.id], set: { lastSeenAt: dsql`now()` } })
    .returning({ inserted: dsql<boolean>`xmax = 0` });
  if (!row!.inserted || sameBrowser) return { token, isNew: false };
  const [other] = await db
    .select({ id: signInDevice.id })
    .from(signInDevice)
    .where(and(eq(signInDevice.userId, userId), ne(signInDevice.id, id)))
    .limit(1);
  return { token, isNew: other !== undefined };
}

/**
 * Whether this person has signed in from the browser holding this token, and it is not forgotten yet: a sign-in code
 * goes to their Telegram only then (RSVA-464). Reads, writes nothing: asking for a code is not a sign-in.
 */
export async function knownDevice(userId: string, cookieToken: string | undefined): Promise<boolean> {
  if (!cookieToken || !TOKEN.test(cookieToken)) return false;
  const [row] = await db
    .select({ id: signInDevice.id })
    .from(signInDevice)
    .where(and(eq(signInDevice.userId, userId), eq(signInDevice.id, sha256(cookieToken))))
    .limit(1);
  return row !== undefined;
}

/**
 * The row that says a person has signed in before, with no browser behind it: no token hashes to it (a hash is 43
 * characters). Migration 0030 gives one to everyone who existed before PLNR-252; the sweep turns a person's last
 * browser into it.
 */
export const SIGNED_IN_BEFORE = "signed-in-before";

/**
 * Forgets browsers unseen for DEVICE_MS. A person's latest row is not deleted but becomes SIGNED_IN_BEFORE: the
 * browser is forgotten, the history is not. Run with sweepSessions (main.ts).
 */
export async function sweepDevices(): Promise<void> {
  const cutoff = new Date(Date.now() - DEVICE_MS).toISOString();
  const newer = alias(signInDevice, "newer");
  // Ties go by id, so exactly one row of a person is the latest.
  const later = or(gt(newer.lastSeenAt, signInDevice.lastSeenAt), and(eq(newer.lastSeenAt, signInDevice.lastSeenAt), gt(newer.id, signInDevice.id)));
  await db
    .delete(signInDevice)
    .where(and(lt(signInDevice.lastSeenAt, cutoff), exists(db.select({ one: dsql`1` }).from(newer).where(and(eq(newer.userId, signInDevice.userId), later)))));
  await db
    .update(signInDevice)
    .set({ id: SIGNED_IN_BEFORE })
    .where(and(lt(signInDevice.lastSeenAt, cutoff), ne(signInDevice.id, SIGNED_IN_BEFORE)));
}
