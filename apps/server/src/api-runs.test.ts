// Agent runs over REST (RSVA-636): claims, leases, the stop rules and their reset, against a database of the test run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq, isNull, sql as dsql } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { addMember, apiFixture, asToken, fetchAs } from "./test/helpers.ts";

/** A second agent of the workspace, with its own token. */
let other: typeof fetch;
let otherEmail: string;
let agentEmail: string;
const f = apiFixture(async (ws) => {
  const b = await addMember(ws.workspaceId, "member", "agent");
  otherEmail = b.email;
  other = fetchAs({ ...(await asToken(ws.workspaceId, b.id)), "content-type": "application/json" });
  [{ email: agentEmail }] = (await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, ws.agentId))) as [{ email: string }];
});

type Run = { id: string; issue: string; stage: string; attempt: number; agent: string; outcome: string | null; live: boolean; leaseUntil: string; note: string | null; error: string | null; evidence: { criterion: string; evidence: string }[] | null };
type Answer = {
  status: number;
  body: Record<string, unknown> & { run?: Run; stop?: { reason: string; movedTo: string | null; written: boolean }; comment?: { written: boolean }; message?: string; error?: string };
};

const call = async (as: typeof fetch, method: string, path: string, body?: unknown): Promise<Answer> => {
  const r = await as(f.api(path), { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: (await r.json()) as Answer["body"] };
};
const runs = (key: string, tail = "") => `/issues/${key}/runs${tail}`;
const claim = (as: typeof fetch, key: string, body: Record<string, unknown> = {}) => call(as, "POST", runs(key), body);
const fail = (as: typeof fetch, key: string, error: string, note?: string) => call(as, "POST", runs(key, "/fail"), { error, ...(note ? { note } : {}) });

async function newIssue(title: string, more: Record<string, unknown> = {}): Promise<string> {
  const r = await call(f.agent, "POST", "/issues", { project: "CORE", title, force: true, ...more });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.key as string;
}

/** Ages the issue's live run past its lease, as if its agent had gone quiet. */
async function expire(key: string): Promise<void> {
  const [{ id }] = (await call(f.agent, "GET", runs(key))).body.runs as [Run];
  await db.update(schema.run).set({ leaseUntil: dsql`now() - interval '1 second'` }).where(eq(schema.run.id, id));
}

const stateOf = async (key: string) => (await call(f.owner, "GET", `/issues/${key}`)).body.state as string;
const commentsStarting = async (key: string, start: string) => ((await call(f.owner, "GET", `/issues/${key}/comments`)).body.comments as { body: string; author: string }[]).filter((c) => c.body.startsWith(start));
const stopComments = (key: string) => commentsStarting(key, "Stopped the");
const complete = (as: typeof fetch, key: string, body: Record<string, unknown> = {}) => call(as, "POST", runs(key, "/complete"), body);

test("a claim is a live run; a second claim on the issue is refused, naming who holds it and until when", async () => {
  const key = await newIssue("Claimed by one agent");
  const first = await claim(f.agent, key, { stage: "work", lease: 600 });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual([first.body.run!.stage, first.body.run!.attempt, first.body.run!.agent, first.body.run!.live], ["work", 1, agentEmail, true]);
  for (const as of [other, f.agent]) {
    const second = await claim(as, key, { stage: "verify" });
    assert.equal(second.status, 409);
    assert.match(second.body.message!, new RegExp(`claimed by ${agentEmail} until ${first.body.run!.leaseUntil.slice(0, 16)}`));
  }
  assert.equal((await claim(f.agent, key, { stage: "nope" })).status, 400);
});

test("two claims racing leave exactly one live run", async () => {
  const key = await newIssue("Raced for");
  const both = await Promise.all([claim(f.agent, key), claim(other, key)]);
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409], JSON.stringify(both.map((r) => r.body)));
  const live = await db.select({ id: schema.run.id }).from(schema.run).innerJoin(schema.issue, eq(schema.issue.id, schema.run.issueId)).where(and(isNull(schema.run.outcome), eq(schema.issue.workspaceId, f.ws.workspaceId), eq(schema.issue.title, "Raced for")));
  assert.equal(live.length, 1);
});

test("renew and complete only by the holder; a claim after done counts afresh", async () => {
  const key = await newIssue("Held and finished");
  const mine = (await claim(f.agent, key, { lease: 60 })).body.run!;
  assert.equal((await call(other, "POST", runs(key, "/renew"), { lease: 3600 })).status, 403);
  assert.equal((await call(other, "POST", runs(key, "/complete"), {})).status, 403);
  assert.equal((await fail(other, key, "not mine")).status, 403);
  const renewed = await call(f.agent, "POST", runs(key, "/renew"), { lease: 3600 });
  assert.equal(renewed.status, 200);
  assert.ok(Date.parse(renewed.body.run!.leaseUntil) > Date.parse(mine.leaseUntil) + 3000_000);
  await fail(f.agent, key, "first try broke");
  await claim(f.agent, key);
  const done = await call(f.agent, "POST", runs(key, "/complete"), { note: "shipped in #12" });
  assert.deepEqual([done.status, done.body.run!.outcome, done.body.run!.note, done.body.run!.attempt], [200, "done", "shipped in #12", 2]);
  assert.equal((await call(f.agent, "POST", runs(key, "/complete"), {})).status, 409, "no live run left");
  assert.equal((await claim(other, key)).body.run!.attempt, 1);
  const list = (await call(f.owner, "GET", runs(key))).body.runs as Run[];
  assert.deepEqual(list.map((r) => [r.outcome, r.agent]), [[null, otherEmail], ["done", agentEmail], ["failed", agentEmail]], "newest first");
});

test("an expired lease frees the issue: the next claim closes it as expired and it counts as an attempt", async () => {
  const key = await newIssue("Gone quiet");
  await claim(f.agent, key);
  await expire(key);
  assert.equal((await call(f.agent, "POST", runs(key, "/renew"), {})).status, 409, "the holder's lease is over");
  const next = await claim(other, key);
  assert.deepEqual([next.status, next.body.run!.attempt], [201, 2], JSON.stringify(next.body));
  assert.deepEqual(((await call(f.owner, "GET", runs(key))).body.runs as Run[]).map((r) => r.outcome), [null, "expired"]);
});

test("the third failure stops the loop: to review, one comment of what was tried, claims refused until a person resets it", async () => {
  const key = await newIssue("Fails three ways");
  for (const [i, error] of ["tests failed", "lint failed", "build failed\nstack line"].entries()) {
    assert.equal((await claim(f.agent, key)).body.run!.attempt, i + 1);
    const r = await fail(f.agent, key, error, `try ${i + 1}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (i < 2) assert.equal(r.body.stop, undefined, "different errors twice do not stop");
    else {
      assert.deepEqual(r.body.stop, { reason: "3 failed attempts", movedTo: "In Review", written: true });
      assert.equal(r.body.run!.outcome, "stopped");
    }
  }
  assert.equal(await stateOf(key), "In Review");
  const [comment, ...more] = await stopComments(key);
  assert.equal(more.length, 0);
  assert.equal(comment!.author, agentEmail);
  assert.match(comment!.body, /1\. failed — try 1 — error: tests failed\n2\. failed — try 2 — error: lint failed\n3\. failed — try 3 — error: build failed\n/);

  const refused = await claim(other, key);
  assert.deepEqual([refused.status, refused.body.error], [409, "stopped"]);
  assert.equal((await claim(f.agent, key, { stage: "verify" })).status, 201, "another stage is not stopped");
  await call(f.agent, "POST", runs(key, "/complete"), {});
  // An agent moving it on is not a reset; a person is.
  assert.equal((await call(f.agent, "PATCH", `/issues/${key}`, { state: "In Progress" })).status, 200);
  assert.equal((await claim(f.agent, key)).status, 409);
  assert.equal((await call(f.owner, "PATCH", `/issues/${key}`, { state: "Backlog" })).status, 200);
  const again = await claim(f.agent, key);
  assert.deepEqual([again.status, again.body.run?.attempt], [201, 1], JSON.stringify(again.body));
  assert.equal((await stopComments(key)).length, 1, "the stop commented once");
});

test("the same error twice in a row stops the loop", async () => {
  const key = await newIssue("Fails the same way");
  await claim(f.agent, key);
  assert.equal((await fail(f.agent, key, "TypeError at /src/a.ts:12: cannot read 3f2a9b1c")).body.stop, undefined);
  await claim(other, key);
  const r = await fail(other, key, "TypeError at /src/b.ts:40: cannot read 99aa77bb");
  assert.equal(r.body.stop?.reason, "the same error twice in a row");
  assert.equal(await stateOf(key), "In Review");
});

test("an expiry that makes the third failure stops the loop at the claim that finds it", async () => {
  const key = await newIssue("Fails, then goes quiet");
  for (const error of ["one", "two"]) {
    await claim(f.agent, key);
    await fail(f.agent, key, error);
  }
  await claim(f.agent, key);
  await expire(key);
  const r = await claim(other, key);
  assert.deepEqual([r.status, r.body.error, r.body.stop?.reason], [409, "stopped", "3 failed attempts"], JSON.stringify(r.body));
  assert.equal(r.body.run!.outcome, "stopped");
  assert.equal(await stateOf(key), "In Review");
  assert.equal((await stopComments(key)).length, 1);
});

test("is:ready: open, not blocked, no live run", async () => {
  const free = await newIssue("Ready for an agent");
  const held = await newIssue("Held by an agent");
  const blocker = await newIssue("Blocks the next");
  const waiting = await newIssue("Waits on the blocker");
  await call(f.agent, "POST", `/issues/${waiting}/relations`, { type: "blockedBy", issue: blocker });
  await claim(f.agent, held);
  const ready = async () => ((await call(f.agent, "GET", `/issues?project=CORE&limit=500&q=${encodeURIComponent("is:ready")}`)).body.issues as { key: string }[]).map((i) => i.key);
  const got = await ready();
  assert.ok(got.includes(free) && got.includes(blocker));
  assert.ok(!got.includes(held) && !got.includes(waiting));
  await expire(held);
  assert.ok((await ready()).includes(held), "a lease that passed holds nothing");
});

test("a read-only token cannot claim", async () => {
  const key = await newIssue("Not for readers");
  const reader = fetchAs({ ...(await asToken(f.ws.workspaceId, f.ws.agentId, "read")), "content-type": "application/json" });
  assert.equal((await claim(reader, key)).status, 403);
  assert.equal((await call(reader, "GET", runs(key))).status, 200);
});

const DONE_WHEN = "Context.\n\n## Done when\n\n- [ ] `pnpm check` passes\n- a test fails without it\n  - in the server's suite\n";

test("Done when: complete on work needs evidence for each criterion, in order; refused naming the first missing, the run stays live", async () => {
  const key = await newIssue("Proves its work", { description: DONE_WHEN });
  const listed = (await call(f.agent, "GET", runs(key))).body;
  assert.deepEqual(listed.criteria, ["`pnpm check` passes", "a test fails without it"], "the criteria an agent reads before it starts");
  await claim(f.agent, key);
  for (const [evidence, why] of [
    [undefined, /no evidence for criterion 1 of 2: `pnpm check` passes/],
    [["check green"], /no evidence for criterion 2 of 2: a test fails without it/],
    [["check green", "   "], /no evidence for criterion 2 of 2/],
    [["a", "b", "c"], /3 given for 2 criteria/],
    ["check green", /a list of text/],
  ] as const) {
    const r = await complete(f.agent, key, evidence === undefined ? {} : { evidence });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.message!, why);
  }
  assert.equal(((await call(f.agent, "GET", runs(key))).body.runs as Run[])[0]!.live, true, "a refused completion leaves the run live");

  const done = await complete(f.agent, key, { evidence: ["CI run 12 *green*", "[@Ann](mention:me) see apps/server/src/x.test.ts"], note: "PR #3" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.run!.outcome, "done");
  assert.deepEqual(done.body.comment, { written: true });
  const proof = [
    { criterion: "`pnpm check` passes", evidence: "CI run 12 *green*" },
    { criterion: "a test fails without it", evidence: "[@Ann](mention:me) see apps/server/src/x.test.ts" },
  ];
  assert.deepEqual(done.body.run!.evidence, proof);

  // The run keeps the criteria as they read at completion, whatever the description says later.
  assert.equal((await call(f.owner, "PATCH", `/issues/${key}`, { description: "## Done when\n\n- something else" })).status, 200);
  const after = (await call(f.agent, "GET", runs(key))).body;
  assert.deepEqual((after.runs as Run[])[0]!.evidence, proof);
  assert.deepEqual(after.criteria, ["something else"]);

  const [comment, ...more] = await commentsStarting(key, "Completed the");
  assert.equal(more.length, 0);
  assert.equal(comment!.author, agentEmail);
  assert.equal(
    comment!.body,
    "Completed the work stage. Done when, with evidence:\n\n1. \\`pnpm check\\` passes — CI run 12 \\*green\\*\n2. a test fails without it — \\[\\@Ann\\]\\(mention\\:me\\) see apps\\/server\\/src\\/x\\.test\\.ts\n\nPR \\#3",
    "each criterion with its evidence, as plain text: no mention or emphasis it could carry",
  );
});

test("Done when: an issue without criteria completes as before; a triage run needs no evidence; neither comments", async () => {
  const plain = await newIssue("Nothing to prove", { description: "Just do it.\n\n- a list, but no Done when" });
  assert.deepEqual((await call(f.agent, "GET", runs(plain))).body.criteria, []);
  await claim(f.agent, plain);
  const r = await complete(f.agent, plain, { note: "ok" });
  assert.deepEqual([r.status, r.body.run!.evidence, r.body.comment], [200, null, undefined]);

  const triaged = await newIssue("Triaged first", { description: DONE_WHEN });
  await claim(f.agent, triaged, { stage: "triage" });
  const t = await complete(f.agent, triaged);
  assert.deepEqual([t.status, t.body.run!.evidence], [200, null], JSON.stringify(t.body));
  await claim(f.agent, triaged, { stage: "verify" });
  assert.equal((await complete(f.agent, triaged)).status, 400, "verify proves, as work does");
  assert.equal((await commentsStarting(triaged, "Completed the")).length + (await commentsStarting(plain, "Completed the")).length, 0);
});
