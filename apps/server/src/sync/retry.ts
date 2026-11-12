// Database errors that a second run of the same transaction can cure. Before, every one of them reached the client as
// `internal`, and the client took that as a refusal: it dropped the edit and rolled the screen back.
//
// Retried: a deadlock or a serialization failure (Postgres aborted this transaction so another could finish) and a lost
// connection (a restart or a failover). A transaction is safe to run again because its txId claim is its first write: a
// run that did commit before the connection dropped makes the next run a replay (`replayed` in write.ts), not a second
// apply. Anything else (a bug, bad data) fails the same way every time and is not retried.

/** SQLSTATE: serialization_failure, deadlock_detected; admin_shutdown, crash_shutdown, cannot_connect_now. */
const SQLSTATES = new Set(["40001", "40P01", "57P01", "57P02", "57P03"]);
/** postgres.js's own codes for a connection that went away, and the socket errors under them; a host name stops resolving while its container restarts. */
const CONNECTION = new Set(["CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

/** The string codes of `e` and of what it wraps, outermost first: drizzle puts the driver's error in `cause`. */
function errorCodes(e: unknown): string[] {
  const out: string[] = [];
  for (let x = e, depth = 0; x && typeof x === "object" && depth < 5; x = (x as { cause?: unknown }).cause, depth++) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === "string") out.push(code);
  }
  return out;
}

/** Whether `e` (or what it wraps) is worth running the transaction again. Class 08: connection exception. */
export const transient = (e: unknown): boolean => errorCodes(e).some((code) => SQLSTATES.has(code) || CONNECTION.has(code) || /^08...$/.test(code));

/** A unique index refused the write (SQLSTATE 23505), however deep the driver's error is wrapped. */
export const uniqueViolation = (e: unknown): boolean => errorCodes(e).includes("23505");

const ATTEMPTS = 3;

/** Runs `run` up to three times while it fails with a transient error, a short jittered pause between runs. */
export async function retrying<T>(run: () => Promise<T>, pause = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (attempt >= ATTEMPTS || !transient(e)) throw e;
      // 20-60 ms, then 80-240 ms: long enough for the other transaction to commit, short against a client's patience.
      await pause(20 * 4 ** (attempt - 1) * (1 + Math.random() * 2));
    }
  }
}
