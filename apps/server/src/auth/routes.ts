// Sign-in endpoints. Codes and passkeys open a session; signed-in people manage their passkeys and sign out.
//
// Forged cross-site requests: the session cookie is SameSite=Lax, every browser request with a foreign Origin is refused
// by the guard (guard.ts), and a cookie-authenticated write without an Origin header is refused here (requireActor).
// Browsers send Origin on every POST, PATCH and DELETE and on WebSocket, so a token in the page is not needed
// (docs/decisions/0009-sign-in.md).
import type { AccountMe, AccountSecurity, TerminalCode, TerminalSession } from "@rsva/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { accountPatch, readSettings, updateAccount } from "./account.ts";
import { authenticate, authenticateFrom, clearedCookies, deviceCookie, deviceToken, needsOrigin, sessionCookies, type Actor } from "./actor.ts";
import { deviceName } from "./device.ts";
import { checkDevice } from "./devices.ts";
import { confirmEmailChange, requestEmailChange, revertEmailChange, REVERT_SECRET } from "./email-change.ts";
import { mayCreateWorkspaces, maySignIn } from "./eligibility.ts";
import { LINK_SECRET, requestCode, verifyCode, verifyLink } from "./codes.ts";
import { Limiter, RateLimited } from "./limits.ts";
import { newSignInMail, passkeyMail } from "../mail/emails.ts";
import { linkOrigin, type Mailer } from "./mail.ts";
import type { TelegramApi } from "../telegram/api.ts";
import { deletePasskey, finishLogin, finishRegistration, listPasskeys, loginOptions, registrationOptions, type RelyingParty } from "./passkeys.ts";
import { createSession, endOtherSessions, endSession, FRESH_MS, listSessions, sessionByHandle, type SignInMethod } from "./sessions.ts";
import { issueTerminalCode, redeemTerminalCode } from "./terminal.ts";
import { perToken } from "./tokens.ts";
import { WebAuthnError, type AssertionJSON, type RegistrationJSON } from "./webauthn.ts";
import { db, schema } from "../db.ts";
import { clientKey, email, HttpError, limit, parse } from "../http.ts";
import { eq } from "drizzle-orm";
import { closeSockets } from "../sync/socket.ts";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

const MIN = 60_000;

/**
 * How long the sockets of a replaced session stay: long enough for the answer with the new cookie to arrive, so they
 * reconnect with it (a socket closed sooner comes back with the old cookie and is refused).
 */
const REPLACED_SOCKETS_MS = 5_000;

const isFresh = (actor: Actor) => Date.now() - actor.signedInAt! <= FRESH_MS;

/** Throws a 403 unless the request's session signed in within FRESH_MS. */
function freshSignIn(req: FastifyRequest, what: string): void {
  if (!isFresh(req.actor!)) throw new HttpError(403, "reauth_required", `Confirm it's you: sign in again to ${what}.`);
}

/**
 * freshSignIn for a step that makes a new way in (an API token, a passkey, a terminal's code, the sign-in address, the
 * Telegram chat that gets codes): a browser's session only. A terminal's session (terminal.ts) inherits its browser's
 * sign-in time, so for ten minutes it is fresh too, and it sits in the Keychain, where more than the TUI can read it; one
 * taken from there must not make itself a key that outlives it (security review, PLNR-326). Judged by the session's
 * method, not only by how it was sent: the same secret in a cookie, with an Origin forged by a non-browser, is still the
 * terminal's. And any session in the Authorization header is refused too: no browser sends one there, so a browser's
 * secret replayed that way comes from outside the browser. Ending sessions and removing keys stay open to it: that is
 * protection, not new access.
 */
export function freshBrowser(req: FastifyRequest, what: string): void {
  if (req.actor!.terminal || req.actor!.header) throw new HttpError(403, "forbidden", `Only the browser can ${what}: open Settings › Security there.`);
  freshSignIn(req, what);
}

/**
 * Starts of the steps that end in a security mail to the person (a passkey added, a Telegram chat or group linked, Telegram actions turned on), per
 * person: a fresh session could otherwise loop them and spend the mail quota that sign-in codes share (RSVA-249). Only
 * the start counts: the step that finishes is never refused, so every change that went through is mailed. Ten an hour,
 * one count for them all (owner 2026-11-08): a person needs one to three; past ten, an hour's wait at most.
 */
const mailedStepsByPerson = new Limiter(10, 60 * MIN);

/** freshBrowser for a step whose finish mails the person, within mailedStepsByPerson; past it, 429 with retry-after. */
export function freshBrowserMailed(req: FastifyRequest, what: string): void {
  freshBrowser(req, what);
  limit(mailedStepsByPerson, req.actor!.userId);
}

/**
 * A preHandler that lets the request through only with a session or, unless `sessionOnly`, a token; a token over its
 * rate gets 429, so a runaway agent loop stops here instead of flooding the log.
 */
export function requireActor(opts: { sessionOnly?: boolean; hidden?: boolean } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const { actor, retryAfter } = await authenticateFrom(req.headers, req.ip);
    if (retryAfter) throw new RateLimited(retryAfter, "Too many failed sign-ins from this address. Try again later.");
    // hidden: a resource whose address must not say that it exists (a file) answers a stranger as missing, with no
    // message, so by hand: an HttpError always carries one.
    if (!actor) {
      if (opts.hidden) return reply.code(404).send({ error: "not_found" });
      throw new HttpError(401, "unauthorized", "sign in first");
    }
    if (actor.token && !perToken.take(actor.token.id)) throw new RateLimited(perToken.retryAfter(actor.token.id), "too many requests for this token");
    if (opts.sessionOnly && actor.via !== "session") throw new HttpError(403, "forbidden", "only a signed-in person can do this, not a token");
    if (needsOrigin(actor) && req.method !== "GET" && req.method !== "HEAD" && !req.headers.origin)
      throw new HttpError(403, "forbidden_origin", "a browser write needs an Origin header");
    req.actor = actor;
  };
}

/** The page a passkey ceremony runs on; a 400 without an Origin. The guard has already checked the Origin. */
function relyingParty(req: FastifyRequest): RelyingParty {
  const origin = req.headers.origin;
  if (!origin) throw new HttpError(400, "invalid", "passkeys need an Origin header");
  return { origin, rpId: new URL(origin).hostname };
}

/** A failed passkey ceremony (WebAuthnError) as a 400; anything else as it is. */
function passkeyFailed(e: unknown): never {
  throw e instanceof WebAuthnError ? new HttpError(400, "passkey_failed", e.message) : e;
}

const base64url = z.string().max(16_384).regex(/^[A-Za-z0-9_-]*$/);
const assertion = z.object({ id: base64url, clientDataJSON: base64url, authenticatorData: base64url, signature: base64url, userHandle: base64url.nullish() });
const registration = z.object({
  id: base64url,
  clientDataJSON: base64url,
  authenticatorData: base64url,
  publicKey: base64url,
  publicKeyAlgorithm: z.number().int(),
  transports: z.array(z.string().max(20)).max(8).optional(),
});

export function registerAuthRoutes(app: FastifyInstance, mailer: Mailer, telegram: TelegramApi | null): void {
  app.decorateRequest("actor", null);
  // Codes per email: every code allows five guesses, so this also bounds guesses per email from any number of IPs
  // (25 an hour). A flood from elsewhere can hold back someone's codes for up to an hour; passkeys are unaffected.
  // These limits are in memory and start over with a deploy; the daily cap of wrong guesses (codes.ts) is kept in
  // the database and does not. "ByIp" is per client: an IPv6 address counts by its /64 (clientKey), or walking the
  // addresses of one subscriber's block would make it many clients (RSVA-599).
  const codesByEmail = new Limiter(5, 60 * MIN);
  const codesByIp = new Limiter(30, 15 * MIN);
  const verifyByIp = new Limiter(30, 15 * MIN);
  // Guesses per email and client across codes: a new code resets its own five, this does not. Keyed with the client so
  // someone elsewhere cannot lock a person out of their own sign-in.
  const verifyByEmailIp = new Limiter(10, 60 * MIN);
  const passkeysByIp = new Limiter(60, 15 * MIN);
  // A terminal's code is 256 bits: the limit is against floods, not guesses.
  const terminalByIp = new Limiter(30, 15 * MIN);
  // New addresses one person may ask to confirm in an hour.
  const codesByPerson = new Limiter(5, 60 * MIN);

  async function me(userId: string): Promise<AccountMe["user"]> {
    const [u] = await db.select({ id: schema.user.id, email: schema.user.email, name: schema.user.name }).from(schema.user).where(eq(schema.user.id, userId));
    return u!;
  }

  async function signIn(req: FastifyRequest, reply: FastifyReply, userId: string, method: Exclude<SignInMethod, "cli">) {
    // A sign-in over a session of the same person, as "confirm it's you" does, replaces it: one browser stays one row in
    // their list of sessions. Its sockets close a moment later and reconnect with the new cookie (client.ts).
    // A terminal's session is not this browser's, however it came: it stays, the browser gets its own.
    const before = await authenticate(req.headers);
    const sameBrowser = before?.via === "session" && !before.terminal && before.userId === userId;
    // Before the new session: a person with no session and no known browser is signing in for the first time.
    const device = await checkDevice(userId, deviceToken(req.headers), sameBrowser);
    if (sameBrowser) {
      const replaced = before.credentialId;
      await endSession(replaced);
      setTimeout(() => closeSockets(replaced), REPLACED_SOCKETS_MS).unref();
    }
    const s = await createSession(userId, method, req.headers["user-agent"]);
    const u = await me(userId);
    const passkeys = (await listPasskeys(userId)).length;
    // A browser this person has not signed in from (devices.ts): they hear of it, always (PLNR-252).
    if (device.isNew) {
      const notice = { to: u.email, device: deviceName(req.headers["user-agent"]), method, ip: req.ip, origin: linkOrigin(req.headers.origin) };
      void mailer(newSignInMail(notice)).catch((e: unknown) => req.log.error(e, "new sign-in notice not sent"));
    }
    return reply
      .header("set-cookie", [...sessionCookies(s.token, s.expiresAt, req.headers.origin), deviceCookie(device.token, req.headers.origin)])
      .send({ user: u, passkeys, mayCreateWorkspaces: await mayCreateWorkspaces(u.email) });
  }

  // Step 1: a code to the email. The answer is the same for any address and comes before the mail is sent, so neither
  // its content nor its timing tells whether the address has an account.
  app.post<{ Body: unknown }>("/auth/code", async (req, reply) => {
    const body = parse(z.object({ email }), req.body);
    limit(codesByIp, clientKey(req.ip));
    limit(codesByEmail, body.email.toLowerCase());
    const asker = { device: deviceToken(req.headers), browser: deviceName(req.headers["user-agent"]), ip: req.ip };
    void requestCode(body.email, mailer, linkOrigin(req.headers.origin), telegram && { api: telegram, asker }).catch((e: unknown) => req.log.error(e, "sign-in code not sent"));
    return reply.code(204).send();
  });

  // Step 2: the code opens a session.
  app.post<{ Body: unknown }>("/auth/verify", async (req, reply) => {
    const body = parse(z.object({ email, code: z.string().trim().max(10) }), req.body);
    limit(verifyByIp, clientKey(req.ip));
    limit(verifyByEmailIp, `${body.email.toLowerCase()}\n${clientKey(req.ip)}`);
    const r = await verifyCode(body.email, body.code);
    if ("error" in r) throw new HttpError(400, r.error, r.error === "expired_code" ? "The code has expired. Ask for a new one." : "Wrong code.");
    return signIn(req, reply, r.userId, "code");
  });

  // Step 2 past the daily cap of wrong codes: the link from the mail (codes.ts). The page reads it from the URL's
  // fragment and posts it here, so it never reaches a request log. Limited like codes; every failure reads the same.
  app.post<{ Body: unknown }>("/auth/link", async (req, reply) => {
    const body = parse(z.object({ email, secret: z.string().regex(LINK_SECRET) }), req.body);
    limit(verifyByIp, clientKey(req.ip));
    limit(verifyByEmailIp, `${body.email.toLowerCase()}\n${clientKey(req.ip)}`);
    const r = await verifyLink(body.email, body.secret);
    if (!r) throw new HttpError(400, "invalid_link", "This sign-in link no longer works. Ask for a new one.");
    return signIn(req, reply, r.userId, "code");
  });

  // Passkey sign-in: options, then the signed assertion.
  app.post("/auth/passkey/options", async (req) => {
    const rp = relyingParty(req);
    const client = clientKey(req.ip);
    limit(passkeysByIp, client);
    return loginOptions(rp, client);
  });

  app.post<{ Body: unknown }>("/auth/passkey", async (req, reply) => {
    const rp = relyingParty(req);
    limit(passkeysByIp, clientKey(req.ip));
    const body = parse(z.object({ credential: assertion }), req.body);
    const userId = await finishLogin(body.credential as AssertionJSON, rp).catch(passkeyFailed);
    if (!(await maySignIn(userId))) throw new HttpError(403, "forbidden", "this account is not a member of any workspace");
    return signIn(req, reply, userId, "passkey");
  });

  // Signed in: who am I, sign out, my passkeys and sessions.
  const session = { preHandler: requireActor({ sessionOnly: true }) };

  app.get("/auth/me", session, async (req): Promise<AccountMe> => {
    const { userId } = req.actor!;
    const u = await me(userId);
    return { user: u, passkeys: await listPasskeys(userId), mayCreateWorkspaces: await mayCreateWorkspaces(u.email), settings: await readSettings(userId) };
  });

  // Settings › Profile: the name, the time zone, the first day of the week. The address changes by the steps below.
  app.patch<{ Body: unknown }>("/auth/me", session, async (req) => {
    const body = parse(accountPatch, req.body);
    const settings = await updateAccount(req.actor!.userId, body);
    return { user: await me(req.actor!.userId), settings };
  });

  // Changing the sign-in email (email-change.ts, ADR 0033): a code to the new address from a fresh sign-in, then the
  // code. Codes are limited as sign-in codes are, per address and IP, and per person besides: one session must not mail
  // every address it can think of. The answer comes before the mail, the same for an address that has an account.
  app.post<{ Body: unknown }>("/auth/email", session, async (req, reply) => {
    const body = parse(z.object({ email }).strict(), req.body);
    freshBrowser(req, "change your email");
    const { userId } = req.actor!;
    limit(codesByIp, clientKey(req.ip));
    limit(codesByPerson, userId);
    limit(codesByEmail, body.email.toLowerCase());
    const mail = await requestEmailChange(userId, body.email, linkOrigin(req.headers.origin));
    if (!mail) throw new HttpError(400, "same_email", "That is your email already.");
    void mailer(mail).catch((e: unknown) => req.log.error(e, "email change code not sent"));
    return reply.code(204).send();
  });

  // No fresh sign-in here: the request was fresh, and the code lives 10 minutes.
  app.post<{ Body: unknown }>("/auth/email/confirm", session, async (req) => {
    const body = parse(z.object({ code: z.string().trim().max(10) }).strict(), req.body);
    const { userId } = req.actor!;
    limit(verifyByIp, clientKey(req.ip));
    limit(verifyByEmailIp, `${userId}\n${clientKey(req.ip)}`);
    const r = await confirmEmailChange(userId, body.code, req.headers["user-agent"] ?? "", linkOrigin(req.headers.origin));
    if ("error" in r)
      throw new HttpError(
        400,
        r.error,
        r.error === "expired_code" ? "The code has expired. Ask for a new one." : r.error === "email_taken" ? "That address has an account now. Pick another." : "Wrong code.",
      );
    void mailer(r.mail).catch((e: unknown) => req.log.error(e, "email change notice not sent"));
    return { user: await me(userId) };
  });

  // The link back from the old address, with no session: whoever changed the address may have locked its owner out.
  // The page posts the secret from the URL's fragment after the person confirms (email-revert.tsx). Every session of
  // the account ends, the one that changed the address too.
  app.post<{ Body: unknown }>("/auth/email/revert", async (req) => {
    const body = parse(z.object({ secret: z.string().regex(REVERT_SECRET) }).strict(), req.body);
    limit(verifyByIp, clientKey(req.ip));
    const r = await revertEmailChange(body.secret, linkOrigin(req.headers.origin));
    if ("error" in r)
      throw new HttpError(
        400,
        r.error,
        r.error === "email_taken" ? "That address has another account now, so it can't be put back. Ask the admin of your workspace." : "This link no longer works.",
      );
    for (const id of r.ended) closeSockets(id);
    if (r.mail) void mailer(r.mail).catch((e: unknown) => req.log.error(e, "email revert notice not sent"));
    // The browser's cookies stay: it may be signed in as someone else. If they were this person's, they are dead now.
    return { email: r.restored, removed: r.removed };
  });

  app.post("/auth/sign-out", session, async (req, reply) => {
    await endSession(req.actor!.credentialId);
    closeSockets(req.actor!.credentialId);
    // Files and pictures are cached for a year (files/routes.ts IMMUTABLE): without this the browser would go on serving
    // them from its HTTP cache to whoever uses it next, with no session (RSVA-620). "cache" is the HTTP cache alone: the
    // Service Worker's copy of the shell is Cache Storage and stays, so the sign-in screen still opens offline.
    return reply.header("set-cookie", clearedCookies(req.headers.origin)).header("clear-site-data", '"cache"').code(204).send();
  });

  // A terminal's sign-in (terminal.ts): a one-time code for a fresh sign-in, which `rsva login` trades for a session.
  // Fresh, as for an API token: a stolen cookie must not become a key that outlives it. Only a browser shows codes: a
  // terminal does not sign the next one in.
  app.post("/auth/terminal/code", session, async (req) => {
    freshBrowser(req, "sign a terminal in");
    const c = issueTerminalCode(req.actor!.userId, req.actor!.credentialId);
    return { code: c.code, expiresAt: new Date(c.expiresAt).toISOString() } satisfies TerminalCode;
  });

  app.post<{ Body: unknown }>("/auth/terminal", async (req) => {
    const body = parse(z.object({ code: z.string().trim().max(100) }), req.body);
    limit(terminalByIp, clientKey(req.ip));
    const r = await redeemTerminalCode(body.code);
    if (!r) throw new HttpError(400, "invalid_code", "This code no longer works: show a new one in Settings › Security.");
    const s = await createSession(r.userId, "cli", req.headers["user-agent"], r.signedInAt);
    return { session: s.token, expiresAt: s.expiresAt.toISOString(), user: await me(r.userId) } satisfies TerminalSession;
  });

  app.get("/auth/security", session, async (req): Promise<AccountSecurity> => ({
    passkeys: await listPasskeys(req.actor!.userId),
    sessions: await listSessions(req.actor!.userId, req.actor!.credentialId),
  }));

  // Ending an older session takes no fresh sign-in: it is what someone does on finding a stranger in the list. Ending a
  // newer one does: otherwise a stolen cookie, however old, ends every session its owner signs in with, as often as they
  // try, and they never get to end it. Their new session is always the younger, so it can end the stolen one and not the
  // other way round. The session in use leaves by /auth/sign-out, which also clears its cookies.
  app.delete<{ Params: { id: string } }>("/auth/sessions/:id", session, async (req, reply) => {
    const s = await sessionByHandle(req.actor!.userId, req.params.id);
    if (!s) throw new HttpError(404, "not_found", "no such session");
    if (s.id === req.actor!.credentialId) throw new HttpError(400, "current_session", "this is the session in use: sign out instead");
    if (s.createdAt > req.actor!.signedInAt!) freshSignIn(req, "sign out a newer session");
    await endSession(s.id);
    closeSockets(s.id);
    return reply.code(204).send();
  });

  // A stale session ends the older ones in the same statement that spares the newer, then asks to confirm for those.
  app.post("/auth/sessions/end-others", session, async (req) => {
    const { userId, credentialId } = req.actor!;
    const fresh = isFresh(req.actor!);
    const gone = await endOtherSessions(userId, credentialId, fresh ? undefined : req.actor!.signedInAt);
    for (const id of gone) closeSockets(id);
    if (!fresh && (await listSessions(userId, credentialId)).some((s) => !s.current)) freshSignIn(req, "sign out newer sessions");
    return { ended: gone.length };
  });

  // Only from a fresh sign-in (FRESH_MS). The finish needs this call's challenge (single use, five minutes, this
  // person's), so checking here bounds it too.
  app.post("/auth/passkeys/options", session, async (req) => {
    freshBrowserMailed(req, "add a passkey");
    return registrationOptions(req.actor!.userId, relyingParty(req));
  });

  app.post<{ Body: unknown }>("/auth/passkeys", session, async (req, reply) => {
    const rp = relyingParty(req);
    const body = parse(z.object({ credential: registration, name: z.string().max(100).optional() }), req.body);
    const added = await finishRegistration(req.actor!.userId, body.credential as RegistrationJSON, body.name ?? deviceName(req.headers["user-agent"]), rp).catch(passkeyFailed);
    // The account's owner hears of every new key: one added with a stolen session does not go unnoticed.
    const [u] = await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, req.actor!.userId));
    void mailer(passkeyMail({ to: u!.email, passkeyName: added.name, userAgent: req.headers["user-agent"] ?? "", host: rp.rpId, origin: linkOrigin(req.headers.origin) })).catch((e: unknown) => req.log.error(e, "passkey notice not sent"));
    return reply.code(201).send(added);
  });

  app.delete<{ Params: { id: string } }>("/auth/passkeys/:id", session, async (req, reply) => {
    if (!(await deletePasskey(req.actor!.userId, req.params.id))) throw new HttpError(404, "not_found", "no such passkey");
    return reply.code(204).send();
  });
}
