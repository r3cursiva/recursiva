#!/usr/bin/env node
// `pnpm public:check`: builds the public tree (tools/public/exclude.txt) into a temporary folder from `git ls-files` and
// fails on the owner's paths, hosts and mail (tools/public/forbidden.txt) or a secret (gitleaks) found in it (RSVA-533).
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicFiles, repoRoot, writePublicTree } from "./tree.ts";

const lines = async (file: string) => (await readFile(file, "utf8")).split("\n").filter((l) => l.trim() && !l.startsWith("#"));
const root = repoRoot();

let patterns: RegExp[];
try {
  patterns = (await lines(join(root, "tools/public/forbidden.txt"))).map((l) => new RegExp(l, "i"));
} catch {
  console.log("no tools/public/forbidden.txt: this is the public tree, nothing to check");
  process.exit(0);
}
const files = await publicFiles(root);

const tree = await mkdtemp(join(tmpdir(), "rsva-public-"));
let bad = 0;
try {
  await writePublicTree(root, tree);
  for (const f of files.map((x) => x.to)) {
    const text = await readFile(join(tree, f), "utf8").catch(() => "");
    if (text.includes("\0")) continue;
    text.split("\n").forEach((line, i) => {
      const hit = patterns.find((p) => p.test(line) || p.test(f));
      if (hit) (bad++, console.error(`${f}:${i + 1}: ${hit.source}`));
    });
  }
  const g = spawnSync("gitleaks", ["dir", tree, "--no-banner", "--redact", "--exit-code", "1"], { stdio: "inherit" });
  if (g.error) (bad++, console.error("gitleaks is not installed (brew install gitleaks)"));
  else if (g.status) bad++;
} finally {
  await rm(tree, { recursive: true, force: true });
}
if (bad) {
  console.error(`public tree: problems found: ${bad}`);
  process.exit(1);
}
console.log(`public tree: ${files.length} files, no owner paths, hosts or mail, no secrets`);
