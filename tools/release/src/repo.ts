// The repository side of a release: git, the checks and the image of one exact commit, and the Perf report on it.
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contextOf, migrationCount, protocolOf, riskyLines, toTag, type Change, type PerfState } from "./plan.ts";
import { attempt, run } from "./run.ts";
import { SSH_HOST } from "./host.ts";
import type { Repo } from "./release.ts";

const MIGRATIONS = "packages/schema/migrations";
const JOURNAL = `${MIGRATIONS}/meta/_journal.json`;
const PROTOCOL = "packages/protocol/src/index.ts";
const REMOTE = "main";

export function gitRepo(cwd: string): Repo {
  const git = (...args: string[]) => run("git", args, cwd);
  const lines = (out: string) => out.split("\n").filter(Boolean);
  const fileAt = (ref: string, path: string) => git("show", `${ref}:${path}`);
  const latestRun = async (sha: string, workflow: string) => {
    const out = await run("gh", ["run", "list", "--commit", sha, "--workflow", workflow, "--limit", "1", "--json", "status,conclusion,url"], cwd);
    return (JSON.parse(out) as { status: string; conclusion: string; url: string }[])[0];
  };

  return {
    async fetchMain() {
      await git("fetch", "--quiet", "origin", REMOTE);
      return (await git("rev-parse", `origin/${REMOTE}`)).trim();
    },
    async isAncestor(tag, sha) {
      return (await attempt("git", ["merge-base", "--is-ancestor", tag, sha], cwd)).code === 0;
    },
    fileAt,
    async changes(from, to): Promise<Change | null> {
      if ((await attempt("git", ["cat-file", "-e", `${from}^{commit}`], cwd)).code !== 0) return null;
      // :(top): a pathspec is relative to the current directory, and this one is tools/release/src. --no-renames: a new
      // migration that looks like a file the diff touches would be a copy under diff.renames=copies, not an addition.
      const added = lines(await git("diff", "--name-only", "--no-renames", "--diff-filter=A", from, to, "--", `:(top)${MIGRATIONS}`)).filter((f) => f.endsWith(".sql"));
      const [before, after] = await Promise.all([fileAt(from, PROTOCOL), fileAt(to, PROTOCOL)]).then((s) => s.map(protocolOf));
      return {
        commits: lines(await git("log", "--no-merges", "--format=%s", `${from}..${to}`)),
        files: lines(await git("diff", "--name-only", from, to)),
        migrations: await Promise.all(added.map(async (path) => ({ file: path.slice(MIGRATIONS.length + 1), risky: riskyLines(await fileAt(to, path)) }))),
        schema: migrationCount(await fileAt(to, JOURNAL)),
        protocol: before != null && after != null && before !== after ? { from: before, to: after } : null,
      };
    },
    async perfStatus(sha): Promise<PerfState> {
      // A report: a failed lookup must not stop a release.
      const latest = await latestRun(sha, "Perf").catch(() => undefined);
      if (!latest) return "none";
      if (latest.status !== "completed") return "running";
      if (latest.conclusion === "success") return "ok";
      return latest.conclusion === "failure" ? { failed: latest.url } : "none";
    },
    async build(sha, log, checks) {
      // Always the commit itself, in a copy of its own: whatever is uncommitted in any working tree stays out of the image.
      // The tag comes from the commit and from nowhere else: a tag over another commit's build replaces the image (and on
      // this host's containerd store removes the old one) without a word.
      const tag = toTag(sha);
      const root = dirname((await git("rev-parse", "--path-format=absolute", "--git-common-dir")).trim());
      const dir = join(root, ".claude/worktrees", `release-${tag}`);
      await attempt("git", ["worktree", "remove", "--force", dir], cwd);
      await git("worktree", "add", "--quiet", "--detach", dir, sha);
      // A check prints a thousand lines when it passes: the whole output goes to a file, its tail into the error.
      const check = async (...args: string[]) => {
        const r = await attempt("pnpm", args, dir);
        if (r.code === 0) return;
        const out = join(tmpdir(), `rsva-release-${tag}.log`);
        await writeFile(out, `${r.stdout}\n${r.stderr}`);
        throw new Error(`pnpm ${args.join(" ")} failed (${r.code}): not releasing. The whole output: ${out}\n${`${r.stdout}\n${r.stderr}`.trim().slice(-2000)}`);
      };
      try {
        log("Installing dependencies");
        await run("pnpm", ["install", "--frozen-lockfile"], dir);
        if (checks) {
          // What CI on main ran until ADR 0035, on the Mac: pnpm check builds too.
          log("Checking: pnpm check (types, clones, dead code, tests, build, startup size)");
          await check("check");
          log("Checking: pnpm sync:browser (the app in Chromium)");
          // Nothing to do while Playwright's version stays; a newer one downloads its browser here.
          await check("--filter", "@rsva/perf", "exec", "playwright", "install", "chromium-headless-shell");
          await check("sync:browser");
        } else {
          log("Building, no checks");
          await run("pnpm", ["build"], dir);
        }
        log("Sending the build to the host");
        const context = contextOf(await fileAt(sha, "deploy/stand/Dockerfile"));
        const script = `set -o pipefail; COPYFILE_DISABLE=1 tar czf - ${context.join(" ")} | ssh ${SSH_HOST} "docker build -q -t rsva:${tag} -f deploy/stand/Dockerfile -"`;
        await run("bash", ["-c", script], dir);
      } finally {
        await attempt("git", ["worktree", "remove", "--force", dir], cwd);
      }
    },
  };
}
