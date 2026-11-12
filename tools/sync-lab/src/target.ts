// What the lab runs against. A local server is its own process on its own database, so a scenario may kill it; production
// is `app.rsva.dev`, only ever in the lab's own workspace, with the lab's own tokens.
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fixtureDatabase } from "@rsva/fixtures/database";
import { localServer } from "@rsva/fixtures/server";

export interface Target {
  name: "local" | "prod";
  url: string;
  ws: string;
  /** Two people, as two computers need: the workspace's owner and a member. */
  tokens: { a: string; b: string };
  /** Only a local target: stops the server the hard way (SIGKILL) and starts it again. */
  restart?: (down?: () => Promise<void>) => Promise<void>;
  /** Only a local target: a browser session of one of the two people. */
  session?: (who: "a" | "b") => string;
  stop(): Promise<void>;
}

const ROOT = resolve(import.meta.dirname, "../../..");
const SERVER = join(ROOT, "apps/server/src");
/** One per run: worktrees share a Postgres. */
const DB = `rsva_lab_${process.pid}_test`;

/** A fresh database with the lab fixture, a server on it and tokens for its two people. */
export async function localTarget(ws = "sync-lab", webDist = "/nonexistent"): Promise<Target> {
  const db = await fixtureDatabase(DB, "lab", ws);
  const env = { ...process.env, DATABASE_URL: db.url };
  const auth = (...args: string[]) => execFileSync("node", [join(SERVER, "cli/auth.ts"), ...args, "--ws", ws], { env, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  const people = { a: `owner@${ws}.test`, b: `user1@${ws}.test` };
  const tokens = { a: auth("token", "--user", people.a, "--name", "sync-lab"), b: auth("token", "--user", people.b, "--name", "sync-lab") };

  // Only stderr, and only with LAB_VERBOSE.
  const server = await localServer({
    entry: join(SERVER, "main.ts"),
    env: { DATABASE_URL: db.url, WEB_DIST: webDist, RSVA_MAIL: "log" },
    output: process.env.LAB_VERBOSE ? "stderr" : "quiet",
  });
  return {
    name: "local",
    url: server.url,
    ws,
    tokens,
    session: (who) => auth("session", "--user", people[who]),
    restart: (down) => server.restart(down),
    async stop() {
      await server.kill("SIGKILL");
      await db.drop();
    },
  };
}

/** Production, only in a lab workspace (its slug starts with sync-lab): no flag can point a chaos run at real work. */
export function prodTarget(url: string, ws: string, tokens: { a: string; b: string }): Target {
  if (!ws.startsWith("sync-lab")) throw new Error(`the lab runs only in a workspace whose slug starts with sync-lab, not ${ws}`);
  return { name: "prod", url, ws, tokens, async stop() {} };
}
