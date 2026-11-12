// The person's own programs, for the CLI and the TUI (apps/tui): their pager and their editor, chosen from the
// environment as git chooses them, and the scratch file a text goes to the editor in.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheRoot } from "./copies.ts";

type Env = Record<string, string | undefined>;

/**
 * The pager for a person's long output and the environment to run it in: RSVA_PAGER, then PAGER, else less, through the
 * shell. less keeps the colour (R), quits when the text fits (F) and leaves it on the screen (X), unless LESS says
 * otherwise. Null for "cat" or empty: no pager.
 */
export function pagerOf(env: Env): { command: string; env: Env } | null {
  const command = (env.RSVA_PAGER ?? env.PAGER ?? "less").trim();
  return !command || command === "cat" ? null : { command, env: { ...env, LESS: env.LESS ?? "FRX" } };
}

/**
 * The program and arguments that open the file in VISUAL, then EDITOR, else vi, the way git runs its editor: through the
 * shell, so "code --wait" works, with the file as $1 rather than spliced into the command.
 */
export function editorArgv(env: Env, file: string): [string, string[]] {
  const editor = (env.VISUAL || env.EDITOR || "vi").trim();
  return ["sh", ["-c", `${editor} "$1"`, editor, file]];
}

/**
 * The text in a Markdown file for the editor, `<cacheRoot>/<name>-<pid>.md`: in the terminal's own folder (0700) and
 * 0600, never in /tmp, since the text may say things the person does not want there. The caller removes it.
 */
export function scratchFile(name: string, text: string, env: Env = process.env): string {
  const dir = cacheRoot(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${name}-${process.pid}.md`);
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}
