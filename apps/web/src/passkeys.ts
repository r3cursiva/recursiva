// Passkeys in the browser: navigator.credentials with the options the server issues, answers sent back as base64url
// fields (the server's side: apps/server/src/auth/webauthn.ts). Registration reports the public key through
// getPublicKey(), so neither side reads CBOR. Loaded on demand: by the sign-in screen and the workspace menu.

const b64u = {
  encode(buf: ArrayBuffer): string {
    let s = "";
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  },
  decode(s: string): ArrayBuffer {
    const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  },
};

/** Whether the browser can offer passkeys in the email field's autofill (conditional mediation). */
export async function autofillSupported(): Promise<boolean> {
  return (await PublicKeyCredential.isConditionalMediationAvailable?.()) ?? false;
}

/** A refusal with the server's code: reauth_required asks for a fresh sign-in before adding a passkey. */
export class PasskeyRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!r.ok) throw new PasskeyRefused(data.error ?? "error", data.message ?? `HTTP ${r.status}`);
  return data;
}

interface Descriptor {
  type: "public-key";
  id: string;
  transports?: AuthenticatorTransport[];
}

interface CreationOptionsJSON extends Omit<PublicKeyCredentialCreationOptions, "challenge" | "user" | "excludeCredentials"> {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials: Descriptor[];
}

interface RequestOptionsJSON {
  challenge: string;
  rpId: string;
  userVerification: UserVerificationRequirement;
  timeout: number;
}

const descriptor = (d: Descriptor): PublicKeyCredentialDescriptor => ({ ...d, id: b64u.decode(d.id) });

/** Creates a passkey for the signed-in person and registers it; resolves with its name. Needs a recent sign-in. */
export async function addPasskey(): Promise<string> {
  const o = await postJson<CreationOptionsJSON>("/auth/passkeys/options");
  const cred = (await navigator.credentials.create({
    publicKey: { ...o, challenge: b64u.decode(o.challenge), user: { ...o.user, id: b64u.decode(o.user.id) }, excludeCredentials: o.excludeCredentials.map(descriptor) },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was created");
  const r = cred.response as AuthenticatorAttestationResponse;
  const publicKey = r.getPublicKey();
  if (!publicKey) throw new Error("This browser did not report the passkey's public key");
  const saved = await postJson<{ name: string }>("/auth/passkeys", {
    credential: {
      id: cred.id,
      clientDataJSON: b64u.encode(r.clientDataJSON),
      authenticatorData: b64u.encode(r.getAuthenticatorData()),
      publicKey: b64u.encode(publicKey),
      publicKeyAlgorithm: r.getPublicKeyAlgorithm(),
      transports: r.getTransports(),
    },
  });
  return saved.name;
}

/**
 * Signs in with a passkey; resolves with the server's answer (the user and the new session's cookies are set). With
 * `autofill`, the browser offers the passkeys in the email field's autofill instead of a dialog, and the call waits until
 * one is picked or `signal` aborts it.
 */
export async function signInWithPasskey<T>(opts: { autofill?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const o = await postJson<RequestOptionsJSON>("/auth/passkey/options");
  const cred = (await navigator.credentials.get({
    publicKey: { ...o, challenge: b64u.decode(o.challenge) },
    ...(opts.autofill ? { mediation: "conditional" as CredentialMediationRequirement } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was chosen");
  const r = cred.response as AuthenticatorAssertionResponse;
  return postJson<T>("/auth/passkey", {
    credential: {
      id: cred.id,
      clientDataJSON: b64u.encode(r.clientDataJSON),
      authenticatorData: b64u.encode(r.authenticatorData),
      signature: b64u.encode(r.signature),
      userHandle: r.userHandle ? b64u.encode(r.userHandle) : null,
    },
  });
}
