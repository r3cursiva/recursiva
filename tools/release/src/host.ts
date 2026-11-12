// The host side of a release: every command run on rsva over ssh, as root (docs/stand-rsva.md). Secrets stay there.
import { spawn } from "node:child_process";
import { parseCounts, parseStatus } from "./plan.ts";
import { attempt, run, runWithInput } from "./run.ts";
import type { Host, Site } from "./release.ts";

export const SSH_HOST = "rsva";
const ORIGIN = "https://app.rsva.dev";
/** The other sites on the same server, whose answers a release must not change: RSVA_RELEASE_NEIGHBOURS, comma-separated URLs. */
const NEIGHBOURS = (process.env.RSVA_RELEASE_NEIGHBOURS ?? "").split(",").filter(Boolean);
const DUMPS = "/var/backups/rsva/recursiva/db";
const LOCK = "/run/lock/rsva-release";
const COUNTS = `select (select count(*) from issue), (select count(*) from project), (select count(*) from comment),
  (select coalesce(max(id), 0) from sync_action), (select count(*) from drizzle.__drizzle_migrations)`;

const ssh = (script: string) => run("ssh", [SSH_HOST, script]);

/**
 * The database in its container (compose.yaml, service db). The local development stack has the same names, so these
 * serve `pnpm plane:sync`'s copies on this machine too; `db` picks one of its databases, `rsva` is the live one.
 */
export const DB_CONTAINER = "rsva-db-1";
export const psql = (db = "rsva") => `docker exec ${DB_CONTAINER} psql -U rsva -d ${db}`;
/** The live database as a custom-format dump on stdout. */
export const LIVE_DUMP = `docker exec ${DB_CONTAINER} pg_dump -U rsva -d rsva -Fc`;

/**
 * How a new copy of a host file (`$f.new`) is checked before it replaces the file. compose.yaml as rsva-deploy reads
 * it, with the host's rsva.env: a variable it requires and rsva.env lacks fails here, not in the switch, where
 * the rollback would read the same file and fail too. Compose names the missing variables, never their values.
 */
const CHECKS: Record<string, string> = {
  "/opt/rsva/compose.yaml": `docker compose -p rsva --project-directory /opt/rsva --env-file /opt/rsva/rsva.env -f "$f.new" config -q`,
  "/usr/local/sbin/rsva-deploy": `bash -n "$f.new"`,
};
const bundleOf = (html: string): string | null => /\/assets\/(index-[\w-]+\.js)/.exec(html)?.[1] ?? null;

export const sshHost: Host = {
  async status() {
    // It exits non-zero when the server does not answer, and that is an answer too.
    return parseStatus((await attempt("ssh", [SSH_HOST, "rsva-deploy --status"])).stdout);
  },
  async hasImage(tag) {
    return (await attempt("ssh", [SSH_HOST, `docker image inspect rsva:${tag}`])).code === 0;
  },
  async file(path) {
    const r = await attempt("ssh", [SSH_HOST, `cat ${path}`]);
    return r.code === 0 ? r.stdout : null;
  },
  async putFile(path, content, expected, backup) {
    const check = CHECKS[path];
    if (!check) throw new Error(`no check for ${path}`);
    // The paths are the release's own constants; the content arrives on stdin, is checked beside the file, then moved in whole.
    const script = `set -e; f=${path}
      echo "${expected}  $f" | sha256sum -c --status - || { echo "$f changed on the host since the plan" >&2; exit 3; }
      cat > "$f.new"
      ${check} || { rm -f "$f.new"; echo "the new $f does not pass its check: nothing changed" >&2; exit 4; }
      cp -p "$f" ${backup}
      chown --reference="$f" "$f.new"; chmod --reference="$f" "$f.new"
      mv "$f.new" "$f"`;
    await runWithInput("ssh", [SSH_HOST, script], content);
  },
  /**
   * Held by this ssh connection, so it cannot go stale: the remote `cat` ends with the connection, however this
   * process dies, and flock lets go.
   */
  lock() {
    return new Promise((resolve, reject) => {
      const child = spawn("ssh", [SSH_HOST, `flock -n ${LOCK} -c 'echo locked; exec cat' || echo busy`], { stdio: ["pipe", "pipe", "inherit"] });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`ssh for the lock ended early (${code})`)));
      child.stdout.setEncoding("utf8").once("data", (line: string) => {
        if (!line.startsWith("locked")) return resolve(null);
        child.removeAllListeners("exit");
        resolve({
          release: () =>
            new Promise((done) => {
              child.once("exit", () => done());
              child.stdin.end();
            }),
        });
      });
    });
  },
  async dump(tag) {
    const script = `set -e; umask 077; f=${DUMPS}/pre-deploy-${tag}-$(date -u +%Y%m%d-%H%M%S).dump
      ${LIVE_DUMP} > "$f"
      test -s "$f"
      docker exec -i ${DB_CONTAINER} pg_restore --list < "$f" > /dev/null
      echo "$f"`;
    return (await ssh(script)).trim();
  },
  async counts() {
    return parseCounts(await ssh(`${psql()} -Atc "${COUNTS.replaceAll("\n", " ")}"`));
  },
  async now() {
    return (await ssh("date +%s")).trim();
  },
  async switchTo(tag) {
    return (await attempt("ssh", [SSH_HOST, `rsva-deploy ${tag}`])).code === 0;
  },
  async rollback() {
    return (await attempt("ssh", [SSH_HOST, "rsva-deploy --rollback"])).code === 0;
  },
  async runningImage() {
    return (await ssh(`docker inspect rsva-app-1 --format '{{.Config.Image}}'`)).trim();
  },
  async bundle() {
    return bundleOf(await ssh("docker exec rsva-app-1 cat apps/web/dist/index.html"));
  },
  async errorsSince(since) {
    const out = await ssh(`docker logs --since ${since} rsva-app-1 2>&1 | grep -E '"level":(50|60)|"statusCode":5[0-9][0-9]' | cut -c1-300 || true`);
    return out.split("\n").filter(Boolean);
  },
};

const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
const statusOf = (url: string) => get(url).then((r) => r.status, () => 0);

export const publicSite: Site = {
  healthy: async () => (await statusOf(`${ORIGIN}/healthz`)) === 200,
  bundle: () => get(`${ORIGIN}/`).then((r) => r.text()).then(bundleOf, () => null),
  async brokenNeighbours() {
    const answers = await Promise.all(NEIGHBOURS.map(async (url) => ({ url, code: await statusOf(url) })));
    return answers.filter((a) => a.code !== 200).map((a) => `${a.url} ${a.code}`);
  },
};
