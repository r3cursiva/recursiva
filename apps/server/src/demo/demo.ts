// The public demo (RSVA_DEMO=on): an instance of its own whose one workspace, Lumen (lumen.ts), anyone can walk into with
// no sign-up. A visitor becomes a member "Visitor 4821" of it, so visitors see each other's changes live, and the whole
// database starts over every day. It holds nothing else: the server refuses to run in this mode on a database with other
// workspaces or people, and with mail or Telegram set up (a visitor's invite or notification must reach nobody).
import { randomInt, randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { DEMO } from "@rsva/protocol";
import { and, eq, like, ne, notLike, sql as dsql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createToken, revokeToken } from "../auth/tokens.ts";
import { db, schema, sql } from "../db.ts";
import { HttpError } from "../http.ts";
import { importBundle } from "../import.ts";
import { addMember } from "../sync/members.ts";
import { applyServerChange } from "../sync/write.ts";
import { backdateDemo, demo, DEMO_AGENTS, DEMO_CYCLES, DEMO_DELEGATES, DEMO_FINISHED, DEMO_OWNER } from "./lumen.ts";

const { workspace, user } = schema;


/** How long the demo lives before it starts over, and how often that is checked. */
const DEMO_LIFE_MS = 24 * 3_600_000;
const CHECK_MS = 10 * 60_000;

/** Most visitors between two starts: past it the door closes until the next one. */
const VISITORS_MAX = 5000;

const visitorEmails = like(user.email, `%@${DEMO.emailDomain}`);

/**
 * The demo's preconditions, at start: an error names the one that fails. The database holds the demo and nothing else
 * (its people are the bundle's example.com ones and visitors), and nothing is set up that could send mail or messages.
 */
export async function checkDemo(env: NodeJS.ProcessEnv): Promise<void> {
  if (env.RESEND_API_KEY) throw new Error("RSVA_DEMO=on with RESEND_API_KEY: the demo sends no mail");
  if (env.TELEGRAM_BOT_TOKEN) throw new Error("RSVA_DEMO=on with TELEGRAM_BOT_TOKEN: the demo sends no messages");
  const [other] = await db.select({ slug: workspace.slug }).from(workspace).where(ne(workspace.slug, DEMO.slug)).limit(1);
  if (other) throw new Error(`RSVA_DEMO=on on a database with workspace "${other.slug}": the demo needs a database of its own`);
  const [person] = await db
    .select({ email: user.email })
    .from(user)
    .where(and(eq(user.kind, "human"), notLike(user.email, "%@example.com"), notLike(user.email, `%@${DEMO.emailDomain}`)))
    .limit(1);
  if (person) throw new Error("RSVA_DEMO=on on a database with real people in it: the demo needs a database of its own");
}

/** The demo workspace's id; null before the first seed. */
async function demoWorkspace(): Promise<{ id: string } | null> {
  const [w] = await db.select({ id: workspace.id }).from(workspace).where(eq(workspace.slug, DEMO.slug));
  return w ?? null;
}

/** When a row with this id was made: a UUIDv7 (uuidv7() in Postgres 18) starts with its milliseconds. */
const madeAt = (id: string): number => parseInt(id.replace(/-/g, "").slice(0, 12), 16);

/**
 * Makes the demo workspace if there is none: the bundle, then what a bundle cannot carry through the agents' API, as the
 * people of the demo (cycles, finished issues, delegations, the agents' questions to Maya), then the log's dates moved
 * back so the cycle's burn-up has a past. Before the server listens: nothing has read the log yet.
 */
export async function seedDemo(app: FastifyInstance): Promise<boolean> {
  if (await demoWorkspace()) return false;
  await importBundle(demo());
  const ws = (await demoWorkspace())!;
  const tokens: string[] = [];
  const tokenOf = async (email: string) => {
    const [u] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    const t = await createToken({ workspaceId: ws.id, userId: u!.id, name: "demo seed", scope: "write", createdById: null, expiresAt: new Date(Date.now() + 10 * 60_000) });
    tokens.push(t.id);
    return t.secret;
  };
  const owner = await tokenOf(DEMO_OWNER);
  const atlas = await tokenOf(DEMO_AGENTS.atlas);
  // A host the guard lets in (guard.ts): a deployed server takes only its own.
  const host = process.env.RSVA_ALLOWED_HOSTS?.split(",")[0]?.trim() || "localhost";
  const api = async (token: string, method: "POST" | "PATCH", path: string, body: unknown) => {
    const r = await app.inject({ method, url: `/api/v1/workspaces/${DEMO.slug}${path}`, headers: { host, authorization: `Bearer ${token}` }, payload: body as object });
    if (r.statusCode >= 300) throw new Error(`demo seed: ${method} ${path}: HTTP ${r.statusCode} ${r.body}`);
  };
  try {
    const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    for (const [project, name, start, end, numbers] of DEMO_CYCLES) {
      await api(owner, "POST", "/cycles", { project, name, startDate: day(start), endDate: day(end) });
      for (const n of numbers) await api(owner, "PATCH", `/issues/${project}-${n}`, { cycle: name });
    }
    for (const [issue] of DEMO_FINISHED) await api(owner, "PATCH", `/issues/${issue}`, { state: "Done" });
    for (const [issue, agent] of DEMO_DELEGATES) await api(owner, "PATCH", `/issues/${issue}`, { delegate: DEMO_AGENTS[agent] });
    // What lands in Maya's inbox: the agents ask, and only a comment made now does that (an imported one is history).
    const ask = (issue: string, text: string) => api(atlas, "POST", `/issues/${issue}/comments`, { body: `[](mention:${DEMO_OWNER}) ${text}` });
    await ask("API-1", "The limit is in a PR: the 11th request in an hour gets 429, tests pass, CI is green. Is 10 an hour per address too strict for a team behind one office address? I need your call before I merge.");
    await ask("MOB-6", "The share extension creates an issue in the project you last used; a project picker is a follow-up. Is it fine to ship without it?");
  } finally {
    for (const id of tokens) await revokeToken(ws.id, id);
  }
  await backdateDemo(sql, ws.id);
  return true;
}

/**
 * A visitor walks in: a person of their own (their changes are theirs, and so is their write budget) and a member of
 * the demo workspace, announced to the visitors already in it. The caller opens their session.
 */
export async function enterDemo(): Promise<string> {
  const ws = await demoWorkspace();
  if (!ws) throw new HttpError(503, "unavailable", "The demo is starting. Try again in a minute.");
  const [count] = await db.select({ n: dsql<number>`count(*)::int` }).from(user).where(visitorEmails);
  if (count!.n >= VISITORS_MAX) throw new HttpError(503, "unavailable", "The demo is full for today. Try again tomorrow.");
  const [u] = await db
    .insert(user)
    .values({ email: `visitor-${randomUUID()}@${DEMO.emailDomain}`, name: `Visitor ${randomInt(1000, 10_000)}`, kind: "human" })
    .returning({ id: user.id });
  await applyServerChange(ws.id, u!.id, async (tx) => {
    const added = await addMember(tx, ws.id, u!.id, "member");
    return added ? [added] : [];
  });
  return u!.id;
}

/** A day of the demo: since its seed, who walked in, how many of them changed something, and how many changes. */
interface DemoDay {
  since: string;
  visitors: number;
  active: number;
  changes: number;
}

/**
 * The day so far, read from the log: a visitor's own entry (the User action that announced them) is no change of theirs.
 * Null before the first seed.
 */
async function demoDay(): Promise<DemoDay | null> {
  const ws = await demoWorkspace();
  if (!ws) return null;
  const [r] = await sql<{ visitors: number; active: number; changes: number }[]>`
    select (select count(*)::int from "user" where email like ${`%@${DEMO.emailDomain}`}) as visitors,
      count(distinct a.actor_id)::int as active, count(*)::int as changes
    from sync_action a join "user" u on u.id = a.actor_id
    where a.workspace_id = ${ws.id} and a.model <> 'User' and u.email like ${`%@${DEMO.emailDomain}`}`;
  return { since: new Date(madeAt(ws.id)).toISOString(), ...r! };
}

/**
 * Keeps the day before the data goes: a line of JSON in demo-days.jsonl in the files directory (RSVA_FILES_DIR), which
 * the reset does not touch, and the log. Without the directory, the log alone.
 */
export async function keepDemoDay(dir: string | undefined, log: { info: (o: object, m: string) => void }): Promise<void> {
  const day = await demoDay();
  if (!day) return;
  log.info({ ...day }, "a day of the demo");
  if (dir) await appendFile(join(dir, "demo-days.jsonl"), JSON.stringify(day) + "\n");
}

/**
 * Every day the demo starts over: past its age, the day is kept (keepDemoDay), every table is emptied and the process
 * ends, and the next start seeds a fresh copy (the container is restarted by Docker). A process that ends drops every
 * cache and socket with the data.
 */
export function demoResets(log: { info: (o: object, m: string) => void; error: (e: unknown, m: string) => void }): void {
  const check = async () => {
    const ws = await demoWorkspace();
    if (!ws || Date.now() - madeAt(ws.id) < DEMO_LIFE_MS) return;
    await checkDemo(process.env);
    await keepDemoDay(process.env.RSVA_FILES_DIR, log).catch((e: unknown) => log.error(e, "the demo's day was not kept"));
    const tables = await sql<{ name: string }[]>`select tablename as name from pg_tables where schemaname = 'public'`;
    await sql.unsafe(`truncate table ${tables.map((t) => `"${t.name}"`).join(", ")} restart identity cascade`);
    log.info({ tables: tables.length }, "the demo starts over");
    process.exit(0);
  };
  setInterval(() => void check().catch((e: unknown) => log.error(e, "demo reset failed")), CHECK_MS).unref();
}
