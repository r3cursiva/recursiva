// Signing a terminal in (PLNR-323): the TUI works as the person, in every workspace they are a member of, as a browser
// does. Settings › Security shows a one-time code to a fresh sign-in; `rsva login` takes the code pasted and gets a
// session of its own (method "cli"), sent as `Authorization: Session <secret>`.
//
// Considered (2026-11-06, docs/decisions/0044-terminal-sign-in.md):
// - A redirect to a port on 127.0.0.1 (RFC 8252, with PKCE): nothing to paste, but the browser must run where the
//   terminal does, and the owner's terminal is often an SSH session from another Mac.
// - A code typed into the browser (RFC 8628, as `gh auth login`): works over SSH, but a code someone sends you signs
//   them in once you approve it.
// - This one, a code from the browser pasted into the terminal: works over SSH, and someone else gets a session only if
//   the person hands them the code. No polling and nothing pending on the server but the code itself.
//
// Codes live in memory: one server process (PLNR-11), and a code that a deploy loses is asked for again.
//
// A code is only as good as the browser session that showed it: trading it looks that session up, and a signed-out,
// ended or ineligible one trades nothing (RSVA-598). Otherwise a thief's code, shown just before the owner signs out
// everywhere or takes the address back (ADR 0033), would sign the thief in again for a week. Considered: dropping the
// person's codes wherever sessions end (sign-out, ending by id, ending the others, the email revert) covers only the
// paths it is added to, and misses ineligibility, expiry and the sweep; the lookup at the trade covers them all, and is
// the cached one every request makes (sessions.ts).
import { randomSecret, sha256 } from "./secret.ts";
import { sessionById } from "./sessions.ts";

/** How long a code works: enough to copy it into a terminal. */
const CODE_MS = 5 * 60_000;

/**
 * Live codes by their hash: whose, the browser session that showed it, and until when. One per person: a new code
 * replaces the one before.
 */
const codes = new Map<string, { userId: string; sessionId: string; expiresAt: number }>();

/** A new code for the person, shown by their browser session `sessionId`; the code before it stops working. */
export function issueTerminalCode(userId: string, sessionId: string): { code: string; expiresAt: number } {
  const now = Date.now();
  for (const [hash, c] of codes) if (c.userId === userId || c.expiresAt <= now) codes.delete(hash);
  const code = randomSecret();
  const expiresAt = now + CODE_MS;
  codes.set(sha256(code), { userId, sessionId, expiresAt });
  return { code, expiresAt };
}

/**
 * Whose code it is and when the browser that showed it signed in, once: a used, expired or made-up code, or one whose
 * browser session is gone, is null. The terminal's session takes the browser's sign-in time, not its own: trading a
 * code is no sign-in, so it must not make a session fresh (FRESH_MS) again. A fresh one could make API tokens, or the
 * next code, and a chain of terminals would never age.
 */
export async function redeemTerminalCode(code: string): Promise<{ userId: string; signedInAt: number } | null> {
  const hash = sha256(code);
  const c = codes.get(hash);
  codes.delete(hash);
  if (!c || c.expiresAt <= Date.now()) return null;
  const s = await sessionById(c.sessionId);
  return s?.userId === c.userId ? { userId: s.userId, signedInAt: s.createdAt } : null;
}
