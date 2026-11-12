// The demo workspace "Lumen" (tools/fixtures/src/demo.ts) in a database of its own, ready to look at: `pnpm demo:seed`
// recreates rsva_demo_test, imports the bundle, adds what a bundle cannot carry (cycles, the agents' delegation, the
// agents' questions to the owner) through the API of a server of its own and leaves the database for you; it prints how
// to run the app on it. `pnpm demo:shots` (shots.ts) does the same, takes the pictures and drops it (RSVA-587).
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { backdateDemo, DEMO_AGENTS, DEMO_CYCLES, DEMO_DELEGATES, DEMO_FINISHED, DEMO_OWNER, DEMO_SLUG } from "@rsva/fixtures/demo";
import { fixtureDatabase, type FixtureDatabase } from "@rsva/fixtures/database";
import { localServer, type LocalServer } from "@rsva/fixtures/server";
import { ROOT } from "./report.ts";

export interface Demo {
  db: FixtureDatabase;
  server: LocalServer;
  /** The owner's session, a cookie value (apps/server/src/cli/auth.ts). */
  session: string;
}

const auth = (db: FixtureDatabase, ...args: string[]) =>
  execFileSync(process.execPath, [join(ROOT, "apps/server/src/cli/auth.ts"), ...args, "--ws", DEMO_SLUG], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: db.url },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

/** Imports the demo workspace into a fresh `rsva_demo_test` and serves it on `port` (the production build: pnpm build). */
export async function startDemo(port: number): Promise<Demo> {
  const db = await fixtureDatabase("rsva_demo_test", "demo", DEMO_SLUG);
  try {
    const server = await localServer({ entry: join(ROOT, "apps/server/dist/main.js"), port, env: { DATABASE_URL: db.url, LOG_LEVEL: "warn", RSVA_MAIL: "log" }, output: "stderr" });
    try {
      const as = (email: string) => auth(db, "token", "--user", email, "--name", "demo");
      await addTheRest(server.url, as(DEMO_OWNER), { atlas: as(DEMO_AGENTS.atlas) });
      await server.restart(() => backdateDemo(db.url));
      return { db, server, session: auth(db, "session") };
    } catch (e) {
      await server.kill();
      throw e;
    }
  } catch (e) {
    await db.drop();
    throw e;
  }
}

async function addTheRest(url: string, owner: string, agents: { atlas: string }): Promise<void> {
  const api = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${url}/api/v1/workspaces/${DEMO_SLUG}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${await r.text()}`);
  };
  const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  for (const [project, name, start, end, numbers] of DEMO_CYCLES) {
    await api(owner, "POST", "/cycles", { project, name, startDate: day(start), endDate: day(end) });
    for (const n of numbers) await api(owner, "PATCH", `/issues/${project}-${n}`, { cycle: name });
  }
  for (const [issue] of DEMO_FINISHED) await api(owner, "PATCH", `/issues/${issue}`, { state: "Done" });
  for (const [issue, agent] of DEMO_DELEGATES) await api(owner, "PATCH", `/issues/${issue}`, { delegate: DEMO_AGENTS[agent] });
  // What lands in the owner's Inbox: the agents ask, and only a comment made now does that (an imported one is history).
  const ask = (issue: string, text: string) => api(agents.atlas, "POST", `/issues/${issue}/comments`, { body: `[](mention:${DEMO_OWNER}) ${text}` });
  await ask("API-1", "The limit is in a PR: the 11th request in an hour gets 429, tests pass, CI is green. Is 10 an hour per address too strict for a team behind one office address? I need your call before I merge.");
  await ask("MOB-6", "The share extension creates an issue in the project you last used; a project picker is a follow-up. Is it fine to ship without it?");
}

if (process.argv[1] === import.meta.filename) {
  const port = Number(process.env.DEMO_PORT ?? 3898);
  const demo = await startDemo(port);
  console.log(`Demo workspace "${DEMO_SLUG}" is in ${demo.db.url} (owner ${DEMO_OWNER}), served at ${demo.server.url} until you press Ctrl-C.`);
  console.log(`Sign in with the cookie rsva_sid=${demo.session} (docs/status.md: "Войти в локальный интерфейс без письма").`);
  console.log(`To run the dev server on it instead: DATABASE_URL=${demo.db.url} pnpm dev`);
  process.on("SIGINT", () => void demo.server.kill().then(() => process.exit(0)));
}
