// A database of a run's own with a synthetic workspace in it: the shared dev database (`rsva`) is migrated by whichever
// worktree ran last, so a run on it fails when another branch has a migration this one lacks (PLNR-393). Worktrees share
// one Postgres: runs on the same name take turns (an advisory lock held until drop, as the tests' global setup does), and
// a name with the process id never waits. Like the tests' rsva_test, the name must end in _test: only such a database is
// ever dropped.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import type { PresetName } from "./generate.ts";

/** A preset of generate.ts or the README demo workspace (demo.ts). */
type Preset = PresetName | "demo";

const ROOT = resolve(import.meta.dirname, "../../..");
const DEFAULT_URL = "postgres://rsva:rsva@127.0.0.1:5438/rsva_test";

export interface FixtureDatabase {
  /** DATABASE_URL of the new database. */
  url: string;
  /** Drops the database and lets the next run on its name go. */
  drop(): Promise<void>;
}

/**
 * Recreates `name` on the Postgres of DATABASE_URL (the compose one when unset), migrates it and imports the preset's
 * workspace under `slug` (apps/server/src/cli/import.ts, as the Perf workflow does).
 */
export async function fixtureDatabase(name: string, preset: Preset, slug: string): Promise<FixtureDatabase> {
  if (!/^[a-z0-9_]+_test$/.test(name)) throw new Error(`refusing to recreate database "${name}": its name must end in _test`);
  const base = new URL(process.env.DATABASE_URL ?? DEFAULT_URL);
  const admin = new URL(base);
  admin.pathname = "/postgres";
  // One connection that lives until drop: the lock is held by its session.
  const sql = postgres(admin.href, { max: 1, max_lifetime: null, onnotice: () => {} });
  const drop = async () => {
    try {
      await sql.unsafe(`drop database if exists ${name} with (force)`);
    } finally {
      // Ending the session releases the lock.
      await sql.end();
    }
  };
  const url = new URL(base);
  url.pathname = `/${name}`;
  const env = { ...process.env, DATABASE_URL: url.href };
  const dir = mkdtempSync(join(tmpdir(), "rsva-fixture-"));
  try {
    await sql`select pg_advisory_lock(hashtext(${name}))`;
    await sql.unsafe(`drop database if exists ${name} with (force)`);
    await sql.unsafe(`create database ${name}`);
    const bundle = join(dir, "bundle.ndjson");
    execFileSync(process.execPath, [join(ROOT, "tools/fixtures/src/cli.ts"), preset, "--slug", slug, "--out", bundle], { env, stdio: "inherit" });
    execFileSync(process.execPath, [join(ROOT, "apps/server/src/cli/import.ts"), bundle], { env, stdio: ["ignore", "ignore", "inherit"] });
  } catch (e) {
    await drop();
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { url: url.href, drop };
}
