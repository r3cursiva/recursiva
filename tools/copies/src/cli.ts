// pnpm check:copies: fails on a copy of a shared pattern outside its home (copies.ts), with file:line and what to use.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED } from "./allowed.ts";
import { findCopies, MENU, report, rules, type SourceFile } from "./copies.ts";

const started = performance.now();
const ROOT = join(import.meta.dirname, "../../..");
/** Sources git knows of, committed or not, less the ignored; this tool's own tests hold copies on purpose. */
const SOURCES = ["*.ts", "*.tsx", "*.js", "*.mjs", "*.cjs"];
const SKIP = ["tools/copies/"];

const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SOURCES], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((p) => p && !SKIP.some((s) => p.startsWith(s)));

function* files(): Generator<SourceFile> {
  for (const path of new Set(paths)) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, path), "utf8");
    } catch {
      continue; // deleted, not yet staged
    }
    yield { path, text };
  }
}

const all = rules(readFileSync(join(ROOT, MENU), "utf8"));
const { copies, stale } = findCopies(files(), all, ALLOWED);
const lines = report(copies, stale, ALLOWED);
const took = `${Math.round(performance.now() - started)} ms`;
if (lines.length) {
  console.error(lines.join("\n"));
  console.error(`check:copies: ${copies.length} copies, ${stale.length} stale allowances in ${paths.length} files (${took})`);
  process.exitCode = 1;
} else {
  console.log(`check:copies: no copies of ${all.length} patterns in ${paths.length} files (${took})`);
}
