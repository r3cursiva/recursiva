// A server of a run's own, for the tools that measure or break one: perf:net runs the production build (dist/main.js
// with the flags of apps/server `start`), the sync lab runs the sources and kills the process mid-burst. Both wait for
// /healthz the same way and both notice when the process dies before it answers.
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export interface LocalServerOptions {
  /** The script node runs: apps/server/dist/main.js or apps/server/src/main.ts. */
  entry: string;
  /** Added to this process's environment (DATABASE_URL, RSVA_MAIL…); PORT is set from `port`. */
  env?: Record<string, string>;
  /** Flags for node before the script, e.g. `--max-semi-space-size=16`. */
  nodeFlags?: string[];
  /** A fixed port; a free one when omitted. */
  port?: number;
  /** What of the server's output shows here: all of it (the default), only stderr, or nothing. */
  output?: "inherit" | "stderr" | "quiet";
}

export interface LocalServer {
  url: string;
  port: number;
  /** The running process's id (for its memory: `ps -o rss`). */
  readonly pid: number;
  /** Stops the process with `signal` and waits for it to exit; a process that already exited is left as it is. */
  kill(signal?: NodeJS.Signals): Promise<void>;
  /** Kills it the hard way (SIGKILL), runs `down` while it is gone, and starts it again on the same port. */
  restart(down?: () => Promise<void>): Promise<void>;
}

/** Up to 30 s for /healthz, in steps of 100 ms. */
const UP_TRIES = 300;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.once("error", reject);
  });
}

async function waitUp(url: string, proc: ChildProcess): Promise<void> {
  for (let i = 0; i < UP_TRIES; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`the server exited with ${proc.exitCode ?? proc.signalCode}`);
    if (await fetch(`${url}/healthz`).then((r) => r.ok, () => false)) return;
    await sleep(100);
  }
  throw new Error("the server did not come up");
}

/** Starts the server and resolves once /healthz answers. */
export async function localServer(o: LocalServerOptions): Promise<LocalServer> {
  const port = o.port ?? (await freePort());
  const url = `http://127.0.0.1:${port}`;
  const output = o.output ?? "inherit";
  const stdio = ["ignore", output === "inherit" ? "inherit" : "ignore", output === "quiet" ? "ignore" : "inherit"] as const;
  let proc!: ChildProcess;
  const start = async () => {
    proc = spawn(process.execPath, [...(o.nodeFlags ?? []), o.entry], { env: { ...process.env, ...o.env, PORT: String(port) }, stdio: [...stdio] });
    try {
      await waitUp(url, proc);
    } catch (e) {
      await kill("SIGKILL");
      throw e;
    }
  };
  const kill = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const gone = new Promise((r) => proc.once("exit", r));
    proc.kill(signal);
    await gone;
  };
  await start();
  return {
    url,
    port,
    get pid() {
      return proc.pid!;
    },
    kill,
    async restart(down) {
      await kill("SIGKILL");
      await down?.();
      await start();
    },
  };
}

/** A cookie as Playwright's `addCookies` takes it. */
export interface SignInCookie {
  name: string;
  value: string;
  url: string;
  secure: boolean;
  httpOnly?: boolean;
  sameSite: "Lax";
}

/**
 * The cookies a sign-in leaves in the browser (sessionCookies, apps/server/src/auth/actor.ts): on https the session one
 * is __Host-rsva_sid and Secure, and a server with an https origin reads no other; on plain http it is rsva_sid.
 * rsva_in=1 makes the shell start the app instead of the sign-in screen (apps/web/src/lib/signed-in.ts). Without `sid`
 * only that one: the page signs in some other way (a token header).
 */
export function signInCookies(origin: string, sid?: string): SignInCookie[] {
  const secure = origin.startsWith("https:");
  const signedIn: SignInCookie = { name: "rsva_in", value: "1", url: origin, secure, sameSite: "Lax" };
  if (sid === undefined) return [signedIn];
  return [{ name: secure ? "__Host-rsva_sid" : "rsva_sid", value: sid, url: origin, secure, httpOnly: true, sameSite: "Lax" }, signedIn];
}
