// Who is making a request: a browser session (cookie) or an API token (Authorization: Bearer). Both reach the same
// Actor, and everything after authentication (access.ts, the write pipeline) treats them alike.
//
// Cookies: on an https page the session cookie is __Host-rsva_sid (Secure, whole site, no Domain, so no other host
// can set or read it); on plain http (a local server, the perf checks) it is rsva_sid. A deployment with an https
// origin (RSVA_ALLOWED_ORIGINS) reads and sets only the __Host- one: rsva_sid could be planted by a sibling
// subdomain (Domain=.example.com) and sign a signed-out person into someone else's account. Next to it, rsva_in=1 is
// readable by the page: the shell decides between the app and the sign-in screen before any request (apps/web/src/auth.ts).
// It is a hint only: a forged one gets the sign-in screen after the first 401.
import type { IncomingHttpHeaders } from "node:http";
import { clientKey } from "../http.ts";
import { DEVICE_MS } from "./devices.ts";
import { Limiter } from "./limits.ts";
import { MAX_MS, sessionFromToken } from "./sessions.ts";
import { tokenFromSecret, type TokenInfo } from "./tokens.ts";

const SESSION_COOKIES = ["__Host-rsva_sid", "rsva_sid"] as const;
const SIGNED_IN_COOKIE = "rsva_in";
/** The browser's own token (devices.ts), named as the session cookie is: __Host- wherever that one is. */
const DEVICE_COOKIES = ["__Host-rsva_device", "rsva_device"] as const;

/** Session cookie names this deployment accepts, the one it sets first. */
export function sessionCookieNames(allowedOrigins: string | undefined): readonly string[] {
  const https = (allowedOrigins ?? "").split(",").some((o) => o.trim().toLowerCase().startsWith("https://"));
  return https ? [SESSION_COOKIES[0]] : SESSION_COOKIES;
}
const ACCEPTED = sessionCookieNames(process.env.RSVA_ALLOWED_ORIGINS);
const DEVICE_ACCEPTED = ACCEPTED.length === 1 ? [DEVICE_COOKIES[0]] : DEVICE_COOKIES;

export interface Actor {
  userId: string;
  via: "session" | "token";
  /** Session or token id: sockets opened with it close when it ends (socket.ts). */
  credentialId: string;
  /** For a session: when the person signed in (ms). */
  signedInAt?: number;
  /** For a token: the one workspace it opens and its scope. */
  token?: TokenInfo;
  /** A session sent in the Authorization header, not in a cookie: what Origin is about (needsOrigin). */
  header?: true;
  /**
   * A terminal's session (method "cli", terminal.ts), however it was sent: its secret in a cookie is still the Keychain's
   * secret, so what the terminal may not do (freshBrowser) goes by the session, not the transport.
   */
  terminal?: true;
}

/**
 * A browser sends Origin on every write and every WebSocket: a cookie session without one is not a page of ours. A
 * token or a terminal's session comes in a header no page can make a browser send, and needs none.
 */
export const needsOrigin = (actor: Actor): boolean => actor.via === "session" && !actor.header;

/** A cookie's value from a Cookie header, or undefined. */
function cookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export async function authenticate(headers: IncomingHttpHeaders): Promise<Actor | null> {
  const auth = headers.authorization;
  if (auth !== undefined) {
    // A signed-in terminal (terminal.ts) sends its session here, not in a cookie: no browser adds this header by itself.
    const m = /^(Bearer|Session) (\S+)$/.exec(auth);
    if (m?.[1] === "Session") {
      const s = await sessionFromToken(m[2]!);
      return s ? { userId: s.userId, via: "session", credentialId: s.id, signedInAt: s.createdAt, header: true, ...(s.terminal ? { terminal: true } : {}) } : null;
    }
    const t = m ? await tokenFromSecret(m[2]!) : null;
    return t ? { userId: t.userId, via: "token", credentialId: t.id, token: t } : null;
  }
  for (const name of ACCEPTED) {
    const v = cookie(headers.cookie, name);
    if (!v) continue;
    const s = await sessionFromToken(v);
    if (s) return { userId: s.userId, via: "session", credentialId: s.id, signedInAt: s.createdAt, ...(s.terminal ? { terminal: true } : {}) };
  }
  return null;
}

/**
 * Wrong credentials a client (an address, an IPv6 one by its /64: clientKey) may send in a window before its requests
 * of that kind are refused unlooked-up: each costs the database a read (a hash that missed is remembered for a minute, a
 * flood of distinct ones is not). Far above what a person's expired cookies and tokens produce. Counted apart for cookies, terminal sessions and tokens: the owner's
 * browser, terminal and agents share one address, and agents calling with tokens revoked on merge, or a terminal looping
 * on an ended session, must not lock the browser out (review of PLNR-326).
 */
const failures = new Limiter(300, 15 * 60_000);

/** Which credential the headers present, as failures counts it; null for none (nothing to look up, nothing counted). */
function presented(headers: IncomingHttpHeaders): string | null {
  const auth = headers.authorization;
  if (auth !== undefined) return auth.startsWith("Session ") ? "session" : "token";
  return ACCEPTED.some((name) => cookie(headers.cookie, name)) ? "cookie" : null;
}

/**
 * authenticate behind the failures limit, for every request from outside (requireActor, the WebSocket upgrade):
 * `retryAfter` (seconds) when the address used up its wrong credentials of this kind and nothing was looked up.
 */
export async function authenticateFrom(headers: IncomingHttpHeaders, ip: string): Promise<{ actor: Actor | null; retryAfter?: number }> {
  const kind = presented(headers);
  if (!kind) return { actor: null };
  const key = `${kind}\n${clientKey(ip)}`;
  if (failures.exhausted(key)) return { actor: null, retryAfter: failures.retryAfter(key) };
  const actor = await authenticate(headers);
  if (!actor) failures.take(key);
  return { actor };
}

/** Whether the cookies are Secure and the session one takes the __Host- prefix: an https page, or an https deployment. */
const secure = (origin: string | undefined) => ACCEPTED.length === 1 || (origin?.startsWith("https://") ?? false);

/** Set-Cookie values that open a session in the browser. */
export function sessionCookies(token: string, expiresAt: Date, origin: string | undefined): string[] {
  const s = secure(origin);
  const maxAge = Math.floor(Math.min(MAX_MS, expiresAt.getTime() - Date.now()) / 1000);
  const attrs = `Path=/; Max-Age=${maxAge}; SameSite=Lax${s ? "; Secure" : ""}`;
  return [`${s ? SESSION_COOKIES[0] : SESSION_COOKIES[1]}=${token}; ${attrs}; HttpOnly`, `${SIGNED_IN_COOKIE}=1; ${attrs}`];
}

/** The browser's device token from its cookies (devices.ts), or undefined. */
export function deviceToken(headers: IncomingHttpHeaders): string | undefined {
  for (const name of DEVICE_ACCEPTED) {
    const v = cookie(headers.cookie, name);
    if (v) return v;
  }
  return undefined;
}

/** Set-Cookie value that keeps the browser's device token for DEVICE_MS. Signing out leaves it (clearedCookies). */
export function deviceCookie(token: string, origin: string | undefined): string {
  const s = secure(origin);
  return `${s ? DEVICE_COOKIES[0] : DEVICE_COOKIES[1]}=${token}; Path=/; Max-Age=${DEVICE_MS / 1000}; SameSite=Lax${s ? "; Secure" : ""}; HttpOnly`;
}

/** Set-Cookie values that clear every sign-in cookie, whichever variant the browser holds; the device token stays. */
export function clearedCookies(origin: string | undefined): string[] {
  const s = secure(origin);
  return [
    `${SESSION_COOKIES[0]}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
    `${SESSION_COOKIES[1]}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    `${SIGNED_IN_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${s ? "; Secure" : ""}`,
  ];
}
