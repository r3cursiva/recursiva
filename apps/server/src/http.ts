// What the HTTP routes share: request validation, refusals and their codes, the 429 answer of a rate limit, the key a
// client is counted under, and the formats of emails and names.
import { isIPv6 } from "node:net";
import { NAME_MAX, TITLE_MAX, cleanName } from "@rsva/schema/models";
import { z } from "zod";
import { RateLimited, type Limiter } from "./auth/limits.ts";

export const email = z.string().trim().max(254).pipe(z.email());

/** One line of text cleaned as cleanName stores it: nothing visible left is empty. */
const line = (what: string, max: number) =>
  z.string().transform(cleanName).pipe(z.string().min(1, `the ${what} is empty`).max(max, `a ${what} is at most ${max} characters`));

/** A workspace, project, state or label name. */
export const name = line("name", NAME_MAX);
/** An issue title. */
export const title = line("title", TITLE_MAX);

/** What a backslash escapes in Markdown (CommonMark's ASCII punctuation). */
export const MARKDOWN_PUNCTUATION = /[!-/:-@[-`{-~]/g;

/**
 * A refusal a route or a helper throws instead of replying: the app's error handler (app.ts, sendError) answers it with
 * this status and { error, message }, as the routes' own replies are written.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly error: string;
  constructor(status: number, error: string, message: string) {
    super(message);
    this.status = status;
    this.error = error;
  }
}

const TX_STATUS: Record<string, number> = { not_found: 404, forbidden: 403, wrong_account: 403, conflict: 409 };

/** The status a refusal of the write pipeline (TxError) answers with, by its code: anything not listed is a 400. */
export const txStatus = (code: string): number => TX_STATUS[code] ?? 400;

/** The parsed body; a 400 HttpError with what is wrong otherwise. */
export function parse<T>(s: z.ZodType<T>, body: unknown): T {
  const r = s.safeParse(body);
  if (r.success) return r.data;
  throw new HttpError(400, "invalid", z.prettifyError(r.error));
}

/** Counts a hit; throws RateLimited (429 with retry-after) once the key used up its window. */
export function limit(limiter: Limiter, key: string): void {
  if (!limiter.take(key)) throw new RateLimited(limiter.retryAfter(key), "Too many attempts. Try again later.");
}

/**
 * The key a client is counted under: its IPv4 address, or the /64 of its IPv6 one, the least a subscriber is given, so
 * that walking the addresses of its block does not make a client many.
 */
export function clientKey(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const bare = ip.split("%")[0]!.toLowerCase();
  if (bare.startsWith("::ffff:") && bare.includes(".")) return bare.slice(7);
  // An embedded IPv4 address takes the last two groups.
  const groups = (part: string) => (part ? part.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const [head, tail] = bare.split("::") as [string, string?];
  const [h, t] = [groups(head), groups(tail ?? "")];
  const all = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t];
  return `${all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/**
 * A request URL as the log shows it: the secret of an invite link (/join/<secret>, /api/v1/invites/<secret>[/accept])
 * is cut out, since request logs go to Loki and anyone who reads them could join the workspace.
 */
export function redactUrl(url: string): string {
  return url.replace(/^(\/+join\/+|\/+api\/+v1\/+invites\/+)[^/?#]+/, "$1[secret]");
}

/** A URL with a NUL byte, raw or escaped: Postgres refuses NUL in text, and no route of ours takes one. */
export const hasNul = (url: string) => url.includes("\0") || /%00/i.test(url);
