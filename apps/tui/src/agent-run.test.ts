import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RENEW_MS, SESSION_ENDED, sessionCalls, sessionsSeen, tend, tendedText, Tending, type Claim } from "./agent-run.ts";
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

test("a live session renews its run, a lapsed lease too: it is still the holder's", async () => {
  const { server, claim } = claimed();
  assert.equal((await tend(KEY, claim, true, server.calls)).did, "renewed");
  server.runs[0]!.live = false;
  assert.equal((await tend(KEY, claim, true, server.calls)).did, "renewed");
  assert.deepEqual(server.log.filter((l) => !l.startsWith("latest")), [`renew ${KEY}`, `renew ${KEY}`], "no claim again");
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
  assert.equal(await look(false), null, "missed once: not ended yet");
  assert.equal(await look(false), null, "the failed call waits a minute, ended or not");
  clock += 60_000;
  assert.equal((await look(false))?.did, "failed");
  assert.equal(await look(false), null, "an ended session's run is looked at once");
  assert.deepEqual(server.log.filter((l) => !l.startsWith("latest")), [`renew ${KEY}`, `fail ${KEY}: ${SESSION_ENDED}`]);
});

test("a session Rex misses for one look is not ended: only two looks in a row fail its run", async () => {
  const { server, claim } = claimed();
  let clock = Date.parse("2026-11-21T10:00:00Z");
  const tending = new Tending(() => clock);
  const started = new Date(clock - RENEW_MS).toISOString();
  const look = (seen: boolean) => tending.look(KEY, claim, started, seen, async () => server.calls);
  // Rex blinks: listed, missing, listed, missing, listed.
  for (const seen of [true, false, true, false, true]) await look(seen);
  assert.ok(!server.log.some((l) => l.startsWith("fail")), server.log.join("\n"));
  assert.equal(await look(false), null);
  assert.equal((await look(false))?.did, "failed", "gone for two looks: ended, at once though a renewal was not due");
  assert.equal(tendedText(KEY, { did: "failed", run: { ...server.runs[0]!, outcome: "stopped" } })?.includes("the loop stopped"), true);
  assert.equal(tendedText(KEY, { did: "renewed", run: server.runs[0]! }), null);
});

test("a one-shot listing asks Rex again when a session is missing, and counts it gone only if both miss it", async () => {
  const answers = [new Set(["a"]), new Set(["a", "b"])];
  let asked = 0;
  const list = async () => answers[asked++]!;
  assert.deepEqual([...(await sessionsSeen(list, ["a", "b"], async () => {}))].sort(), ["a", "b"]);
  assert.equal(asked, 2);
  asked = 0;
  assert.deepEqual([...(await sessionsSeen(list, ["a"], async () => {}))], ["a"]);
  assert.equal(asked, 1, "nothing missing: one look");
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
