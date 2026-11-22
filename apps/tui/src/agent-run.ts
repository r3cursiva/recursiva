// A dispatched agent's run on the server (RSVA-636): the harness, not the prompt, holds the loop. The dispatch claims
// the issue's work stage before anything costly starts; while the agent's session lives the TUI renews the lease; the
// agent ends the run itself (`rsva run complete` with evidence, or `rsva run fail`); a session that ends with its run
// still live is failed here, so it counts as an attempt and the server's stop rules apply.
//
// Every call goes with the agent's own token, the one in its session's settings file: the run is the agent's, and the
// server lets only its holder renew or fail it. The owner's credential (the TUI's engine) never holds a run.
//
// The lease is an hour and is renewed every quarter of an hour, while the TUI is open or `rsva-tui agents` runs: three
// renewals can be missed (a network blip) before it lapses, and a Mac that sleeps or closes frees the issue for other
// agents within the hour. A lapsed lease stays the holder's until another agent claims: a late renewal, and the agent's
// own `complete`, just work.
import { readFile } from "node:fs/promises";
import type { RunStage } from "@rsva/schema/models";
import { Client } from "@rsva/terminal/client";

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
  /** `env`: the environment failed (the dispatch's setup), not the agent: the server records it as blocked. */
  fail(key: string, error: string, env?: boolean): Promise<ServerRun>;
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
    fail: (key, error, env) => post(key, "/fail", { error, ...(env ? { env } : {}) }),
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

/** What one look at a run did. */
export type Tended =
  | { did: "renewed" | "failed"; run: ServerRun }
  /** The run is no longer this session's: the agent ended it, or another took the issue. Nothing more to do. */
  | { did: "ended"; run: ServerRun | null };

/**
 * One look at the session's run: a live session renews it (a lapsed lease too: it is still the holder's); an ended
 * session fails it if it is still open. A run the agent ended, or one that is not this claim's, is left alone.
 */
export async function tend(key: string, claim: Claim, alive: boolean, calls: RunCalls): Promise<Tended> {
  const now = await calls.latest(key);
  if (!now || now.id !== claim.id || now.outcome !== null) return { did: "ended", run: now };
  return alive ? { did: "renewed", run: await calls.renew(key) } : { did: "failed", run: await calls.fail(key, SESSION_ENDED) };
}

/** Looks in a row that must miss a session before it counts as ended: Rex may list none for a moment. */
const GONE_LOOKS = 2;

/**
 * When to look at each session's run: a live one every RENEW_MS from its start, an ended one once, after GONE_LOOKS
 * looks in a row have missed it; a call that threw is tried again after RETRY_MS. One look at a time per run.
 */
export class Tending {
  private readonly next = new Map<string, number>();
  private readonly retry = new Map<string, number>();
  private readonly missed = new Map<string, number>();
  private readonly settled = new Set<string>();
  private readonly busy = new Set<string>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** The look, if one is due: what it did, or null. `seen`: whether this look found the session. */
  async look(key: string, claim: Claim, startedAt: string, seen: boolean, calls: () => Promise<RunCalls | null>): Promise<Tended | null> {
    const id = claim.id;
    const missed = seen ? 0 : (this.missed.get(id) ?? 0) + 1;
    this.missed.set(id, missed);
    const alive = missed < GONE_LOOKS;
    // Missed once: not ended yet, and nothing to renew until the next look says which it is.
    if (!seen && alive) return null;
    // An ended session is looked at at once; a live one when its renewal is due; either after a failed call's wait.
    const at = Math.max(alive ? (this.next.get(id) ?? Date.parse(startedAt) + RENEW_MS) : 0, this.retry.get(id) ?? 0);
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
      return t;
    } catch (e) {
      this.retry.set(id, this.now() + RETRY_MS);
      throw e;
    } finally {
      this.busy.delete(id);
    }
  }
}

/** What a look did, in words for the owner; null when there is nothing to tell (a renewal, a run the agent ended). */
export function tendedText(key: string, t: Tended): string | null {
  if (t.did !== "failed") return null;
  return `${key}: ${SESSION_ENDED} · ${t.run.stage} run failed, attempt ${t.run.attempt}${t.run.outcome === "stopped" ? " · the loop stopped, the issue went to review" : ""}`;
}

/**
 * The sessions Rex lists, looked at twice when one of `wanted` is missing: a one-shot listing (`rsva-tui agents`) holds
 * a session ended only when two looks in a row miss it, as the screen does.
 */
export async function sessionsSeen(list: () => Promise<Set<string>>, wanted: readonly string[], pause: () => Promise<void>): Promise<Set<string>> {
  const first = await list();
  if (wanted.every((id) => first.has(id))) return first;
  await pause();
  return new Set([...first, ...(await list())]);
}

/** A run's state in a word: its outcome, or live, or expired when its lease passed with nobody closing it yet. */
export const runWord = (r: ServerRun) => r.outcome ?? (r.live ? "live" : "expired");

