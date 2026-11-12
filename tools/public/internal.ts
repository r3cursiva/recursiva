#!/usr/bin/env node
// `pnpm public:internal`: the first commit of the private repository r3cursiva/recursiva-internal (RSVA-589), built in a
// temporary folder from docs/ and CLAUDE.md of this checkout: the repository root holds the contents of docs/, and CLAUDE.md
// becomes its CLAUDE.md, so cloned into docs/ of the public working copy it is docs/CLAUDE.md and every docs/... path keeps
// working. Pushes nothing: prints the commands for switch-over day (RSVA-591).
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoRoot } from "./tree.ts";

const root = repoRoot();
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status) (console.error(r.stderr), process.exit(1));
  return r.stdout;
};

const tracked = git(root, "ls-files", "-z", "--", "docs/", "CLAUDE.md").split("\0").filter(Boolean);
const dest = await mkdtemp(join(tmpdir(), "rsva-internal-"));
for (const from of tracked) {
  const to = from === "CLAUDE.md" ? from : from.slice("docs/".length);
  await mkdir(dirname(join(dest, to)), { recursive: true });
  await cp(join(root, from), join(dest, to));
}
git(dest, "init", "-q", "-b", "main");
git(dest, "add", "-A");
git(dest, "commit", "-q", "-m", "Internal documents and instructions, moved from the recursiva repository (RSVA-589)");
console.log(`${tracked.length} files, one commit in ${dest}\n`);
console.log(`Create and push (as the owner, on switch-over day):
  gh repo create r3cursiva/recursiva-internal --private --source ${dest} --remote origin --push
Then, in the public working copy:
  git clone git@github.com:r3cursiva/recursiva-internal.git docs`);
