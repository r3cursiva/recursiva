// Runs a command and returns its stdout. stdout and stderr stay quiet until it fails: then they are the message.
import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

const LIMIT = 2 ** 28;

/** Whatever the exit code: the caller decides what it means. */
export const attempt = (command: string, args: string[], cwd?: string): Promise<Result> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { cwd, maxBuffer: LIMIT }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });

/** Like `run`, with `input` on the command's stdin. */
export const runWithInput = (command: string, args: string[], input: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile(command, args, { maxBuffer: LIMIT }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${command} ${args[0] ?? ""} failed (${error.code ?? error.message}):\n${(stderr || stdout).trim().slice(-2000)}`));
      resolve(stdout);
    });
    child.stdin!.end(input);
  });

export async function run(command: string, args: string[], cwd?: string): Promise<string> {
  const r = await attempt(command, args, cwd);
  if (r.code !== 0) throw new Error(`${command} ${args[0] ?? ""} failed (${r.code}):\n${(r.stderr || r.stdout).trim().slice(-2000)}`);
  return r.stdout;
}

/** A yes from the person at the terminal, or `yes` standing for it. Without a terminal and without `yes`: no. */
export async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.log("No terminal to ask in: pass --yes.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl-C at the question is a no: unanswered, the process would end here and skip the caller's cleanup.
  const answer = await new Promise<string>((resolve) => {
    rl.once("SIGINT", () => resolve(""));
    void rl.question(`${question} [y/N] `).then(resolve);
  });
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}
