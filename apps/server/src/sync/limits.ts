// Per-person budgets for the sync layer (PLNR-32): what one person's sessions and tokens together may write and make
// the server read for them each minute. Before, only tokens were limited (600 requests a minute, auth/tokens.ts) and a
// browser session was not: one member filled the log with 100 MB in three seconds and three catch-ups of it took the
// process from 0.6 to 1.9 GB.
//
// Considered (2026-10-29): counting transactions with the fixed-window Limiter of auth/limits.ts: a transaction can be
// 1 op or 500 ops and 1 MiB, so a count bounds neither; two fixed windows (ops, bytes): a window's edge lets twice the
// amount through in a moment. Chosen: token buckets weighted by ops and bytes. A bucket holds a minute's worth and refills
// continuously, so a burst (a bulk move) passes at once and a flood is held to the rate. Reads reserve the most they may
// cost before they start and give back what they did not use, so many requests started at once cannot all pass.
//
// In memory, per process: a restart forgets them, which is fine for a rate (it is not a quota).

/** A bucket of `perMinute` units per key, full at the start and refilled at that rate. */
export class Budget {
  private readonly left = new Map<string, { n: number; at: number }>();
  readonly perMinute: number;

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  /** What the key has now. */
  available(key: string, now = Date.now()): number {
    const b = this.left.get(key);
    return b ? Math.min(this.perMinute, b.n + ((now - b.at) * this.perMinute) / 60_000) : this.perMinute;
  }

  /** Takes n units; false, taking nothing, when the key has less. */
  take(key: string, n: number, now = Date.now()): boolean {
    const have = this.available(key, now);
    if (have < n) return false;
    if (this.left.size >= 10_000 && !this.left.has(key)) this.sweep(now);
    this.left.set(key, { n: have - n, at: now });
    return true;
  }

  /**
   * Gives back units taken but not used (a read that turned out smaller than reserved); a negative n takes what a read used
   * beyond its reservation, below zero if need be, so the key waits until it has refilled that too.
   */
  refund(key: string, n: number, now = Date.now()): void {
    if (n !== 0 && this.left.has(key)) this.left.set(key, { n: Math.min(this.perMinute, this.available(key, now) + n), at: now });
  }

  /** Seconds until the key has n units again. */
  retryAfter(key: string, n: number, now = Date.now()): number {
    return Math.max(1, Math.ceil(((n - this.available(key, now)) * 60) / this.perMinute));
  }

  /** Full buckets are the same as none. */
  private sweep(now: number): void {
    for (const k of this.left.keys()) if (this.available(k, now) >= this.perMinute) this.left.delete(k);
    while (this.left.size >= 10_000) this.left.delete(this.left.keys().next().value!);
  }
}

/**
 * Ops a minute. The client sends a bulk change in transactions of 400 ops (packages/sync TX_OPS), so a select-all move of
 * 3,000 issues passes in one go; an agent at its token's 600 requests a minute with a few ops each stays far below.
 */
const OPS_PER_MINUTE = 3000;
/**
 * Bytes of transactions a minute. The heaviest real writer is the description editor: it saves the whole document at
 * most every 4 s while typing and 0.6 s after a pause, and a document may be 400 KB of JSON, so a long one costs about
 * 6 MB a minute; comments are up to 64 KB. 16 MiB leaves more than twice that and holds a flood to 16 MiB a minute.
 */
const WRITE_BYTES_PER_MINUTE = 16 * 2 ** 20;
/**
 * Bytes the server reads and sends for one person a minute: catch-ups, inbox, saved views and history answers. A catch-up is at most
 * CATCH_UP_BYTES (sync/socket.ts) and a history page about HISTORY_PAGE_BYTES (sync/history.ts), so this is 16 full
 * catch-ups or 64 full history pages a minute; ordinary ones are a few KB.
 */
const READ_BYTES_PER_MINUTE = 64 * 2 ** 20;

const ops = new Budget(OPS_PER_MINUTE);
const writeBytes = new Budget(WRITE_BYTES_PER_MINUTE);
export const reads = new Budget(READ_BYTES_PER_MINUTE);

/**
 * Counts a transaction against the person's budgets; false, counting nothing, when either is used up. Every transaction
 * path calls it (the socket and the REST API); the server's own changes and imports do not.
 */
export function takeWrite(userId: string, opCount: number, bytes: number): boolean {
  const now = Date.now();
  if (ops.available(userId, now) < opCount || writeBytes.available(userId, now) < bytes) return false;
  return ops.take(userId, opCount, now) && writeBytes.take(userId, bytes, now);
}

/** Seconds until a transaction of this size fits the person's budgets again. */
export function writeRetryAfter(userId: string, opCount: number, bytes: number): number {
  return Math.max(ops.retryAfter(userId, opCount), writeBytes.retryAfter(userId, bytes));
}

/**
 * Bytes of uploaded files a minute (PLNR-50), apart from WRITE_BYTES_PER_MINUTE: one file may be 25 MiB (FILE_MAX), more
 * than the transaction budget holds at all. Ten full-size files a minute, or a few hundred screenshots.
 */
const UPLOAD_BYTES_PER_MINUTE = 256 * 2 ** 20;
export const uploads = new Budget(UPLOAD_BYTES_PER_MINUTE);

/**
 * Snapshots (GET /sync/bootstrap) a minute (RSVA-608). A client asks for one only when it has no copy of the workspace on
 * disk, or after a gap too long to catch up (sync/socket.ts CATCH_UP_LIMIT); a fresh browser opening My work asks once
 * per workspace at once. The bucket holds a minute's worth, so that burst passes; a flood of rebuilds is held to one a
 * second.
 */
const BOOTSTRAPS_PER_MINUTE = 60;
export const bootstraps = new Budget(BOOTSTRAPS_PER_MINUTE);
