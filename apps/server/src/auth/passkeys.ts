// Passkeys: options for the browser, single-use challenges, stored credentials. The cryptography is in webauthn.ts.
//
// The relying party is the page's own origin: its host name is the RP ID. A passkey made on one host (production) does not
// work on another (a dev server), which is how WebAuthn scopes keys anyway. Challenges live in memory for five minutes:
// one process serves sign-in (PLNR-11 would move them to the database).
//
// The table is bounded, and each client holds at most PER_OWNER live challenges of it, its oldest going first (RSVA-600):
// a client asking again and again pushes out only its own, and filling the table to push out everyone's takes a
// thousand clients (an IPv6 one counts by its /64) within the five minutes, not one. Considered: a table per purpose
// (keeps registration safe, not sign-in); challenges signed by the server and kept only once used, which needs no table
// per ceremony at all, but moves the single-use check after the signature and is a larger change to this path.
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { ALGORITHMS, b64u, verifyAssertion, verifyRegistration, WebAuthnError, type AssertionJSON, type RegistrationJSON } from "./webauthn.ts";

const { passkey, user } = schema;

const CHALLENGE_MS = 5 * 60_000;
const TIMEOUT_MS = 120_000;
const MAX_PASSKEYS = 20;

/** The page the ceremony runs on. */
export interface RelyingParty {
  origin: string;
  rpId: string;
}

interface Challenge extends RelyingParty {
  purpose: "register" | "login";
  userId: string | null;
  expires: number;
  /** Who asked: the client's key for a sign-in, the person for a registration. */
  owner: string;
}
const MAX_CHALLENGES = 10_000;
/** Live challenges one owner holds: a person needs one or two; ten people behind one address still fit. */
const PER_OWNER = 10;
const challenges = new Map<string, Challenge>();
/** Each owner's challenges, oldest first. In the order of `challenges`, so the oldest there is its owner's oldest too. */
const byOwner = new Map<string, string[]>();

function drop(challenge: string): void {
  const c = challenges.get(challenge);
  if (!c) return;
  challenges.delete(challenge);
  const mine = byOwner.get(c.owner)!;
  mine.splice(mine.indexOf(challenge), 1);
  if (!mine.length) byOwner.delete(c.owner);
}

function issue(c: Omit<Challenge, "expires">): string {
  const now = Date.now();
  // Expired ones lead the table: they were issued first.
  for (const [k, v] of challenges) {
    if (v.expires > now) break;
    drop(k);
  }
  const mine = byOwner.get(c.owner);
  if (mine && mine.length >= PER_OWNER) drop(mine[0]!);
  // Still full (unused ceremonies from many clients): the oldest go first.
  if (challenges.size >= MAX_CHALLENGES) drop(challenges.keys().next().value!);
  const challenge = b64u.encode(randomBytes(32));
  challenges.set(challenge, { ...c, expires: now + CHALLENGE_MS });
  byOwner.set(c.owner, [...(mine ?? []), challenge]);
  return challenge;
}

/** Takes a challenge out (single use) if it is live and was issued for this purpose, user and page. */
function consume(clientDataJSON: unknown, purpose: Challenge["purpose"], rp: RelyingParty, userId: string | null): string {
  let challenge: unknown;
  try {
    challenge = (JSON.parse(b64u.decode(clientDataJSON).toString("utf8")) as { challenge?: unknown }).challenge;
  } catch {
    throw new WebAuthnError("client data is not JSON");
  }
  const c = typeof challenge === "string" ? challenges.get(challenge) : undefined;
  if (!c) throw new WebAuthnError("unknown or used challenge");
  drop(challenge as string);
  if (c.expires <= Date.now() || c.purpose !== purpose || c.userId !== userId || c.origin !== rp.origin || c.rpId !== rp.rpId)
    throw new WebAuthnError("the challenge was issued for something else");
  return challenge as string;
}

/** User handle: the user's UUID as 16 bytes. */
const userHandle = (id: string) => b64u.encode(Buffer.from(id.replaceAll("-", ""), "hex"));

/** PublicKeyCredentialCreationOptions in JSON form (binary fields base64url). */
export async function registrationOptions(userId: string, rp: RelyingParty) {
  const [u] = await db.select({ email: user.email, name: user.name }).from(user).where(eq(user.id, userId));
  const existing = await db.select({ id: passkey.id, transports: passkey.transports }).from(passkey).where(eq(passkey.userId, userId));
  return {
    challenge: issue({ purpose: "register", userId, owner: `user:${userId}`, ...rp }),
    rp: { id: rp.rpId, name: "recursiva" },
    user: { id: userHandle(userId), name: u!.email, displayName: u!.name || u!.email },
    pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: existing.map((c) => ({ type: "public-key", id: c.id, transports: c.transports })),
    attestation: "none",
    timeout: TIMEOUT_MS,
  };
}

export async function finishRegistration(userId: string, r: RegistrationJSON, name: string, rp: RelyingParty): Promise<{ id: string; name: string }> {
  const challenge = consume(r?.clientDataJSON, "register", rp, userId);
  const cred = verifyRegistration(r, { challenge, ...rp });
  const count = (await db.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, userId))).length;
  if (count >= MAX_PASSKEYS) throw new WebAuthnError(`at most ${MAX_PASSKEYS} passkeys per person`);
  const [row] = await db
    .insert(passkey)
    .values({ ...cred, userId, name: name.trim().slice(0, 100) || "Passkey" })
    .onConflictDoNothing()
    .returning({ id: passkey.id, name: passkey.name });
  if (!row) throw new WebAuthnError("this passkey is already registered");
  return row;
}

/**
 * Options for a sign-in with any passkey of this site: the browser offers the ones it has (discoverable credentials).
 * `client`: the asker's clientKey, which holds a share of the live challenges.
 */
export function loginOptions(rp: RelyingParty, client: string) {
  return { challenge: issue({ purpose: "login", userId: null, owner: client, ...rp }), rpId: rp.rpId, userVerification: "required", timeout: TIMEOUT_MS };
}

/** Verifies a sign-in and returns whose passkey it was. */
export async function finishLogin(r: AssertionJSON, rp: RelyingParty): Promise<string> {
  const challenge = consume(r?.clientDataJSON, "login", rp, null);
  const [cred] = typeof r.id === "string" ? await db.select().from(passkey).where(eq(passkey.id, r.id)) : [];
  if (!cred) throw new WebAuthnError("unknown passkey");
  if (r.userHandle && r.userHandle !== userHandle(cred.userId)) throw new WebAuthnError("the passkey belongs to someone else");
  const signCount = verifyAssertion(r, cred, { challenge, ...rp });
  await db.update(passkey).set({ signCount, lastUsedAt: new Date().toISOString() }).where(eq(passkey.id, cred.id));
  return cred.userId;
}

export async function listPasskeys(userId: string) {
  return db
    .select({ id: passkey.id, name: passkey.name, createdAt: passkey.createdAt, lastUsedAt: passkey.lastUsedAt })
    .from(passkey)
    .where(eq(passkey.userId, userId))
    .orderBy(passkey.createdAt);
}

export async function deletePasskey(userId: string, id: string): Promise<boolean> {
  const rows = await db.delete(passkey).where(and(eq(passkey.id, id), eq(passkey.userId, userId))).returning({ id: passkey.id });
  return rows.length > 0;
}
