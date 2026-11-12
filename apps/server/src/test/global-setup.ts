// Runs once per `node --test` run (--test-global-setup): recreates the test database and applies migrations.
//
// DATABASE_URL picks the database; unset, it is rsva_test in the compose Postgres. Only a database whose name ends
// in _test is ever dropped, so a DATABASE_URL left pointing at real data stops the run instead of wiping it.
// Runs from several worktrees share one Postgres: an advisory lock held for the whole run makes them take turns.
import postgres from "postgres";

const DEFAULT_URL = "postgres://rsva:rsva@127.0.0.1:5438/rsva_test";

let admin: postgres.Sql | null = null;

export async function globalSetup(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_URL);
  const name = url.pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(name)) throw new Error(`refusing to recreate database "${name}": test databases must end in _test`);
  // Children (one process per test file) inherit the environment.
  process.env.DATABASE_URL = url.href;

  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  admin = postgres(adminUrl.href, { max: 1, onnotice: () => {} });
  await admin`select pg_advisory_lock(hashtext(${name}))`;
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`create database ${name}`);

  const { migrateDb, sql } = await import("../db.ts");
  await migrateDb();
  await sql.end();
}

export async function globalTeardown(): Promise<void> {
  // Ending the session releases the lock.
  await admin?.end();
}
