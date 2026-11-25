// Web Push (RSVA-647): a message to a browser's push service, encrypted for the device (RFC 8291, aes128gcm) and signed
// as this server (VAPID, RFC 8292), in node:crypto alone.
//
// Compared: the `web-push` package (four dependencies, asn1.js, bn.js and jws among them, bundled into dist/main.js, whose
// size and start-up are measured, build.ts) and these hundred lines over node:crypto, which has ECDH on P-256, HKDF,
// AES-GCM and ES256 already. The encryption is checked against RFC 8291's own example (web-push.test.ts).
//
// The keys are the server's: RSVA_VAPID_PUBLIC_KEY (the uncompressed P-256 point, 65 bytes) and RSVA_VAPID_PRIVATE_KEY
// (32 bytes), both base64url, the format `web-push generate-vapid-keys` prints too. A browser subscribes with the public
// one, and its push service takes messages for that subscription only when they are signed by the private one: a copy of
// the database without the keys sends nothing to anybody's phone.
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign, type ECDH, type KeyObject } from "node:crypto";
import { PUBLIC_ORIGIN } from "../auth/mail.ts";

/** Where a push goes: the browser's subscription, as PushSubscription.toJSON() gives it. */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** The push service's answer: 201 delivered, 404 or 410 the subscription is gone, 413 too large, 429 too many. */
export interface PushApi {
  /** The VAPID public key a browser subscribes with. */
  publicKey: string;
  send(to: PushTarget, payload: string): Promise<number>;
}

/** A record of this size holds any payload we send: the header says so, and the device reads one record. */
const RECORD = 4096;
/** What a payload may weigh: one record less its padding delimiter and the AES-GCM tag. */
export const PAYLOAD_MAX = RECORD - 17;
/** A signature good for twelve hours: the push services refuse one longer than a day. */
const JWT_MS = 12 * 3_600_000;
const SEND_TIMEOUT_MS = 10_000;
/**
 * How long a push service keeps a message for a device that is offline, seconds: a day, as the outbox keeps its rows
 * (send.ts, MAX_AGE_MS).
 */
const TTL_S = 86_400;

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const info = (s: string) => Buffer.from(`${s}\0`, "latin1");

/**
 * The aes128gcm body for one device (RFC 8291 section 3 and RFC 8188): a header with the salt, the record size and the
 * sender's one-time public key, then the payload sealed under a key both sides derive from ECDH and the device's secret.
 * `sender` and `salt` are fresh for every message; a test passes the RFC's to check the result.
 */
export function encrypt(payload: Uint8Array, uaPublic: Buffer, authSecret: Buffer, sender: ECDH = newSender(), salt: Buffer = randomBytes(16)): Buffer {
  const asPublic = sender.getPublicKey();
  const ikm = Buffer.from(hkdfSync("sha256", sender.computeSecret(uaPublic), authSecret, Buffer.concat([info("WebPush: info"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, info("Content-Encoding: aes128gcm"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, info("Content-Encoding: nonce"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // The last (and only) record ends with the delimiter 0x02 and no padding.
  const sealed = Buffer.concat([cipher.update(payload), cipher.update(Buffer.of(2)), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, sealed]);
}

function newSender(): ECDH {
  const e = createECDH("prime256v1");
  e.generateKeys();
  return e;
}

/** The server's VAPID key as a signing key: the JWK of its point and secret. */
export function vapidKey(publicKey: string, privateKey: string): KeyObject {
  const point = Buffer.from(publicKey, "base64url");
  const d = Buffer.from(privateKey, "base64url");
  if (point.length !== 65 || point[0] !== 4 || d.length !== 32) throw new Error("VAPID keys: a 65-byte public point and a 32-byte private key, base64url");
  return createPrivateKey({ key: { kty: "EC", crv: "P-256", x: b64(point.subarray(1, 33)), y: b64(point.subarray(33)), d: b64(d) }, format: "jwk" });
}

/** The Authorization header for a push service (RFC 8292): a JWT for its origin, signed ES256, and the public key. */
export function vapidAuth(endpoint: string, key: KeyObject, publicKey: string, subject: string, now = Date.now()): string {
  const head = b64(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor((now + JWT_MS) / 1000), sub: subject })));
  const signature = sign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${claims}.${b64(signature)}, k=${publicKey}`;
}

/** A sender over fetch with the server's keys. */
function pushApi(publicKey: string, privateKey: string, subject: string): PushApi {
  const key = vapidKey(publicKey, privateKey);
  return {
    publicKey,
    async send(to, payload) {
      const body = encrypt(Buffer.from(payload), Buffer.from(to.p256dh, "base64url"), Buffer.from(to.auth, "base64url"));
      const res = await fetch(to.endpoint, {
        method: "POST",
        headers: {
          authorization: vapidAuth(to.endpoint, key, publicKey, subject),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(TTL_S),
          // Everything sent is what the person asked for Instantly: "high" wakes a phone that is saving battery.
          urgency: "high",
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      await res.body?.cancel();
      return res.status;
    },
  };
}

/**
 * The server's push, from RSVA_VAPID_PUBLIC_KEY and RSVA_VAPID_PRIVATE_KEY; none without them. The subject, whom the
 * push services may write to about this server, is its public origin.
 */
export function pushFromEnv(env: NodeJS.ProcessEnv = process.env): PushApi | null {
  const publicKey = env.RSVA_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.RSVA_VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  return pushApi(publicKey, privateKey, PUBLIC_ORIGIN ?? "https://rsva.dev");
}
