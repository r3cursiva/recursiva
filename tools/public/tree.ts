// The public tree (RSVA-532, RSVA-533, RSVA-589): `git ls-files` minus tools/public/exclude.txt, with the renames of
// tools/public/rename.txt. The internal documents (docs/) live in a private repository cloned into docs/ of the public
// working copy, so the public .gitignore gains one line for it.
import { spawnSync } from "node:child_process";
import { appendFile, cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const lines = async (file: string) => (await readFile(file, "utf8")).split("\n").filter((l) => l.trim() && !l.startsWith("#"));

/** The line the public .gitignore gets: docs/ is a clone of the private recursiva-internal repository. Tracked files are not
 * hurt by it, so the shared .gitignore of the private archive repository stays as it is and only the public tree gets it. */
const DOCS_IGNORE = "/docs/";

export const repoRoot = () => spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();

/** The files of the public tree as `from` (in the repository) and `to` (in the public tree). */
export async function publicFiles(root: string): Promise<{ from: string; to: string }[]> {
  const exclude = await lines(join(root, "tools/public/exclude.txt"));
  const rename = new Map((await lines(join(root, "tools/public/rename.txt"))).map((l) => l.split(/\s*->\s*/) as [string, string]));
  const left = (f: string) => !exclude.some((e) => (e.endsWith("/") ? f.startsWith(e) : f === e));
  return spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 })
    .stdout.split("\0")
    .filter((f) => f && left(f))
    .map((from) => ({ from, to: rename.get(from) ?? from }));
}

/** Writes the public tree into an empty `dest`. */
export async function writePublicTree(root: string, dest: string): Promise<{ from: string; to: string }[]> {
  const files = await publicFiles(root);
  for (const { from, to } of files) {
    await mkdir(dirname(join(dest, to)), { recursive: true });
    await cp(join(root, from), join(dest, to));
  }
  await appendFile(join(dest, ".gitignore"), `# The private recursiva-internal repository, cloned here by the maintainers.\n${DOCS_IGNORE}\n`);
  return files;
}
