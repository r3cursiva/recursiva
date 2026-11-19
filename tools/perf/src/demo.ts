// The demo workspace "Lumen" (apps/server/src/demo) in a database of its own, ready to look at: `pnpm demo:seed` recreates
// rsva_demo_test and starts the production build on it in demo mode (RSVA_DEMO=on), which seeds the workspace itself,
// and leaves both for you; it prints how to sign in. `pnpm demo:shots` (shots.ts) does the same, takes the pictures and
// drops it (RSVA-587).
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DEMO } from "@rsva/protocol";
import { fixtureDatabase, type FixtureDatabase } from "@rsva/fixtures/database";
import { localServer, type LocalServer } from "@rsva/fixtures/server";
import { ROOT } from "./report.ts";

export interface Demo {
  db: FixtureDatabase;
  server: LocalServer;
  /** Maya's session, the workspace's owner, a cookie value (apps/server/src/cli/auth.ts). */
  session: string;
}

/** Starts the demo on `port` (the production build: pnpm build); the server seeds Lumen before it listens. */
export async function startDemo(port: number): Promise<Demo> {
  const db = await fixtureDatabase("rsva_demo_test", null);
  try {
    // RSVA_NOTIFY=off: the seed's mentions would otherwise go to the log as mail.
    const server = await localServer({ entry: join(ROOT, "apps/server/dist/main.js"), port, env: { DATABASE_URL: db.url, LOG_LEVEL: "warn", RSVA_MAIL: "log", RSVA_NOTIFY: "off", RSVA_DEMO: "on" }, output: "stderr" });
    const session = execFileSync(process.execPath, [join(ROOT, "apps/server/src/cli/auth.ts"), "session", "--ws", DEMO.slug], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: db.url },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { db, server, session };
  } catch (e) {
    await db.drop();
    throw e;
  }
}

if (process.argv[1] === import.meta.filename) {
  const port = Number(process.env.DEMO_PORT ?? 3898);
  const demo = await startDemo(port);
  console.log(`The demo is at ${demo.server.url}: "Enter the demo" there signs you in as a visitor (database ${demo.db.url}).`);
  console.log(`As Maya, the owner: the cookie rsva_sid=${demo.session}.`);
  process.on("SIGINT", () => void demo.server.kill().then(() => process.exit(0)));
}
