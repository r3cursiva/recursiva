// The real git behind Repo.changes, in a repository of its own: release.test.ts stands in for all of it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { gitRepo } from "./repo.ts";

const MIGRATIONS = "packages/schema/migrations";
let root: string;
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "diff.renames=copies", ...args], { cwd: root, encoding: "utf8" }).trim();

function commit(files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git("add", ".");
  git("commit", "-q", "-m", Object.keys(files)[0]!);
  return git("rev-parse", "HEAD");
}

const journal = (n: number) => JSON.stringify({ entries: Array.from({ length: n }, (_, idx) => ({ idx })) });

before(() => {
  root = mkdtempSync(join(tmpdir(), "release-repo-"));
  git("init", "-q");
  mkdirSync(join(root, "tools/release/src"), { recursive: true });
});
after(() => rmSync(root, { recursive: true, force: true }));

test("changes finds migrations and the total from a subdirectory, as the CLI runs it", async () => {
  const from = commit({ "packages/protocol/src/index.ts": "export const PROTOCOL_VERSION = 13;", [`${MIGRATIONS}/0000_init.sql`]: "CREATE TABLE a (id int);", [`${MIGRATIONS}/meta/_journal.json`]: journal(1), "apps/a.ts": "1" });
  const to = commit({
    // Like the file before it: under diff.renames=copies it must still be an addition.
    [`${MIGRATIONS}/0001_more.sql`]: "CREATE TABLE a (id int);",
    [`${MIGRATIONS}/0002_drop.sql`]: "DROP TABLE a;",
    [`${MIGRATIONS}/meta/0001_snapshot.json`]: "{}",
    [`${MIGRATIONS}/meta/_journal.json`]: journal(3),
  });
  const change = await gitRepo(join(root, "tools/release/src")).changes(from, to);
  assert.deepEqual(change?.migrations, [
    { file: "0001_more.sql", risky: [] },
    { file: "0002_drop.sql", risky: ["DROP TABLE a;"] },
  ]);
  assert.equal(change?.schema, 3);
});

test("no migrations between two commits, the total stays", async () => {
  const from = git("rev-parse", "HEAD");
  const to = commit({ "apps/a.ts": "2" });
  const change = await gitRepo(root).changes(from, to);
  assert.deepEqual(change?.migrations, []);
  assert.equal(change?.schema, 3);
});
