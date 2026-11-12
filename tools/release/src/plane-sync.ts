#!/usr/bin/env node
// `pnpm plane:sync <workspace>`: brings a workspace from Plane to app.rsva.dev, with its images and attachments, for as
// long as a workspace is still worked on in Plane. docs/research/plane-db-mapping-2026-10-27.md.
//
// Everything before the import works on copies: a dump of Plane's database from its host, its uploads, a copy of the live
// database. The import is rehearsed on that copy and checked by connectors/plane-db/src/verify.ts; only then the live
// database gets it, after a dump, and is checked the same way. All copies live in one private temporary directory and in
// temporary databases of the local rsva-db-1, and go when the script ends.
// Set PLANE_HOST (an ssh host that runs Plane) and PLANE_URL (where Plane serves uploads).
//
// A repeated import overwrites what it imported, so work done here on the workspace since the last import stops the
// script (--overwrite-edits lets it through), and a workspace that moved here for good is refused outright.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DB_CONTAINER, LIVE_DUMP, psql, SSH_HOST, sshHost } from "./host.ts";
import { moscow, writeJournal } from "./journal.ts";
import { editsFrom, parseActions, refusal } from "./plane-sync-plan.ts";
import { confirm } from "./run.ts";

const HELP = `pnpm plane:sync <workspace> [options]      a workspace from Plane to app.rsva.dev

  --dry-run             stop after the rehearsal on a copy; the live server is not touched
  --yes                 do not ask before importing (needed without a terminal)
  --overwrite-edits     import although the workspace was edited here since the last import: those rows are overwritten
  -h, --help            this text`;

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    "overwrite-edits": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
const slug = positionals[0];
if (v.help || !slug) {
  console.log(HELP);
  process.exit(v.help ? 0 : 1);
}
const refused = refusal(slug);
if (refused) {
  console.error(refused);
  process.exit(1);
}

/** The ssh host Plane runs on (PLANE_HOST). */
const need = (name: string) => process.env[name] || (console.error(`${name} is not set (see the top of this file)`), process.exit(1));
const PLANE_HOST = need("PLANE_HOST");
/** Where Plane serves the workspace's uploads (export.ts --plane-url). */
const PLANE_URL = need("PLANE_URL");
/** The local rsva-db-1 (compose.yaml), a development password. */
const LOCAL = "postgres://rsva:rsva@127.0.0.1:5438";

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const say = (s: string) => console.log(`\n${s}`);

// Long steps run in children: Ctrl-C reaches them, and without handlers it would end this process before `finally`, with
// Plane's password hashes left behind. A signal now ends the step and the script goes through its cleanup.
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => (stopped = true));

/** Runs a bash pipeline; a failure anywhere in it, or a signal, stops the script. */
function bash(script: string, stdio: "inherit" | ["ignore", "pipe", "inherit"], env: Record<string, string> = {}): string {
  const r = spawnSync("bash", ["-c", `set -euo pipefail; ${script}`], { stdio, encoding: "utf8", maxBuffer: 2 ** 26, env: { ...process.env, ...env } });
  if (stopped) throw new Error("stopped");
  if (r.status !== 0) throw new Error(`failed (${r.status}): ${script.slice(0, 200)}`);
  return r.stdout ?? "";
}

/** Output shows. */
const sh = (script: string, env?: Record<string, string>) => void bash(script, "inherit", env);
/** Returns stdout. */
const out = (script: string) => bash(script, ["ignore", "pipe", "inherit"]);

const psqlLocal = (db: string, query: string) => `${psql(db)} -At -F $'\\t' -c ${quote(query)}`;
const psqlLive = (query: string) => `ssh ${SSH_HOST} ${quote(`${psql()} -At -F '|' -c ${quote(query)}`)}`;
const DUMP_PLANE = `docker exec plane-ce-plane-db-1 sh -c ${quote(`pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc`)}`;

function restore(db: string, file: string): void {
  sh(`${psqlLocal("postgres", `create database ${db}`)} > /dev/null
    docker exec -i ${DB_CONTAINER} pg_restore -U rsva -d ${db} --no-owner --no-privileges < ${quote(file)}`);
}

function importLocal(db: string, bundle: string, files: string, store: string): void {
  sh(`node apps/server/src/cli/import.ts --files ${quote(files)} ${quote(bundle)}`, { DATABASE_URL: `${LOCAL}/${db}`, RSVA_FILES_DIR: store });
}

const verify = (planeDb: string, db: string) =>
  sh(`node connectors/plane-db/src/verify.ts --plane ${LOCAL}/${planeDb} --rsva ${LOCAL}/${db} --workspace ${slug}`);

/** The log position of the live workspace, null when it is not there yet; stops on work an import would overwrite. */
function checkLive(): number | null {
  const position = out(psqlLive(`select last_sync_id from workspace where slug = '${slug}'`)).trim();
  if (!position) return null;
  const actions = out(psqlLive(`select s.model, case when jsonb_typeof(s.data) = 'object' then (select string_agg(k, ',') from jsonb_object_keys(s.data) k) end
    from sync_action s join workspace w on w.id = s.workspace_id where w.slug = '${slug}'
    and s.id > coalesce((select max(a.id) from sync_action a where a.workspace_id = w.id and a.model = 'Workspace' and a.action = 'R'), 0)`));
  const edits = editsFrom(parseActions(actions));
  const list = Object.entries(edits).map(([m, n]) => `${m} ${n}`).join(", ");
  if (list && !v["overwrite-edits"]) throw new Error(`"${slug}" was edited here since the last import (${list}). The import would overwrite those rows; --overwrite-edits lets it.`);
  if (list) console.log(`Edits here since the last import will be overwritten: ${list}`);
  return Number(position);
}

const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const databases = { plane: `plane_sync_${stamp}`, rehearsal: `rsva_sync_${stamp}`, after: `rsva_sync_after_${stamp}` };
const dir = await mkdtemp(join(tmpdir(), "plane-sync-"));
const assets = join(dir, "assets");
const files = join(dir, "files");
const bundle = join(dir, "bundle.ndjson");
const incoming = `/opt/rsva/data/files/.plane-sync-${stamp}`;
let touchedLive = false;

/** The live step: from here on a failure leaves the live server changed, and says how to get back. */
async function importLive(): Promise<void> {
  const lock = await sshHost.lock();
  if (!lock) throw new Error("a release is running");
  let safety = "";
  let imported = false;
  try {
    safety = await sshHost.dump(`plane-sync-${slug}`);
    touchedLive = true;
    sh(`COPYFILE_DISABLE=1 tar cf - -C ${quote(files)} . | ssh ${SSH_HOST} ${quote(`set -e; install -d -m 700 -o 3820 -g 3820 ${incoming}; tar xf - -C ${incoming} --no-same-owner; chown -R 3820:3820 ${incoming}`)}`);
    const position = checkLive();
    const expect = position === null ? "" : `--expect-sync-id ${position}`;
    sh(`ssh ${SSH_HOST} ${quote(`docker exec -i rsva-app-1 node apps/server/dist/import-cli.js --files /data/files/${incoming.split("/").at(-1)} ${expect} /dev/stdin`)} < ${quote(bundle)}`);
    imported = true;

    say("5. Check of the live server against Plane's copy");
    sh(`ssh ${SSH_HOST} ${quote(LIVE_DUMP)} > ${quote(join(dir, "after.dump"))}`);
    restore(databases.after, join(dir, "after.dump"));
    verify(databases.plane, databases.after);
    const [issues, comments, blobs, attachments, id] = out(
      psqlLive(`select (select count(*) from issue i where i.workspace_id = w.id), (select count(*) from comment c where c.workspace_id = w.id),
        (select count(*) from blob b where b.workspace_id = w.id), (select count(*) from attachment a where a.workspace_id = w.id and a.kind = 'file'), w.id from workspace w where w.slug = '${slug}'`),
    ).trim().split("|");
    const onDisk = out(`ssh ${SSH_HOST} ${quote(`find /opt/rsva/data/files/${id} -type f | wc -l`)}`).trim();
    if (Number(onDisk) !== Number(blobs)) throw new Error(`${blobs} files in the database, ${onDisk} on disk`);
    console.log(
      await writeJournal(
        `- ${moscow(new Date())} — **пространство \`${slug}\` обновлено из Plane** (\`pnpm plane:sync\`): задач ${issues}, комментариев ${comments}, файлов ${blobs}, из них вложений ${attachments}. \`verify.ts\` на копии и на снимке после импорта без расхождений, файлы на диске сходятся с базой. Дамп до импорта \`${safety}\` (600).`,
        `${slug} synced from Plane`,
      ),
    );
  } catch (e) {
    if (imported) {
      const why = e instanceof Error ? e.message.split("\n")[0] : String(e);
      console.error(`The import is committed, the check after it failed. Dump from before: ${safety}`);
      console.log(await writeJournal(`- ${moscow(new Date())} — **импорт \`${slug}\` из Plane прошёл, проверка после него нет** (\`pnpm plane:sync\`): ${why}. Дамп до импорта \`${safety}\` (600).`, `${slug} sync failed its check`));
    }
    throw e;
  } finally {
    await lock.release();
  }
}

/** Removes every copy; what could not be removed is named, it may hold Plane's password hashes. */
async function cleanUp(): Promise<void> {
  const left: string[] = [];
  for (const db of Object.values(databases)) {
    const r = spawnSync("bash", ["-c", psqlLocal("postgres", `drop database if exists ${db} with (force)`)], { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) left.push(`database ${db} in rsva-db-1`);
  }
  await rm(dir, { recursive: true, force: true }).catch(() => left.push(dir));
  if (touchedLive) {
    const r = spawnSync("ssh", ["-o", "ConnectTimeout=15", SSH_HOST, `rm -rf ${incoming}`], { stdio: "inherit" });
    if (r.status !== 0) left.push(`${incoming} on ${SSH_HOST}`);
  }
  if (left.length) {
    console.error(`Not removed:\n  ${left.join("\n  ")}`);
    process.exitCode = 1;
  }
}

try {
  checkLive();

  say(`1. Plane's database and uploads of "${slug}" from ${PLANE_HOST}`);
  sh(`ssh ${PLANE_HOST} ${quote(DUMP_PLANE)} > ${quote(join(dir, "plane.dump"))}`);
  restore(databases.plane, join(dir, "plane.dump"));
  await mkdir(assets, { mode: 0o700 });
  const script = await readFile("connectors/plane-db/assets.py", "utf8");
  const uploads = `select f.id, f.asset from file_assets f join workspaces w on w.id = f.workspace_id where w.slug = '${slug}' and f.is_uploaded
    and f.deleted_at is null and not f.is_deleted and f.entity_type in ('ISSUE_DESCRIPTION', 'COMMENT_DESCRIPTION', 'ISSUE_ATTACHMENT')`;
  const api = `$(docker ps -qf name='^plane-ce-api-[0-9]+$' | head -1)`;
  sh(`${psqlLocal(databases.plane, uploads)} | ssh ${PLANE_HOST} ${quote(`docker exec -i ${api} python -c ${quote(script)}`)} | tar xf - -C ${quote(assets)}`);

  say("2. The bundle");
  sh(`node connectors/plane-db/src/export.ts --db ${LOCAL}/${databases.plane} --workspace ${slug} --plane-url ${PLANE_URL} --out ${quote(bundle)} --assets ${quote(assets)} --files-out ${quote(files)}`);

  say("3. Rehearsal on a copy of the live server");
  sh(`ssh ${SSH_HOST} ${quote(LIVE_DUMP)} > ${quote(join(dir, "live.dump"))}`);
  restore(databases.rehearsal, join(dir, "live.dump"));
  importLocal(databases.rehearsal, bundle, files, join(dir, "rehearsal-files"));
  verify(databases.plane, databases.rehearsal);
  say("A repeat doubles nothing");
  importLocal(databases.rehearsal, bundle, files, join(dir, "rehearsal-files"));
  verify(databases.plane, databases.rehearsal);

  if (v["dry-run"]) say("Dry run: the live server was not touched.");
  else if (await confirm(`Import "${slug}" into ${SSH_HOST}?`, v.yes)) {
    say("4. The live server");
    await importLive();
  } else say("Not imported.");
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await cleanUp();
}
