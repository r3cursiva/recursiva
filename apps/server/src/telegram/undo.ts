// Undo for a change made from Telegram (PLNR-360): the fields before and after, kept in memory for ten minutes under a
// short token that rides in the Undo button (a button holds 64 bytes, the fields may not fit). A restart forgets them:
// Undo then says it is gone, and the change stays as made, as it would after the ten minutes.
import { randomBytes } from "node:crypto";

/** How long Undo works after the change. */
const UNDO_MS = 10 * 60_000;
/** Most kept at once; the oldest go first. */
const MAX = 2_000;

export interface Change {
  userId: string;
  workspaceId: string;
  issueId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

const kept = new Map<string, Change & { at: number }>();

/** Keeps a change; the token for its Undo button. */
export function keepUndo(c: Change, now = Date.now()): string {
  for (const [k, v] of kept) if (now - v.at > UNDO_MS || kept.size >= MAX) kept.delete(k);
  const token = randomBytes(9).toString("base64url");
  kept.set(token, { ...c, at: now });
  return token;
}

/** The change behind a token, taken out: only for the person who made it, within the ten minutes. */
export function takeUndo(token: string, userId: string, now = Date.now()): Change | null {
  const c = kept.get(token);
  if (!c || c.userId !== userId) return null;
  kept.delete(token);
  return now - c.at > UNDO_MS ? null : c;
}

/** A field's value compared as the write pipeline stores it: lists in any order are the same list. */
export const same = (a: unknown, b: unknown) => JSON.stringify(Array.isArray(a) ? [...a].sort() : (a ?? null)) === JSON.stringify(Array.isArray(b) ? [...b].sort() : (b ?? null));
