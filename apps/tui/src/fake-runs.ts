// The agent API's run calls without a server, for the tests: one issue's runs in memory, each call logged.
import type { RunStage } from "@rsva/schema/models";
import type { RunCalls, ServerRun } from "./agent-run.ts";

export interface FakeServer {
  runs: ServerRun[];
  log: string[];
  /** A claim throws this while set: the issue held by another, or its loop stopped. */
  refuse: Error | null;
  /** A run as another claim would make it, newest last. */
  add(stage: RunStage): ServerRun;
  calls: RunCalls;
}

export function fakeServer(): FakeServer {
  const runs: ServerRun[] = [];
  const log: string[] = [];
  const add = (stage: RunStage): ServerRun => {
    const r: ServerRun = { id: `run-${runs.length + 1}`, stage, attempt: runs.length + 1, live: true, outcome: null };
    runs.push(r);
    return r;
  };
  const server: FakeServer = {
    runs,
    log,
    refuse: null,
    add,
    calls: {
      async claim(key, stage) {
        log.push(`claim ${key} ${stage}`);
        if (server.refuse) throw server.refuse;
        return add(stage);
      },
      async renew(key) {
        log.push(`renew ${key}`);
        return runs.at(-1)!;
      },
      async fail(key, error, env) {
        log.push(`fail${env ? " --env" : ""} ${key}: ${error}`);
        return Object.assign(runs.at(-1)!, { live: false, outcome: env ? "blocked" : "failed" });
      },
      async latest(key) {
        log.push(`latest ${key}`);
        return runs.at(-1) ?? null;
      },
    },
  };
  return server;
}
