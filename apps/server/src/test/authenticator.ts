// A software passkey authenticator for tests: makes the same registration and assertion fields a browser sends
// (apps/web/src/passkeys.ts), signed with a real key, so the server's WebAuthn checks run end to end.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

export interface Tamper {
  origin?: string;
  rpId?: string;
  type?: string;
  /** Authenticator flags; default user present and verified. */
  flags?: number;
  challenge?: string;
  signCount?: number;
}

export class SoftAuthenticator {
  readonly id = randomBytes(16);
  private readonly key: KeyObject;
  private readonly spki: Buffer;
  readonly alg: -7 | -8;
  private userHandle = "";
  count = 0;

  constructor(kind: "ES256" | "EdDSA" = "ES256") {
    const pair = kind === "ES256" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("ed25519");
    this.key = pair.privateKey;
    this.spki = pair.publicKey.export({ format: "der", type: "spki" });
    this.alg = kind === "ES256" ? -7 : -8;
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  private authData(rpId: string, flags: number, signCount: number, attested: boolean): Buffer {
    const head = Buffer.alloc(37);
    sha256(rpId).copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(signCount, 33);
    if (!attested) return head;
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.id.length);
    // aaguid, then the credential id; the COSE key would follow, and the server does not read it.
    return Buffer.concat([head, Buffer.alloc(16), len, this.id]);
  }

  /** The answer to navigator.credentials.create() for these options. */
  register(options: { challenge: string; rp: { id: string }; user: { id: string } }, origin: string, t: Tamper = {}) {
    this.userHandle = options.user.id;
    return {
      id: b64u(this.id),
      clientDataJSON: b64u(this.clientData(t.type ?? "webauthn.create", t.challenge ?? options.challenge, t.origin ?? origin)),
      authenticatorData: b64u(this.authData(t.rpId ?? options.rp.id, t.flags ?? 0x45, 0, true)),
      publicKey: b64u(this.spki),
      publicKeyAlgorithm: this.alg,
      transports: ["internal"],
    };
  }

  /** The answer to navigator.credentials.get() for these options. */
  assert(options: { challenge: string; rpId: string }, origin: string, t: Tamper = {}) {
    if (t.signCount === undefined) this.count++;
    const clientData = this.clientData(t.type ?? "webauthn.get", t.challenge ?? options.challenge, t.origin ?? origin);
    const authData = this.authData(t.rpId ?? options.rpId, t.flags ?? 0x05, t.signCount ?? this.count, false);
    const signed = Buffer.concat([authData, sha256(clientData)]);
    const signature = this.alg === -8 ? sign(null, signed, this.key) : sign("sha256", signed, this.key);
    return { id: b64u(this.id), clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: this.userHandle };
  }
}
