// The agent API over HTTP (docs/agents-api.md). The token comes from RSVA_TOKEN or the macOS Keychain, goes out in a
// header and nowhere else: not in argv, not in any output. The TUI may go as the person instead: the session of
// `rsva login` (PLNR-323), sent as `Authorization: Session …`.
import type { TerminalSession, WorkspaceListItem } from "@rsva/protocol";
import { issuePath } from "@rsva/schema/models";
import { readSecret } from "./keychain.ts";
import { plain } from "./text.ts";

type Env = Record<string, string | undefined>;

/** An answer that is not 2xx, as the server worded it. */
export class ApiError extends Error {
  /** The HTTP status: 401 is a credential the server no longer knows. */
  readonly status: number;
  readonly suggestions: readonly string[];
  /** The server's answer as it came, for a refusal that carries more than its message (a 409 "similar" lists the issues). */
  readonly body: unknown;
  constructor(message: string, status: number, suggestions: readonly string[] = [], body?: unknown) {
    super(message);
    this.status = status;
    this.suggestions = suggestions;
    this.body = body;
  }
}

/** A mistake in the call or the setup: printed without a stack, exit code 2. */
export class UsageError extends Error {}

/** No answer: the server could not be reached, or the answer broke off. Any other error is a bug and keeps its stack. */
export class NetworkError extends Error {}

/**
 * What the CLI and the TUI say of an error, and their exit code: 2 a mistake in the call, 1 a refusal by the server (with
 * its suggestions) or a failure on the way. The text through `plain`: the server wrote it (text.ts). Null for anything
 * else: a bug.
 */
export function failure(e: unknown): { code: 1 | 2; text: string } | null {
  if (e instanceof UsageError) return { code: 2, text: plain(e.message) };
  if (e instanceof ApiError) return { code: 1, text: plain(`${e.message}${e.suggestions.length ? `\ntry: ${e.suggestions.join(", ")}` : ""}`) };
  if (e instanceof NetworkError) return { code: 1, text: plain(e.message) };
  return null;
}

/** The Keychain service of the terminal's session (rsva login). */
export const SESSION_SERVICE = "rsva-session";

/** The Keychain service of the agents' token: a token's default without RSVA_KEYCHAIN, and what a dispatched agent runs on. */
export const AGENT_SERVICE = "rsva-bot";

/** What a signed-in terminal calls itself: Settings › Security lists it as "Terminal on macOS" (server, device.ts). */
const USER_AGENT = `rsva/cli (${process.platform === "darwin" ? "Macintosh; Mac OS X" : process.platform})`;

const keychainToken = (service: string) => readSecret(service).catch(() => Promise.reject(new UsageError(`no token: set RSVA_TOKEN, or keep one in the Keychain under the service "${service}"`)));
const keychainSession = () => readSecret(SESSION_SERVICE).catch(() => Promise.reject(new UsageError("not signed in: rsva login")));

/** fetch's failure in words: a TypeError with the reason in `cause`, or a DOMException when the time is up. */
const unreached = (e: unknown) => {
  if (!(e instanceof TypeError) && !(e instanceof DOMException)) return e;
  const cause = e.cause as { code?: string; message?: string } | undefined;
  return new NetworkError(`${e.message}${cause ? `: ${cause.code ?? cause.message}` : ""}`);
};

/** A busy server's wait that is short enough to sit out once: 503 says one second (docs/agents-api.md). */
const RETRY_MAX_S = 5;

/** How long an answer may take: a file of up to 25 MiB on a slow line takes minutes. */
const TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 300_000;
const retryAfter = (res: Response) => {
  if (res.status !== 503 && res.status !== 429) return null;
  const s = Number(res.headers.get("retry-after") ?? (res.status === 503 ? 1 : NaN));
  return Number.isFinite(s) && s >= 0 && s <= RETRY_MAX_S ? s : null;
};

export type Query = Record<string, string | undefined>;
type Refusal = { message?: string; errors?: { suggestions?: string[] }[] };

export class Client {
  private readonly env: Env;
  private readonly url: URL;
  /** The person's terminal session rather than a token: every workspace they are in. */
  readonly session: boolean;
  private token: Promise<string> | undefined;
  private slug: string | undefined;
  private finding: Promise<string> | undefined;

  constructor(env: Env, opts: { session?: boolean } = {}) {
    this.env = env;
    this.session = opts.session ?? false;
    if (env.RSVA_URL !== undefined && !URL.canParse(env.RSVA_URL)) throw new UsageError("RSVA_URL: not a URL");
    this.url = new URL(env.RSVA_URL ?? "https://app.rsva.dev");
    this.slug = env.RSVA_WS || undefined;
  }

  /**
   * The workspace's slug: RSVA_WS, else the one the token belongs to (a token opens exactly one), asked once. Setting
   * RSVA_WS saves that request.
   */
  workspaceSlug(): Promise<string> {
    if (this.slug) return Promise.resolve(this.slug);
    return (this.finding ??= this.workspaces().then((list) => {
      if (list.length !== 1) throw new UsageError(list.length ? "several workspaces: set RSVA_WS" : "the token opens no workspace: set RSVA_WS");
      return (this.slug = list[0]!.slug);
    }));
  }

  /** The workspaces this credential opens: a token's one, every one of a signed-in person. */
  workspaces(): Promise<WorkspaceListItem[]> {
    return this.send("GET", new URL("/sync/workspaces", this.url.origin));
  }

  /** The same server and credential in another workspace. */
  in(slug: string): Client {
    const c = new Client({ ...this.env, RSVA_WS: slug }, { session: this.session });
    c.token = this.token;
    return c;
  }

  /** Trades the one-time code from Settings › Security for the terminal's session (POST /auth/terminal). */
  signIn(code: string): Promise<TerminalSession> {
    return this.send("POST", new URL("/auth/terminal", this.url.origin), { type: "application/json", data: JSON.stringify({ code }) }, false);
  }

  /** Ends the terminal's session on the server (POST /auth/sign-out). */
  signOut(): Promise<void> {
    return this.send("POST", new URL("/auth/sign-out", this.url.origin));
  }

  /** The slug once known (workspaceSlug): where the TUI's sync engine connects. */
  get workspace(): string {
    if (!this.slug) throw new Error("the workspace is not known yet: await workspaceSlug() first");
    return this.slug;
  }

  /** Where an issue opens in the app (the web's /:ws/browse/:key). Known after any request, or after workspaceSlug(). */
  browse(key: string): string {
    return `${this.url.origin}${issuePath(encodeURIComponent(this.workspace), encodeURIComponent(key))}`;
  }

  private async at(prefix: string, path: string): Promise<URL> {
    return new URL(`${this.url.origin}${prefix}/${encodeURIComponent(await this.workspaceSlug())}${path}`);
  }

  /** An address in the server's text as a browser opens it: `/files/…` on this server, an absolute one as it is. */
  resolve(href: string): string | undefined {
    if (/^https?:\/\//i.test(href)) return href;
    return href.startsWith("/") && !href.startsWith("//") ? `${this.url.origin}${href}` : undefined;
  }

  /** The server's origin, for a connection the TUI opens itself. */
  get origin(): string {
    return this.url.origin;
  }

  /** The Authorization header's value, for a connection the TUI opens itself. */
  async authorization(): Promise<string> {
    return `${this.session ? "Session" : "Bearer"} ${await this.secret()}`;
  }

  /** A token or a session in the clear is a stolen one, except to this machine. */
  private safe(): void {
    if (this.url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(this.url.hostname)) throw new UsageError(`RSVA_URL: https only, got ${this.url.origin}`);
  }

  private async secret(): Promise<string> {
    this.safe();
    const { RSVA_TOKEN, RSVA_SESSION, RSVA_KEYCHAIN: service = AGENT_SERVICE } = this.env;
    const env = this.session ? RSVA_SESSION : RSVA_TOKEN;
    if (!env && process.platform !== "darwin") throw new UsageError(this.session ? "not signed in: set RSVA_SESSION" : "no token: set RSVA_TOKEN");
    const token = env || (await (this.token ??= this.session ? keychainSession() : keychainToken(service)));
    // fetch would quote a value it cannot send in its error, and the error is printed.
    if (!/^[\x21-\x7e]+$/.test(token)) throw new UsageError("the token has characters a header cannot carry");
    return token;
  }

  /** The answer's JSON, null for an empty one. A GET the server is too busy for is asked once more after its short wait. */
  async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = await this.at("/api/v1/workspaces", path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    return this.send<T>(method, url, opts.body === undefined ? undefined : { type: "application/json", data: JSON.stringify(opts.body) });
  }

  /** Uploads a file's bytes to the workspace under their SHA-256 (PUT /files/:ws/:sha256, docs/agents-api.md). */
  async upload(sha256: string, bytes: Uint8Array, type: string): Promise<{ size: number; mime: string }> {
    return this.send("PUT", await this.at("/files", `/${sha256}`), { type, data: bytes });
  }

  private async send<T>(method: string, url: URL, body?: { type: string; data: string | Uint8Array }, signedIn = true): Promise<T> {
    // brotli: a list of 100 issues is 18–45 KB of JSON and about 3–7 KB compressed, inside TCP's first flight (PLNR-234).
    const headers: Record<string, string> = { "accept-encoding": "br, gzip", "user-agent": USER_AGENT };
    // Unsigned, a sign-in still sends a code and gets a session back: the same https rule.
    if (signedIn) headers.authorization = await this.authorization();
    else this.safe();
    if (body) headers["content-type"] = body.type;
    const send = async () => {
      // No redirects: the API has none, and following one would send the body past the https check above.
      const res = await fetch(url, { method, headers, redirect: "error", signal: AbortSignal.timeout(body?.data instanceof Uint8Array ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS), ...(body ? { body: body.data as NonNullable<RequestInit["body"]> } : {}) });
      return { res, text: await res.text() };
    };
    let answer = await send().catch((e: unknown) => Promise.reject(unreached(e)));
    const wait = method === "GET" ? retryAfter(answer.res) : null;
    if (wait !== null) {
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      answer = await send().catch((e: unknown) => Promise.reject(unreached(e)));
    }
    const { res, text } = answer;
    let data: (T & Refusal) | null;
    try {
      data = (text ? JSON.parse(text) : null) as (T & Refusal) | null;
    } catch {
      // Not the server's answer: a proxy's error page, say.
      throw new ApiError(`${res.status} ${res.statusText}: the answer is not JSON`, res.status);
    }
    if (res.ok) return data as T;
    const after = res.headers.get("retry-after");
    throw new ApiError((data?.message ?? `${res.status} ${res.statusText}`) + (after ? ` (retry after ${after} s)` : ""), res.status, data?.errors?.flatMap((e) => e.suggestions ?? []), data);
  }
}
