import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiError } from "@rsva/terminal/client";
import { RENEW_MS, SESSION_ENDED, sessionCalls, settle, tend, Tending, type Claim } from "./agent-run.ts";
import type { Run } from "./dispatch.ts";
import { fakeServer } from "./fake-runs.ts";

const KEY = "PLNR-305";
/** A server with the session's claim on it, live. */
function claimed() {
  const server = fakeServer();
  const r = server.add("work");
  const claim: Claim = { id: r.id, stage: r.stage, attempt: r.attempt };
  server.log.length = 0;
  return { server, claim };
}

test("a session that ends with its run live fails it, with the fixed error: an attempt the stop rules count", async () => {
  const { server, claim } = claimed();
  const t = await tend(KEY, claim, false, server.calls);
  assert.deepEqual([t.did, t.run?.outcome], ["failed", "failed"]);
  assert.deepEqual(server.log, [`latest ${KEY}`, `fail ${KEY}: ${SESSION_ENDED}`]);
});

test("a session that ended its run is left alone, and so is a newer run that is not this claim's", async () => {
  const { server, claim } = claimed();
  server.runs[0]!.outcome = "done";
  server.runs[0]!.live = false;
  assert.equal((await tend(KEY, claim, false, server.calls)).did, "ended");
  server.add("work");
  assert.equal((await tend(KEY, claim, false, server.calls)).did, "ended", "another agent's live run");
  assert.equal((await tend(KEY, claim, true, server.calls)).did, "ended", "nor renewed");
  assert.ok(!server.log.some((l) => l.startsWith("fail") || l.startsWith("renew")), server.log.join("\n"));
});

test("a live session renews its run; one whose lease passed claims again, or says why it could not", async () => {
  const { server, claim } = claimed();
  assert.equal((await tend(KEY, claim, true, server.calls)).did, "renewed");
  server.runs[0]!.live = false;
  const again = await tend(KEY, claim, true, server.calls);
  assert.deepEqual([again.did, again.run?.attempt], ["reclaimed", 2]);
  const held = claimed();
  held.server.runs[0]!.live = false;
  held.server.refuse = new ApiError("the work loop on PLNR-305 stopped", 409);
  const t = await tend(KEY, held.claim, true, held.server.calls);
  assert.deepEqual([t.did, t.did === "ended" && t.why], ["ended", "the work loop on PLNR-305 stopped"]);
});

test("tending: a live session's run every RENEW_MS from its start, an ended one's once; a failed call waits before the next", async () => {
  const { server, claim } = claimed();
  let clock = Date.parse("2026-11-21T10:00:00Z");
  const tending = new Tending(() => clock);
  const started = new Date(clock).toISOString();
  const look = (alive: boolean) => tending.look(KEY, claim, started, alive, async () => server.calls);
  assert.equal(await look(true), null, "the claim is fresh");
  clock += RENEW_MS;
  assert.equal((await look(true))?.did, "renewed");
  assert.equal(await look(true), null, "not again until the next period");
  clock += RENEW_MS;
  const broken = { ...server.calls, latest: () => Promise.reject(new Error("offline")) };
  await assert.rejects(tending.look(KEY, claim, started, true, async () => broken), /offline/);
  assert.equal(await look(false), null, "the failed call waits a minute, ended or not");
  clock += 60_000;
  assert.equal((await look(false))?.did, "failed");
  assert.equal(await look(false), null, "an ended session's run is looked at once");
  assert.deepEqual(server.log.filter((l) => !l.startsWith("latest")), [`renew ${KEY}`, `fail ${KEY}: ${SESSION_ENDED}`]);
});

test("settle: a new claim goes on the local run; a failure and a refusal are said, a renewal is not", async () => {
  const run = { key: KEY, claim: { id: "run-1", stage: "work", attempt: 1 } } as Run;
  const put: Run[] = [];
  const runs = { put: async (r: Run) => void put.push(r) };
  const next = { id: "run-2", stage: "work" as const, attempt: 2, live: true, outcome: null };
  assert.match((await settle(runs, run, { did: "reclaimed", run: next }))!, /claimed again, attempt 2/);
  assert.deepEqual(put.map((r) => r.claim), [{ id: "run-2", stage: "work", attempt: 2 }]);
  assert.match((await settle(runs, run, { did: "failed", run: { ...next, outcome: "stopped" } }))!, /session ended without a result · work run failed, attempt 2 · the loop stopped/);
  assert.equal(await settle(runs, run, { did: "renewed", run: next }), null);
  assert.equal(await settle(runs, run, { did: "ended", run: null }), null);
});

test("the session's calls: the server, workspace and token of its settings file; none without one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rsva-agent-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envs: Record<string, string>[] = [];
  const of = (env: Record<string, string>) => (envs.push(env), fakeServer().calls);
  const file = join(root, "s.json");
  assert.equal(await sessionCalls(file, of), null);
  await writeFile(file, JSON.stringify({ env: { RSVA_URL: "https://tracker.example.com", RSVA_TOKEN: "rsva_agent", GH_TOKEN: "github_pat" } }));
  assert.ok(await sessionCalls(file, of));
  assert.deepEqual(envs, [{ RSVA_URL: "https://tracker.example.com", RSVA_TOKEN: "rsva_agent" }], "the GitHub token stays out");
});
