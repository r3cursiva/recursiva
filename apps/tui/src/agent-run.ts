// A dispatched agent's run on the server (RSVA-636): the harness, not the prompt, holds the loop. The dispatch claims
// the issue's work stage before anything costly starts; while the agent's session lives the TUI renews the lease; the
// agent ends the run itself (`rsva run complete` with evidence, or `rsva run fail`); a session that ends with its run
// still live is failed here, so it counts as an attempt and the server's stop rules apply.
//
// Every call goes with the agent's own token, the one in its session's settings file: the run is the agent's, and the
// server lets only its holder renew or fail it. The owner's credential (the TUI's engine) never holds a run.
//
// The lease is an hour and is renewed every quarter of an hour: three renewals can be missed (a network blip) before it
// passes, and a Mac that sleeps or closes frees the issue within the hour. A session that outlives its lease (the Mac
// slept through it) claims again: the expired run counts as an attempt, and the agent's `complete` finds a live run.
import { readFile } from "node:fs/promises";
import type { RunStage } from "@rsva/schema/models";
import { ApiError, Client } from "@rsva/terminal/client";
import type { Run, Runs } from "./dispatch.ts";

/** The lease a dispatch asks for, in seconds, and how often a live session renews it. */
const LEASE_S = 3600;
export const RENEW_MS = 15 * 60_000;
/** After a call that failed (offline, the server busy), the next try waits this long. */
const RETRY_MS = 60_000;
/** The error a run gets when its session ends while it is live: a fixed text, so twice in a row is the same error. */
export const SESSION_ENDED = "the session ended without a result";

/** A run as the server answers it: what the TUI reads of it. */
export interface ServerRun {
  id: string;
  stage: RunStage;
  attempt: number;
  live: boolean;
  outcome: string | null;
}

/** The run calls of the agent API, with the agent's token. */
export interface RunCalls {
  claim(key: string, stage: RunStage): Promise<ServerRun>;
  renew(key: string): Promise<ServerRun>;
  fail(key: string, error: string): Promise<ServerRun>;
  /** The issue's newest run, whoever holds it; null when it has none. */
  latest(key: string): Promise<ServerRun | null>;
}

/** What the dispatch keeps of its claim on the local run: which server run is this session's. */
export type Claim = Pick<ServerRun, "id" | "stage" | "attempt">;

const runsPath = (key: string, tail = "") => `/issues/${encodeURIComponent(key)}/runs${tail}`;

function restRunCalls(api: Client): RunCalls {
  const post = async (key: string, tail: string, body: Record<string, unknown>) => (await api.request<{ run: ServerRun }>("POST", runsPath(key, tail), { body })).run;
  return {
    claim: (key, stage) => post(key, "", { stage, lease: LEASE_S }),
    renew: (key) => post(key, "/renew", { lease: LEASE_S }),
    fail: (key, error) => post(key, "/fail", { error }),
    latest: async (key) => (await api.request<{ runs: ServerRun[] }>("GET", runsPath(key))).runs[0] ?? null,
  };
}

/** The calls with an agent's credential as an environment: its server and workspace, when set, and its token. */
export type CallsOf = (env: Record<string, string>) => RunCalls;
export const restCallsOf: CallsOf = (env) => restRunCalls(new Client(env));

/** The calls as the session makes them: the server, workspace and token of its settings file; null without one. */
export async function sessionCalls(settings: string, callsOf: CallsOf = restCallsOf): Promise<RunCalls | null> {
  let env: Record<string, string> | undefined;
  try {
    env = (JSON.parse(await readFile(settings, "utf8")) as { env?: Record<string, string> }).env;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (!env?.RSVA_TOKEN) return null;
  const { RSVA_URL, RSVA_WS, RSVA_TOKEN } = env;
  return callsOf({ ...(RSVA_URL ? { RSVA_URL } : {}), ...(RSVA_WS ? { RSVA_WS } : {}), RSVA_TOKEN });
}

/** What one look at a run did: its claim may be new (claimed again after its lease passed). */
export type Tended =
  | { did: "renewed" | "failed"; run: ServerRun }
  /** The run is no longer this session's: the agent ended it, or another took the issue. Nothing more to do. */
  | { did: "ended"; run: ServerRun | null; why?: string }
  | { did: "reclaimed"; run: ServerRun };

/**
 * One look at the session's run: a live session renews it, or claims again when its lease passed; an ended session
 * fails it if it is still live. A run the agent ended, or one that is not this claim's, is left alone.
 */
export async function tend(key: string, claim: Claim, alive: boolean, calls: RunCalls): Promise<Tended> {
  const now = await calls.latest(key);
  if (!now || now.id !== claim.id || now.outcome !== null) return { did: "ended", run: now };
  if (!alive) return { did: "failed", run: await calls.fail(key, SESSION_ENDED) };
  if (now.live) return { did: "renewed", run: await calls.renew(key) };
  try {
    return { did: "reclaimed", run: await calls.claim(key, claim.stage) };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return { did: "ended", run: now, why: e.message };
    throw e;
  }
}

/**
 * When to look at each session's run: a live one every RENEW_MS from its start, an ended one once; a call that threw
 * is tried again after RETRY_MS. One look at a time per run.
 */
export class Tending {
  private readonly next = new Map<string, number>();
  private readonly settled = new Set<string>();
  private readonly busy = new Set<string>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** The look, if one is due: what it did, or null. */
  async look(key: string, claim: Claim, startedAt: string, alive: boolean, calls: () => Promise<RunCalls | null>): Promise<Tended | null> {
    const id = claim.id;
    const at = this.next.get(id) ?? (alive ? Date.parse(startedAt) + RENEW_MS : 0);
    if (this.settled.has(id) || this.busy.has(id) || this.now() < at) return null;
    this.busy.add(id);
    try {
      const c = await calls();
      if (!c) {
        this.settled.add(id);
        return null;
      }
      const t = await tend(key, claim, alive, c);
      if (t.did === "renewed") this.next.set(id, this.now() + RENEW_MS);
      else this.settled.add(id);
      // A new claim was just made: its first renewal is a period away.
      if (t.did === "reclaimed") this.next.set(t.run.id, this.now() + RENEW_MS);
      return t;
    } catch (e) {
      this.next.set(id, this.now() + RETRY_MS);
      throw e;
    } finally {
      this.busy.delete(id);
    }
  }
}

/** A run's state in a word: its outcome, or live, or expired when its lease passed with nobody closing it yet. */
export const runWord = (r: ServerRun) => r.outcome ?? (r.live ? "live" : "expired");

/**
 * What a look did, kept and said: a new claim goes on the local run, so the next look and the agent's `complete` are
 * about it; the words for the owner, or null when there is nothing to tell (a renewal, a run the agent ended).
 */
export async function settle(runs: Pick<Runs, "put">, r: Run, t: Tended): Promise<string | null> {
  if (t.did === "reclaimed") {
    await runs.put({ ...r, claim: { id: t.run.id, stage: t.run.stage, attempt: t.run.attempt } });
    return `${r.key}: the lease passed while the session lived · claimed again, attempt ${t.run.attempt}`;
  }
  if (t.did === "failed") return `${r.key}: ${SESSION_ENDED} · ${t.run.stage} run failed, attempt ${t.run.attempt}${t.run.outcome === "stopped" ? " · the loop stopped, the issue went to review" : ""}`;
  if (t.did === "ended" && t.why) return `${r.key}: the lease passed and the issue was not claimed again: ${t.why}`;
  return null;
}
