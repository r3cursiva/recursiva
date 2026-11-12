#!/usr/bin/env node
// `rsva`: see `rsva help` and docs/agents-api.md.
// Started through bin/rsva.js, which turns Node's compile cache on first; run directly, it works the same, slower.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { text } from "node:stream/consumers";
import { removeCopies } from "@rsva/terminal/copies";
import { readSecret, removeSecret, writeSecret } from "@rsva/terminal/keychain";
import { open } from "@rsva/terminal/open";
import { editorArgv, pagerOf } from "@rsva/terminal/programs";
import { run } from "./commands.ts";

const write = (s: string) => process.stdout.write(`${s}\n`);

/** A person's long output through their pager (programs.ts), as git does it. */
function page(output: string): Promise<void> {
  const pager = pagerOf(process.env);
  if (!pager) return Promise.resolve(void write(output));
  return new Promise((resolve) => {
    const ignore = () => {};
    // ^C belongs to the pager while it runs: it ends the page, not this process halfway through the text.
    process.on("SIGINT", ignore);
    const child = spawn(pager.command, { shell: true, stdio: ["pipe", "inherit", "inherit"], env: pager.env });
    // The person quit before the end.
    child.stdin.on("error", ignore);
    child.on("close", (code) => {
      process.off("SIGINT", ignore);
      // 127: the shell found no such pager; the text is not lost.
      if (code === 127) write(output);
      resolve();
    });
    child.stdin.end(`${output}\n`);
  });
}

/** A program in this terminal, its exit code when it ends; 127 when it could not start. */
const inherit = (command: string, args: string[]) =>
  new Promise<number>((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });

/** The file in the person's editor (programs.ts). */
const edit = (file: string) => inherit(...editorArgv(process.env, file));

/** The TUI is its own package with the sync engine: the CLI starts it as a program and keeps no dependency on it. */
const tui = (args: string[] = []) => inherit(process.execPath, [new URL("../../tui/bin/rsva-tui.js", import.meta.url).pathname, ...args]);

// `rsva tui dispatch KEY --model opus …`: the TUI parses its own arguments, which the CLI's flags do not know.
const argv = process.argv.slice(2);
if (argv[0] === "tui" && argv.length > 1) process.exitCode = await tui(argv.slice(1));
else process.exitCode = await run(argv, {
  env: process.env,
  out: write,
  err: (s) => process.stderr.write(`${s}\n`),
  stdin: () => text(process.stdin),
  terminal: process.stdout.isTTY ? { columns: process.stdout.columns, rows: process.stdout.rows } : undefined,
  errTerminal: process.stderr.isTTY,
  page,
  open,
  edit,
  tui,
  ask: process.stdin.isTTY
    ? async (prompt) => {
        // The prompt on stderr: stdout keeps the answer alone.
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          return await rl.question(prompt);
        } finally {
          rl.close();
        }
      }
    : undefined,
  keychain: process.platform === "darwin" ? { read: (service) => readSecret(service).catch(() => null), write: writeSecret, remove: removeSecret } : undefined,
  copies: removeCopies,
});
