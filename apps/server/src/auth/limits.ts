// Request limits for sign-in and API tokens: a fixed window per key, in memory; and the misses of secret lookups. One
// process is all we run (PLNR-11 adds more; each would then allow its own share, still bounded).

export class Limiter {
  private readonly hits = new Map<string, { n: number; until: number }>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Counts a hit; false once the key used up its window. Then the seconds until it resets are in retryAfter(). */
  take(key: string): boolean {
    const now = Date.now();
    let h = this.hits.get(key);
    if (!h || now >= h.until) {
      if (this.hits.size >= 50_000) this.sweep(now);
      this.hits.set(key, (h = { n: 0, until: now + this.windowMs }));
    }
    return ++h.n <= this.max;
  }

  /** Whether the key used up its window, counting nothing. */
  exhausted(key: string): boolean {
    const h = this.hits.get(key);
    return !!h && Date.now() < h.until && h.n >= this.max;
  }

  retryAfter(key: string): number {
    const h = this.hits.get(key);
    return h ? Math.max(1, Math.ceil((h.until - Date.now()) / 1000)) : 0;
  }

  private sweep(now: number): void {
    for (const [k, h] of this.hits) if (now >= h.until) this.hits.delete(k);
    // Still full of live keys (a flood of distinct ones): drop the oldest rather than grow without bound.
    while (this.hits.size >= 50_000) this.hits.delete(this.hits.keys().next().value!);
  }
}

/**
 * Secret hashes that matched nothing, by when they were looked up (sessions.ts, tokens.ts): a wrong cookie, header or
 * token sent again and again costs the database one read per `ttlMs`, not one a request. A hash that missed never comes
 * to match: secrets are never reused. Bounded, the oldest going first.
 */
export class Misses {
  private readonly at = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /** Whether the hash missed within ttlMs. */
  has(hash: string, now = Date.now()): boolean {
    const t = this.at.get(hash);
    return t !== undefined && now - t < this.ttlMs;
  }

  add(hash: string, now = Date.now()): void {
    if (this.at.size >= 10_000) this.at.delete(this.at.keys().next().value!);
    this.at.set(hash, now);
  }

  clear(): void {
    this.at.clear();
  }
}

/** A limit refused the request deep in a call: the error handler (app.ts) answers 429 with retry-after. */
export class RateLimited extends Error {
  readonly statusCode = 429;
  readonly retryAfter: number;

  constructor(retryAfter: number, message: string) {
    super(message);
    this.retryAfter = retryAfter;
  }
}
