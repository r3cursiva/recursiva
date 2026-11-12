// WebAuthn checks for passkeys on node:crypto alone (docs/decisions/0009-sign-in.md: @simplewebauthn/server brings ten
// packages, most of them to verify attestation certificates we do not ask for).
//
// Registration asks for no attestation. The browser then reports the new public key itself (getPublicKey(): SPKI DER) and
// the authenticator data separately, so no CBOR has to be read: the key is whatever the user's own authenticator
// produced, which is all attestation "none" could prove anyway. Every assertion is then verified against that key.
//
// Checked on both: the client data's type, the challenge (issued here, single use), the origin; the authenticator data's
// RP ID hash and the user-present and user-verified flags. A passkey is the whole sign-in, so user verification
// (biometrics or PIN) is required, not preferred.
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

/** ES256, EdDSA, RS256: what browsers create and node:crypto verifies. */
export const ALGORITHMS = [-7, -8, -257] as const;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class WebAuthnError extends Error {}

const fail = (msg: string): never => {
  throw new WebAuthnError(msg);
};

export const b64u = {
  decode: (s: unknown): Buffer => (typeof s === "string" && /^[A-Za-z0-9_-]*$/.test(s) ? Buffer.from(s, "base64url") : fail("not base64url")),
  encode: (b: Uint8Array): string => Buffer.from(b).toString("base64url"),
};

export interface Expected {
  /** The challenge this server issued, base64url. */
  challenge: string;
  origin: string;
  rpId: string;
}

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

function checkClientData(raw: Buffer, type: "webauthn.create" | "webauthn.get", exp: Expected): void {
  let c: ClientData;
  try {
    c = JSON.parse(raw.toString("utf8")) as ClientData;
  } catch {
    return fail("client data is not JSON");
  }
  if (c.type !== type) fail(`client data type is ${String(c.type)}`);
  if (c.challenge !== exp.challenge) fail("the challenge does not match");
  if (c.origin !== exp.origin) fail("the origin does not match");
}

interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  /** Present when the AT flag is set (registration). */
  credentialId?: Buffer;
}

function parseAuthData(b: Buffer): AuthData {
  if (b.length < 37) fail("authenticator data is too short");
  const flags = b[32]!;
  const out: AuthData = { rpIdHash: b.subarray(0, 32), flags, signCount: b.readUInt32BE(33) };
  if (flags & FLAG_AT) {
    // aaguid (16 bytes), credential id length (2), credential id, then the COSE key we do not need to read.
    if (b.length < 55) fail("attested credential data is too short");
    const len = b.readUInt16BE(53);
    if (len > 1023 || b.length < 55 + len) fail("bad credential id length");
    out.credentialId = b.subarray(55, 55 + len);
  }
  return out;
}

function checkAuthData(a: AuthData, exp: Expected): void {
  if (!a.rpIdHash.equals(createHash("sha256").update(exp.rpId).digest())) fail("the RP ID does not match");
  if (!(a.flags & FLAG_UP)) fail("the user was not present");
  if (!(a.flags & FLAG_UV)) fail("the user was not verified");
}

/** What the browser sends after navigator.credentials.create(), base64url fields (apps/web/src/passkeys.ts). */
export interface RegistrationJSON {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  publicKey: string;
  publicKeyAlgorithm: number;
  transports?: string[];
}

export interface NewCredential {
  id: string;
  publicKey: string;
  algorithm: number;
  signCount: number;
  transports: string[];
}

function keyFor(spki: Buffer, alg: number): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    return fail("the public key cannot be read");
  }
  const want = alg === -7 ? "ec" : alg === -8 ? "ed25519" : alg === -257 ? "rsa" : null;
  if (!want || key.asymmetricKeyType !== want) fail(`unsupported key ${String(key.asymmetricKeyType)} for algorithm ${alg}`);
  if (alg === -7 && key.asymmetricKeyDetails?.namedCurve !== "prime256v1") fail("ES256 needs a P-256 key");
  if (alg === -257 && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail("the RSA key is too short");
  return key;
}

export function verifyRegistration(r: RegistrationJSON, exp: Expected): NewCredential {
  checkClientData(b64u.decode(r.clientDataJSON), "webauthn.create", exp);
  const auth = parseAuthData(b64u.decode(r.authenticatorData));
  checkAuthData(auth, exp);
  const id = b64u.decode(r.id);
  if (!auth.credentialId || !auth.credentialId.equals(id)) fail("the credential id does not match the authenticator data");
  const spki = b64u.decode(r.publicKey);
  keyFor(spki, r.publicKeyAlgorithm);
  const transports = Array.isArray(r.transports) ? r.transports.filter((t): t is string => typeof t === "string" && t.length < 20).slice(0, 8) : [];
  return { id: r.id, publicKey: b64u.encode(spki), algorithm: r.publicKeyAlgorithm, signCount: auth.signCount, transports };
}

/** What the browser sends after navigator.credentials.get(), base64url fields. */
export interface AssertionJSON {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle?: string | null;
}

export interface StoredCredential {
  publicKey: string;
  algorithm: number;
  signCount: number;
}

/** Verifies a sign-in; returns the authenticator's new signature counter. */
export function verifyAssertion(r: AssertionJSON, cred: StoredCredential, exp: Expected): number {
  const clientData = b64u.decode(r.clientDataJSON);
  checkClientData(clientData, "webauthn.get", exp);
  const authRaw = b64u.decode(r.authenticatorData);
  const auth = parseAuthData(authRaw);
  checkAuthData(auth, exp);
  const key = keyFor(b64u.decode(cred.publicKey), cred.algorithm);
  const signed = Buffer.concat([authRaw, createHash("sha256").update(clientData).digest()]);
  const sig = b64u.decode(r.signature);
  const ok = cred.algorithm === -8 ? verify(null, signed, key, sig) : verify("sha256", signed, key, sig);
  if (!ok) fail("the signature is wrong");
  // Counters only grow on authenticators that keep one; synced passkeys always report 0. A counter that went back
  // means a cloned authenticator.
  if (auth.signCount !== 0 && auth.signCount <= cred.signCount) fail("the signature counter went back: the authenticator may be cloned");
  return auth.signCount;
}
