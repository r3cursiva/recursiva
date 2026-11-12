// Preloaded into every test process (--import in each package's `test` script). --test-timeout names a stuck test and
// --test-force-exit ends a file whose timers outlive it, but both need the main thread: a blocked event loop or a file that
// never reaches its first test runs for ever and prints nothing (PLNR-166). A worker thread is not blocked by any of that.
import { writeSync } from "node:fs";
import { Session } from "node:inspector";
import { beforeEach } from "node:test";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

/** Past the 60 s of --test-timeout, which speaks first whenever it can. Seconds counted here stop while the machine sleeps. */
const LIMIT_S = Number(process.env.TEST_STALL_S ?? 90);

interface Watch {
  testWatchdog: true;
  file: string | undefined;
}

/** Where the main thread is now. An idle one pauses only when some JavaScript runs next, which may never happen. */
function mainStack(done: (stack: string) => void): void {
  const scripts = new Map<string, string>();
  const session = new Session();
  session.connectToMainThread();
  session.on("Debugger.scriptParsed", ({ params }) => scripts.set(params.scriptId, params.url));
  session.on("Debugger.paused", ({ params }) => {
    const at = (f: (typeof params.callFrames)[number]) =>
      `  at ${f.functionName || "<anonymous>"} (${scripts.get(f.location.scriptId)}:${f.location.lineNumber + 1})\n`;
    done(params.callFrames.map(at).join(""));
  });
  session.post("Debugger.enable");
  session.post("Debugger.pause");
  setTimeout(() => done("  (the main thread is idle: it waits for something that does not come)\n"), 1000);
}

function watch({ file }: Watch): void {
  let test: string | null = null;
  let quiet = 0;
  parentPort?.on("message", (name: string) => {
    test = name;
    quiet = 0;
  });
  setInterval(() => {
    if (++quiet !== LIMIT_S) return;
    mainStack((stack) => {
      const where = test === null ? "before its first test" : `in the test "${test}"`;
      // Not console.error: a worker's console goes through the main thread, the one that is stuck.
      writeSync(2, `\ntest watchdog: ${file} is stuck ${where}, no new test for ${LIMIT_S} s\n${stack}`);
      process.kill(process.pid, "SIGKILL");
    });
  }, 1000);
}

const data = workerData as Watch | null;
if (!isMainThread && data?.testWatchdog) watch(data);
// Only in a process that runs a test file: the --test parent loads this too.
else if (isMainThread && process.env.NODE_TEST_CONTEXT) {
  const watchdog = new Worker(new URL(import.meta.url), { workerData: { testWatchdog: true, file: process.argv[1] } satisfies Watch });
  watchdog.unref();
  beforeEach((t) => watchdog.postMessage(t.fullName));
}
