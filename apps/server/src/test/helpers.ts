// Shared pieces of the server integration tests. Each test file imports its own workspaces under random slugs, so
// files can run in parallel against one database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before } from "node:test";
import { generate, type PresetName } from "@rsva/fixtures";
import { parseServerFrame, type ClientFrame, type ServerFrame } from "@rsva/protocol";
import { and, eq } from "drizzle-orm";
import WebSocket from "ws";
import type { Scope } from "@rsva/policy";
import { buildApp, type AppOptions } from "../app.ts";
import type { Mail } from "../auth/mail.ts";
import { sha256 } from "../auth/secret.ts";
import { createSession, forgetSessions } from "../auth/sessions.ts";
import { createToken } from "../auth/tokens.ts";
import { db, schema, sql } from "../db.ts";
import { importBundle } from "../import.ts";
import { TxError } from "../sync/write.ts";

// The pool keeps the process alive: close it when the file's tests are done.
after(() => sql.end({ timeout: 1 }));

export const slug = (prefix = "t") => `${prefix}-${randomUUID().slice(0, 8)}`;

export interface Fixture {
  slug: string;
  workspaceId: string;
  ownerId: string;
  agentId: string;
}

export async function importFixture(preset: PresetName = "sample", s = slug(), seed = 1): Promise<Fixture> {
  const r = await importBundle(generate(preset, { slug: s, seed }));
  const members = await db
    .select({ id: schema.user.id, role: schema.member.role, kind: schema.user.kind })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(eq(schema.member.workspaceId, r.workspaceId));
  return {
    slug: s,
    workspaceId: r.workspaceId,
    ownerId: members.find((m) => m.role === "owner")!.id,
    agentId: members.find((m) => m.kind === "agent")!.id,
  };
}

/** A new member of the workspace with this role; returns the user's id and email. */
export async function addMember(workspaceId: string, role: string, kind: "human" | "agent" = "human"): Promise<{ id: string; email: string }> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const [u] = await db.insert(schema.user).values({ email, name: role, kind }).returning({ id: schema.user.id });
  await db.insert(schema.member).values({ workspaceId, userId: u!.id, role });
  return { id: u!.id, email };
}

export async function lastSyncId(workspaceId: string): Promise<number> {
  const [w] = await db.select({ s: schema.workspace.lastSyncId }).from(schema.workspace).where(eq(schema.workspace.id, workspaceId));
  return w!.s;
}

/** An issue of the workspace with its project's states and labels, for building transactions. */
export async function issueWithRefs(workspaceId: string, projectKey?: string) {
  const { project, issue, workflowState, label } = schema;
  const projects = await db.select().from(project).where(eq(project.workspaceId, workspaceId)).orderBy(project.key);
  const p = projectKey ? projects.find((x) => x.key === projectKey)! : projects[0]!;
  const other = projects.find((x) => x.id !== p.id)!;
  const [i] = await db.select().from(issue).where(and(eq(issue.projectId, p.id))).orderBy(issue.number).limit(1);
  const states = await db.select().from(workflowState).where(eq(workflowState.projectId, p.id)).orderBy(workflowState.position);
  const labels = await db.select().from(label).where(eq(label.projectId, p.id));
  const otherStates = await db.select().from(workflowState).where(eq(workflowState.projectId, other.id));
  const otherLabels = await db.select().from(label).where(eq(label.projectId, other.id));
  return { project: p, other, issue: i!, states, labels, otherStates, otherLabels };
}

/**
 * A server and an imported workspace with its first issue's refs, for a whole test file: set up before its tests, closed
 * after them, `then` once they are. Read the fields inside tests (they are filled by then).
 */
export function fileFixture(then?: (ws: Fixture) => Promise<unknown>): { ws: Fixture; refs: Awaited<ReturnType<typeof issueWithRefs>>; server: Awaited<ReturnType<typeof startServer>> } {
  const f = {} as ReturnType<typeof fileFixture>;
  before(async () => {
    [f.ws, f.server] = await Promise.all([importFixture(), startServer()]);
    f.refs = await issueWithRefs(f.ws.workspaceId);
    // In the same hook: the next hook of a file does not wait for this one.
    await then?.(f.ws);
  });
  after(() => f.server.close());
  return f;
}

/**
 * A server, a sample workspace and the agent's and the owner's tokens, filled before a file's tests and closed after them;
 * `api(path)` is a URL under the workspace (or under another one given by its slug). Read the fields inside tests.
 */
export function apiFixture(): { ws: Fixture; server: Awaited<ReturnType<typeof startServer>>; agent: typeof fetch; owner: typeof fetch; api(path: string, slug?: string): string } {
  const f = {} as ReturnType<typeof apiFixture>;
  before(async () => {
    [f.ws, f.server] = await Promise.all([importFixture(), startServer()]);
    ({ agent: f.agent, owner: f.owner } = await jsonTokens(f.ws));
  });
  after(() => f.server.close());
  f.api = (path, slug = f.ws.slug) => `${f.server.url}/api/v1/workspaces/${slug}${path}`;
  return f;
}

/** A loopback Origin: what a page of the local server sends, and what the guard lets through. */
export const ORIGIN = "http://127.0.0.1";

/** Request headers of a signed-in browser: its session cookie and Origin. */
export async function asUser(userId: string): Promise<Record<string, string>> {
  // A browser session: a terminal's ("cli") makes no new key (routes.ts, freshBrowser).
  const { token } = await createSession(userId, "code", "test");
  return { cookie: `rsva_sid=${token}`, origin: ORIGIN };
}

/** Ages the session of `headers` by `minutes`, past FRESH_MS by default: a cookie stolen some time ago. */
export async function agedSession(headers: Record<string, string>, minutes = 11): Promise<Record<string, string>> {
  const token = headers.cookie!.split("=")[1]!;
  await db.update(schema.session).set({ createdAt: new Date(Date.now() - minutes * 60_000).toISOString() }).where(eq(schema.session.id, sha256(token)));
  forgetSessions();
  return headers;
}

/** Request headers with a new API token of a member. */
export async function asToken(workspaceId: string, userId: string, scope: Scope = "write"): Promise<Record<string, string>> {
  const { secret } = await createToken({ workspaceId, userId, name: "test", scope, createdById: null });
  return { authorization: `Bearer ${secret}` };
}

/** fetch that sends JSON with the agent's token, and with the owner's own token. */
export async function jsonTokens(ws: Fixture): Promise<{ agent: typeof fetch; owner: typeof fetch }> {
  const json = { "content-type": "application/json" };
  return {
    agent: fetchAs({ ...(await asToken(ws.workspaceId, ws.agentId)), ...json }),
    owner: fetchAs({ ...(await asToken(ws.workspaceId, ws.ownerId)), ...json }),
  };
}

/** fetch with these headers added to every request. */
export const fetchAs =
  (headers: Record<string, string>): typeof fetch =>
  (url, init = {}) =>
    fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });

export async function startServer(opts: AppOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const app = buildApp({ logLevel: "warn", mailer: async () => {}, ...opts });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => app.close() };
}

/** A server and an imported workspace with its first issue's refs; fetch as the owner's browser and as the agent's token. */
export async function serverWithIssue() {
  const [server, ws] = await Promise.all([startServer(), importFixture()]);
  const refs = await issueWithRefs(ws.workspaceId);
  const owner = fetchAs(await asUser(ws.ownerId));
  const agent = fetchAs(await asToken(ws.workspaceId, ws.agentId));
  return { server, ws, refs, owner, agent };
}
export type ServerWithIssue = Awaited<ReturnType<typeof serverWithIssue>>;

/** A WebSocket client that records every frame and can wait for the next one matching a condition. */
export class Client {
  readonly frames: ServerFrame[] = [];
  private waiters: { pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];
  readonly ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const f = parseServerFrame(String(data));
      if (!f) return;
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => (w.pred(f) ? (w.resolve(f), false) : true));
    });
  }

  static async open(url: string, headers: Record<string, string> = {}): Promise<Client> {
    const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws", { headers });
    const c = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return c;
  }

  /** Waits for hello and subscribes to the workspace from its current log position. */
  async subscribe(ws: Pick<Fixture, "slug" | "workspaceId">): Promise<this> {
    await this.next((f) => f.t === "hello", 3000, true);
    this.send({ t: "sub", ws: ws.slug, s: await lastSyncId(ws.workspaceId) });
    return this;
  }

  send(f: ClientFrame | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(f));
  }

  /** The first frame matching `pred` received after this call (or already received, with `seen`). */
  next(pred: (f: ServerFrame) => boolean, timeoutMs = 3000, seen = false): Promise<ServerFrame> {
    if (seen) {
      const hit = this.frames.find(pred);
      if (hit) return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no matching frame in ${timeoutMs} ms; got ${JSON.stringify(this.frames)}`)), timeoutMs);
      this.waiters.push({ pred, resolve: (f) => (clearTimeout(timer), resolve(f)) });
    });
  }

  /** Log numbers of all received delta actions, in order of arrival. */
  actionIds(): number[] {
    return this.frames.flatMap((f) => (f.t === "d" ? f.a.map((a) => a.id) : []));
  }

  close(): void {
    this.ws.close();
  }
}

/** A transaction rejected with this code (and a message matching `msg`). */
export const rejects = (p: Promise<unknown>, code: string, msg?: RegExp) =>
  assert.rejects(p, (e: unknown) => e instanceof TxError && e.code === code && (!msg || msg.test(e.message)));

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts a step ten times, each let through, then an eleventh that answers 429 rate_limited with retry-after: the limit
 * on the starts of the steps that mail the person (auth/routes.ts, freshBrowserMailed). The tenth answer, unread.
 */
export async function tenThenLimited(start: () => Promise<Response>): Promise<Response> {
  let tenth: Response | undefined;
  for (let i = 0; i < 10; i++) assert.equal((tenth = await start()).status, 200);
  await limited(await start());
  return tenth!;
}

/** A 429 rate_limited answer that says how long to wait. */
export async function limited(r: Response): Promise<void> {
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) >= 1);
  assert.equal(((await r.json()) as { error: string }).error, "rate_limited");
}

/** The mail a test server sends, kept to read: `mailer` for startServer, `mailTo` for the next one to an address. */
export function mailbox(): { mails: Mail[]; mailer: (m: Mail) => Promise<void>; mailTo(email: string): Promise<Mail> } {
  const mails: Mail[] = [];
  return {
    mails,
    mailer: async (m) => void mails.push(m),
    // Sending runs after the answer: wait for it.
    async mailTo(email) {
      for (let i = 0; i < 100; i++) {
        const m = mails.findLast((x) => x.to === email);
        if (m) {
          mails.splice(mails.indexOf(m), 1);
          return m;
        }
        await delay(10);
      }
      throw new Error(`no mail to ${email}`);
    },
  };
}
