// The webhook from GitHub's side: signed deliveries in, issues, links, history and settings out.
import assert from "node:assert/strict";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { and, eq } from "drizzle-orm";
import type { GithubStatus, IssueHistory } from "@rsva/protocol";
import type { GithubLink } from "@rsva/schema/models";
import { db, schema } from "../db.ts";
import { asUser, fetchAs, importFixture, issueWithRefs, addMember, lastSyncId, startServer, type Fixture } from "../test/helpers.ts";
import type { GithubApi } from "./api.ts";
import { backfillLinks, type PullPayload } from "./events.ts";
import { validSignature } from "./routes.ts";
import { updateProject } from "../sync/settings.ts";

const { attachment, githubDelivery, githubInstallation, githubLink, githubPull, githubRepo, issue, syncAction, user } = schema;
const SECRET = "test-secret";

const commitsOf = new Map<number, string[]>();
const pullsOf = new Map<number, PullPayload>();
const reviewsOf = new Map<number, Awaited<ReturnType<GithubApi["pullReviews"]>>>();
const runsOf = new Map<string, Awaited<ReturnType<GithubApi["checkRuns"]>>>();
const comments: { number: number; id: number | null; body: string }[] = [];
const fakeApi: GithubApi = {
  appSlug: async () => "planner-test",
  installations: async () => [],
  repositories: async () => [],
  pullCommits: async (_i, _r, n) => commitsOf.get(n) ?? [],
  pull: async (_i, repo, n) => {
    const p = pullsOf.get(n);
    if (!p) throw new Error(`GitHub answered 404 to ${repo}#${n}`);
    return p;
  },
  pullReviews: async (_i, _r, n) => reviewsOf.get(n) ?? [],
  checkRuns: async (_i, _r, sha) => runsOf.get(sha) ?? [],
  commit: async (_i, _r, sha) => ({ sha: `${sha}0000`, message: commitMessage, author: "dependabot[bot]", at: "2026-10-20T10:00:00Z" }),
  writeComment: async (_i, _r, number, id, body) => {
    comments.push({ number, id, body });
    return id ?? 777;
  },
};

let server: Awaited<ReturnType<typeof startServer>>;
/** The sockets of slowBodies, closed after the tests if one failed before closing its own. */
const slow: Socket[] = [];
let ws: Fixture;
let refs: Awaited<ReturnType<typeof issueWithRefs>>;
let owner: typeof fetch;
let repoId: number;
let installation: number;
let number: number;
let commitMessage = "";
const repoName = () => `acme/${repoId}`;
const keyOf = (i: { number: number }) => `${refs.project.key}-${i.number}`;

before(async () => {
  // As behind Caddy in production: the client's address comes in X-Forwarded-For (deliver's `ip`, slowBodies).
  process.env.RSVA_TRUST_PROXY = "127.0.0.1";
  [ws, server] = await Promise.all([
    importFixture(),
    startServer({ github: { config: { appId: "1", privateKey: "x", webhookSecret: SECRET }, api: fakeApi } }),
  ]);
  refs = await issueWithRefs(ws.workspaceId);
  owner = fetchAs(await asUser(ws.ownerId));
});
after(() => {
  for (const s of slow) s.destroy();
  return server.close();
});

beforeEach(async () => {
  repoId = randomInt(1, 2 ** 40);
  installation = randomInt(1, 2 ** 40);
  number = randomInt(1, 2 ** 30);
  comments.length = 0;
  await db.insert(githubInstallation).values({ id: installation, account: "acme", accountType: "Organization", installedBy: "robin" });
  await db.insert(githubRepo).values({ id: repoId, fullName: repoName(), installationId: installation, workspaceId: ws.workspaceId, defaultBranch: "main" });
});

function sign(body: string, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function deliver(event: string, payload: object, opts: { id?: string; secret?: string; signature?: string; ip?: string } = {}) {
  const body = JSON.stringify({ installation: { id: installation }, repository: { id: repoId, full_name: repoName(), default_branch: "main", private: true }, ...payload });
  return fetch(`${server.url}/api/github/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": opts.id ?? randomUUID(), "x-hub-signature-256": opts.signature ?? sign(body, opts.secret), ...(opts.ip ? { "x-forwarded-for": opts.ip } : {}) },
    body,
  });
}

function pull(over: Record<string, unknown> = {}) {
  return {
    number,
    title: "Some work",
    body: null,
    state: "open",
    draft: false,
    merged: false,
    user: { login: "robin", type: "User" },
    author_association: "OWNER",
    updated_at: "2026-10-31T10:00:00Z",
    head: { ref: "topic", sha: "aaa", repo: { id: repoId } },
    base: { ref: "main" },
    ...over,
  };
}

const sendPull = (action: string, over: Record<string, unknown> = {}, sender = { login: "robin" }) => deliver("pull_request", { action, sender, pull_request: pull(over) });

async function freshIssue(stateName = "Todo") {
  const s = refs.states.find((x) => x.name === stateName) ?? refs.states.find((x) => x.group === "unstarted")!;
  const [{ n }] = (await db.select({ n: issue.number }).from(issue).where(eq(issue.projectId, refs.project.id)).orderBy(issue.number).limit(1)) as [{ n: number }];
  const [i] = await db
    .insert(issue)
    .values({ workspaceId: ws.workspaceId, projectId: refs.project.id, number: n + randomInt(100_000, 2 ** 30), title: "Rotate keys", stateId: s.id, sortOrder: "a0" })
    .returning();
  return i!;
}

const stateOf = async (id: string) => {
  const [i] = await db.select({ stateId: issue.stateId }).from(issue).where(eq(issue.id, id));
  return refs.states.find((s) => s.id === i!.stateId)!;
};
const started = () => refs.states.filter((s) => s.group === "started");
const linksOf = (id: string) => db.select().from(githubLink).where(eq(githubLink.issueId, id));
const actionsOf = (model: string, id: string) => db.select().from(syncAction).where(and(eq(syncAction.model, model), eq(syncAction.modelId, id)));
/** Payload of a review event: the simplified pull request, with no `merged`. */
const simplified = ({ merged: _, ...p }: ReturnType<typeof pull>) => p;
const nextPull = () => (number = randomInt(1, 2 ** 30));
const history = async (id: string) => (await (await owner(`${server.url}/sync/history/${id}`)).json()) as IssueHistory;

test("signature: only the exact bytes under the secret pass", async () => {
  const body = Buffer.from("{}");
  assert.ok(validSignature(SECRET, body, sign("{}")));
  assert.ok(!validSignature(SECRET, body, sign("{}", "other")));
  assert.ok(!validSignature(SECRET, body, undefined));
  assert.ok(!validSignature(SECRET, body, "sha256=zz"));
  assert.equal((await deliver("ping", {}, { secret: "wrong" })).status, 401);
  assert.equal((await deliver("ping", {})).status, 200);
});

test("switched off without a secret the path does not exist", async () => {
  const off = await startServer({ github: { config: { appId: null, privateKey: null, webhookSecret: null }, api: null } });
  try {
    const r = await fetch(`${off.url}/api/github/webhook`, { method: "POST", body: "{}", headers: { "content-type": "application/json", "x-github-event": "ping", "x-github-delivery": "1" } });
    assert.equal(r.status, 404);
  } finally {
    await off.close();
  }
});

test("a review-ready pull request links the issue and moves it to review; merging closes it", async () => {
  const i = await freshIssue();
  const before = await stateOf(i.id);
  assert.notEqual(before.group, "started");
  const head = `${keyOf(i).toLowerCase()}-rotate`;
  assert.equal((await sendPull("opened", { head: { ref: head, sha: "aaa", repo: { id: repoId } } })).status, 200);
  assert.equal((await stateOf(i.id)).id, started()[1]!.id);

  const h = await history(i.id);
  assert.equal(h.github.length, 1);
  const row = h.github[0]!;
  assert.deepEqual(
    { kind: row.kind, repo: row.repo, number: row.number, state: row.state, review: row.review, closing: row.closing, head: row.head, base: row.base },
    { kind: "pull", repo: repoName(), number, state: "open", review: "required", closing: true, head, base: "main" },
  );
  const move = h.history.find((e) => e.gh);
  assert.equal(move?.gh?.verb, "opened");
  assert.equal(move?.p.stateId, before.id);
  const [bot] = await db.select().from(user).where(eq(user.id, move!.by!));
  assert.equal(bot?.name, "GitHub");
  assert.equal(comments.at(-1)?.number, number);
  assert.match(comments.at(-1)!.body, new RegExp(`${keyOf(i)}.*closes on merge`));

  // The project's home asks for its open pull requests (RSVA-572): this one while it is open, not once it is merged.
  const pulls = async () => ((await (await owner(`${server.url}/sync/project-pulls/${i.projectId}`)).json()) as { pulls: GithubLink[] }).pulls.filter((p) => p.issueId === i.id);
  assert.deepEqual((await pulls()).map((p) => [p.number, p.state, p.review]), [[number, "open", "required"]]);
  assert.equal((await fetch(`${server.url}/sync/project-pulls/${i.projectId}`)).status, 401);
  assert.equal((await owner(`${server.url}/sync/project-pulls/${randomUUID()}`)).status, 404);

  await sendPull("closed", { state: "closed", merged: true, merged_by: { login: "dan" }, head: { ref: head, sha: "aaa", repo: { id: repoId } } });
  assert.deepEqual(await pulls(), []);
  const done = await stateOf(i.id);
  assert.equal(done.group, "completed");
  const after = await history(i.id);
  assert.equal(after.github[0]!.state, "merged");
  const merged = after.history.at(-1)!;
  assert.deepEqual([merged.gh?.verb, merged.gh?.by, merged.d.stateId], ["merged", "dan", done.id]);
});

test("a draft moves to progress, ready for review to review, and only forward", async () => {
  const i = await freshIssue();
  const head = { ref: `${keyOf(i).toLowerCase()}-x`, sha: "aaa", repo: { id: repoId } };
  await sendPull("opened", { draft: true, head });
  assert.equal((await stateOf(i.id)).id, started()[0]!.id);
  await sendPull("ready_for_review", { head }, { login: "dan" });
  assert.equal((await stateOf(i.id)).id, started()[1]!.id);
  const h = await history(i.id);
  assert.deepEqual([h.history.at(-1)!.gh?.verb, h.history.at(-1)!.gh?.by], ["ready", "dan"]);
  // A person sends it back; a later push does not undo that.
  await db.update(issue).set({ stateId: started()[0]!.id }).where(eq(issue.id, i.id));
  await sendPull("synchronize", { head: { ...head, sha: "bbb" } });
  assert.equal((await stateOf(i.id)).id, started()[0]!.id);
  // A draft again never moves it back from review.
  await db.update(issue).set({ stateId: started()[1]!.id }).where(eq(issue.id, i.id));
  await sendPull("opened", { draft: true, head });
  assert.equal((await stateOf(i.id)).id, started()[1]!.id);
});

test("a Linked merge leaves the state and says so", async () => {
  const i = await freshIssue();
  await sendPull("opened", { body: `Refs ${keyOf(i)}` });
  const before = await stateOf(i.id);
  await sendPull("closed", { state: "closed", merged: true, merged_by: { login: "dan" }, body: `Refs ${keyOf(i)}` });
  assert.equal((await stateOf(i.id)).id, before.id);
  const h = await history(i.id);
  assert.equal(h.github[0]!.closing, false);
  const line = h.history.at(-1)!;
  assert.deepEqual([line.gh?.verb, line.gh?.closing, Object.keys(line.d).length], ["merged", false, 0]);
  const [{ updatedAt } = { updatedAt: "" }] = await db.select({ updatedAt: issue.updatedAt }).from(issue).where(eq(issue.id, i.id));
  assert.equal(updatedAt, i.updatedAt);
});

test("closed unmerged and merged elsewhere than the default branch move nothing", async () => {
  const a = await freshIssue();
  await sendPull("closed", { state: "closed", title: `${keyOf(a)} try` });
  assert.notEqual((await stateOf(a.id)).group, "completed");
  const b = await freshIssue();
  number = randomInt(1, 2 ** 30);
  await sendPull("closed", { state: "closed", merged: true, merged_by: { login: "dan" }, title: `${keyOf(b)} try`, base: { ref: "release" } });
  assert.notEqual((await stateOf(b.id)).group, "completed");
});

test("cancelled stays cancelled, deleted issues and other projects are out of reach", async () => {
  const cancelled = refs.states.find((s) => s.group === "cancelled");
  assert.ok(cancelled);
  const i = await freshIssue(cancelled!.name);
  await db.update(issue).set({ stateId: cancelled!.id }).where(eq(issue.id, i.id));
  await sendPull("closed", { state: "closed", merged: true, title: `${keyOf(i)} late` });
  assert.equal((await stateOf(i.id)).id, cancelled!.id);

  const gone = await freshIssue();
  await db.update(issue).set({ deletedAt: "2026-10-31T00:00:00Z" }).where(eq(issue.id, gone.id));
  number = randomInt(1, 2 ** 30);
  await sendPull("opened", { title: `${keyOf(gone)} x` });
  assert.equal((await db.select().from(githubLink).where(eq(githubLink.issueId, gone.id))).length, 0);

  const limited = await freshIssue();
  await db.update(githubRepo).set({ projectIds: [refs.other.id] }).where(eq(githubRepo.id, repoId));
  number = randomInt(1, 2 ** 30);
  await sendPull("opened", { title: `${keyOf(limited)} x` });
  assert.equal((await db.select().from(githubLink).where(eq(githubLink.issueId, limited.id))).length, 0);
});

test("an outsider's fork, a repository not bound and one switched off reach nothing", async () => {
  const i = await freshIssue();
  await sendPull("opened", { title: `${keyOf(i)} x`, author_association: "NONE", head: { ref: "x", sha: "s", repo: { id: 999 } } });
  assert.equal((await history(i.id)).github.length, 0);

  await db.update(githubRepo).set({ enabled: false }).where(eq(githubRepo.id, repoId));
  await sendPull("opened", { title: `${keyOf(i)} x` });
  await db.update(githubRepo).set({ enabled: true, workspaceId: null }).where(eq(githubRepo.id, repoId));
  await sendPull("opened", { title: `${keyOf(i)} x` });
  assert.equal((await history(i.id)).github.length, 0);
});

test("a delivery from another installation is ignored and reported", async () => {
  const i = await freshIssue();
  const was = installation;
  installation = randomInt(1, 2 ** 40);
  await sendPull("opened", { title: `${keyOf(i)} x` });
  installation = was;
  assert.equal((await history(i.id)).github.length, 0);
  const [r] = await db.select().from(githubRepo).where(eq(githubRepo.id, repoId));
  assert.match(r!.lastError ?? "", /another installation/);
});

test("a redelivery changes nothing, a failed delivery can be delivered again", async () => {
  const i = await freshIssue();
  const id = randomUUID();
  const send = () => deliver("pull_request", { action: "opened", sender: { login: "a" }, pull_request: pull({ title: `${keyOf(i)} x` }) }, { id });
  await send();
  const s = await lastSyncId(ws.workspaceId);
  const again = await send();
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true, duplicate: true });
  assert.equal(await lastSyncId(ws.workspaceId), s);

  const j = await freshIssue();
  number = randomInt(1, 2 ** 30);
  const failed = randomUUID();
  await db.insert(githubDelivery).values({ id: failed, event: "pull_request.opened", status: 500, error: "boom" });
  await deliver("pull_request", { action: "opened", sender: { login: "a" }, pull_request: pull({ title: `${keyOf(j)} x` }) }, { id: failed });
  assert.equal((await history(j.id)).github.length, 1);
  const [row] = await db.select().from(githubDelivery).where(eq(githubDelivery.id, failed));
  assert.deepEqual([row?.status, row?.error], [200, null]);
});

test("a server stopped mid-delivery does not lose it; one still running is left alone", async () => {
  const i = await freshIssue();
  const send = (id: string) => deliver("pull_request", { action: "opened", sender: { login: "a" }, pull_request: pull({ title: `${keyOf(i)} x` }) }, { id });
  const running = randomUUID();
  await db.insert(githubDelivery).values({ id: running, event: "pull_request.opened" });
  assert.deepEqual(await (await send(running)).json(), { ok: true, duplicate: true });
  const stuck = randomUUID();
  await db.insert(githubDelivery).values({ id: stuck, event: "pull_request.opened", createdAt: "2026-10-31T00:00:00Z" });
  assert.deepEqual(await (await send(stuck)).json(), { ok: true });
  assert.equal((await history(i.id)).github.length, 1);
});

test("reviews and checks reach the row; a new head starts checks over", async () => {
  const i = await freshIssue();
  const over = { title: `${keyOf(i)} x`, head: { ref: "t", sha: "h1", repo: { id: repoId } } };
  await sendPull("opened", over);
  const review = (state: string, who: string) => deliver("pull_request_review", { action: "submitted", review: { state, user: { login: who }, author_association: "MEMBER" }, pull_request: pull(over) });
  await review("approved", "a");
  assert.equal((await history(i.id)).github[0]!.review, "approved");
  await review("changes_requested", "b");
  assert.equal((await history(i.id)).github[0]!.review, "changes");
  await review("approved", "b");
  await review("commented", "c");
  assert.equal((await history(i.id)).github[0]!.review, "approved");

  const check = (name: string, status: string, conclusion: string | null) => deliver("check_run", { action: "completed", check_run: { name, status, conclusion, head_sha: "h1" } });
  await check("ci", "in_progress", null);
  assert.equal((await history(i.id)).github[0]!.checks, "run");
  await check("ci", "completed", "success");
  await deliver("status", { context: "deploy", state: "success", sha: "h1" });
  assert.equal((await history(i.id)).github[0]!.checks, "pass");
  await check("lint", "completed", "failure");
  await check("types", "completed", "timed_out");
  const row = (await history(i.id)).github[0]!;
  assert.deepEqual([row.checks, row.failing], ["fail", 2]);
  await check("other", "completed", "failure"); // of another head: no pull request
  await sendPull("synchronize", { ...over, head: { ...over.head, sha: "h2" } });
  assert.equal((await history(i.id)).github[0]!.checks, null);
});

test("a key edited out drops the link; the commits of the pull request count", async () => {
  const i = await freshIssue();
  const j = await freshIssue();
  await sendPull("opened", { title: `${keyOf(i)} x` });
  assert.equal((await history(i.id)).github.length, 1);
  commitsOf.set(number, [`Fixes ${keyOf(j)}`]);
  await sendPull("synchronize", { title: "No key" });
  assert.equal((await history(i.id)).github.length, 0);
  const [link] = (await history(j.id)).github;
  assert.equal(link?.closing, true);
  // An edit does not read commits again: what they said stands.
  await sendPull("edited", { title: "Still none" });
  assert.equal((await history(j.id)).github.length, 1);
});

test("pushes to the default branch link commits; a closing one closes, a rerun does nothing", async () => {
  const i = await freshIssue();
  const before = await stateOf(i.id);
  const commit = (id: string, message: string) => ({ id, distinct: true, message, timestamp: "2026-10-31T09:58:00Z", author: { username: "atlas", name: "Robin" } });
  await deliver("push", { ref: "refs/heads/topic", commits: [commit("feature", `Fixes ${keyOf(i)}`)], sender: { login: "robin" } });
  assert.equal((await history(i.id)).github.length, 0);
  const push = { ref: "refs/heads/main", commits: [commit("a4c19e2aaaa", `Move cron (${keyOf(i)})\n\nmore`)], sender: { login: "robin" } };
  await deliver("push", push);
  assert.equal((await stateOf(i.id)).id, before.id);
  await deliver("push", { ...push, commits: [commit("a4c19e2aaaa", `Move cron (${keyOf(i)})`), commit("9be0f17bbbb", `Closes ${keyOf(i)}`)] });
  assert.equal((await stateOf(i.id)).group, "completed");
  const h = await history(i.id);
  assert.deepEqual(h.github.map((c) => [c.kind, c.sha, c.title, c.closing]).sort(), [
    ["commit", "9be0f17bbbb", `Closes ${keyOf(i)}`, true],
    ["commit", "a4c19e2aaaa", `Move cron (${keyOf(i)})`, false],
  ]);
  assert.deepEqual(h.history.filter((e) => e.gh).map((e) => e.gh!.verb), ["pushed", "pushed"]);
});

test("a new branch with a key starts the work once; other refs do nothing", async () => {
  const i = await freshIssue();
  await deliver("create", { ref_type: "branch", ref: `${keyOf(i).toLowerCase()}-x`, sender: { login: "robin" } });
  assert.equal((await stateOf(i.id)).id, started()[0]!.id);
  assert.equal((await history(i.id)).history.at(-1)!.gh?.verb, "branch");
  await deliver("create", { ref_type: "tag", ref: keyOf(i) });
  assert.equal((await history(i.id)).history.filter((e) => e.gh).length, 1);
});

test("a branch named after a key an issue had before a move still finds it (PLNR-448)", async () => {
  const i = await freshIssue();
  const was = `GONE${randomInt(1000, 9999)}-${randomInt(1, 999)}`;
  await db.update(issue).set({ formerKeys: [was] }).where(eq(issue.id, i.id));
  await deliver("create", { ref_type: "branch", ref: `${was.toLowerCase()}-rotate-keys`, sender: { login: "robin" } });
  assert.equal((await stateOf(i.id)).id, started()[0]!.id);
  // A pull request naming it links it too.
  nextPull();
  await sendPull("opened", { title: `Rotate keys (${was})`, head: { ref: "topic", sha: "bbb", repo: { id: repoId } } });
  assert.equal((await linksOf(i.id)).length, 1);
});

test("the second started state being one only people set is left alone", async () => {
  const second = started()[1]!;
  const was = second.name;
  await db.update(schema.workflowState).set({ name: "Approved", onlyPeople: true }).where(eq(schema.workflowState.id, second.id));
  try {
    const i = await freshIssue();
    await sendPull("opened", { title: `${keyOf(i)} x` });
    assert.notEqual((await stateOf(i.id)).id, second.id);
  } finally {
    await db.update(schema.workflowState).set({ name: was, onlyPeople: false }).where(eq(schema.workflowState.id, second.id));
  }
});

test("the comment is written once per change of issues and updated in place", async () => {
  const i = await freshIssue();
  await sendPull("opened", { title: `${keyOf(i)} x` });
  await sendPull("edited", { title: `${keyOf(i)} y` });
  assert.equal(comments.length, 1);
  await sendPull("edited", { title: "gone" });
  assert.equal(comments.length, 2);
  assert.equal(comments[1]!.id, 777);
  assert.match(comments[1]!.body, /no linked issues/);
  const [p] = await db.select().from(githubPull).where(and(eq(githubPull.repoId, repoId), eq(githubPull.number, number)));
  assert.equal(p?.commentId, 777);
});

test("a public repository's pull request gets no comment, and its issues are linked all the same (RSVA-628)", async () => {
  const i = await freshIssue();
  const body = JSON.stringify({ action: "opened", sender: { login: "a" }, installation: { id: installation }, repository: { id: repoId, full_name: repoName(), private: false }, pull_request: pull({ title: `${keyOf(i)} x` }) });
  const res = await fetch(`${server.url}/api/github/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": randomUUID(), "x-hub-signature-256": sign(body) }, body });
  assert.equal(res.status, 200);
  assert.equal(comments.length, 0);
  assert.equal((await linksOf(i.id)).length, 1);
});

test("one log action says the move and its cause; the project's history shows a Linked merge as the merge it is", async () => {
  const i = await freshIssue();
  await sendPull("opened", { title: `${keyOf(i)} x` });
  const rows = await db.select().from(syncAction).where(and(eq(syncAction.modelId, i.id), eq(syncAction.model, "Issue")));
  assert.equal(rows.length, 1);
  assert.ok((rows[0]!.data as { gh?: unknown }).gh);

  const j = await freshIssue();
  number = randomInt(1, 2 ** 30);
  await sendPull("closed", { state: "closed", merged: true, body: `Refs ${keyOf(j)}` });
  const page = (await (await owner(`${server.url}/sync/project-history?project=${refs.project.id}&level=everything`)).json()) as { history: { i: string; d: object; gh?: { verb: string } }[] };
  assert.ok(page.history.some((e) => e.i === i.id));
  const linked = page.history.filter((e) => e.i === j.id);
  assert.deepEqual(linked.map((e) => [e.gh?.verb, Object.keys(e.d).length]), [["merged", 0]], "no field moved, and the line says what GitHub did");
});

test("settings: admins only, what the server holds, what is missing", async () => {
  const url = `${server.url}/api/v1/workspaces/${ws.slug}/github`;
  const member = await addMember(ws.workspaceId, "member");
  assert.equal((await fetchAs(await asUser(member.id))(url)).status, 403);
  await sendPull("opened", {});
  const s = (await (await owner(url)).json()) as GithubStatus;
  assert.deepEqual(s.setup, { appId: true, privateKey: true, webhookSecret: true, installed: true });
  assert.equal(s.app.slug, "planner-test");
  assert.ok(s.repositories.some((r) => r.name === repoName() && r.enabled));
  assert.equal(s.lastDelivery?.event, "pull_request.opened");
  assert.ok(s.installations.some((x) => x.account === "acme"));
  assert.equal(s.repositories.find((r) => r.name === repoName())?.error, null);

  const off = await startServer({ github: { config: { appId: null, privateKey: null, webhookSecret: null }, api: null } });
  try {
    const m = (await (await owner(`${off.url}/api/v1/workspaces/${ws.slug}/github`)).json()) as GithubStatus;
    assert.deepEqual(m.setup.appId, false);
    assert.deepEqual(m.repositories, []);
  } finally {
    await off.close();
  }
});

test("the snapshot names the bot in a bound workspace, and agents read the same pull requests", async () => {
  const i = await freshIssue();
  await sendPull("opened", { title: `${keyOf(i)} x` });
  const r = await owner(`${server.url}/sync/bootstrap?ws=${ws.slug}`, { headers: { "accept-encoding": "identity" } });
  const line = (await r.text()).split("\n").map((l) => (l ? (JSON.parse(l) as { t: string; m?: string; c?: string[]; r?: unknown[][] }) : null)).find((l) => l?.m === "User")!;
  const name = line.c!.indexOf("name");
  const role = line.c!.indexOf("role");
  assert.deepEqual(line.r!.filter((row) => row[name] === "GitHub").map((row) => row[role]), [null]);

  const got = (await (await owner(`${server.url}/api/v1/workspaces/${ws.slug}/issues/${keyOf(i)}`)).json()) as { branch: string; pullRequests: { url: string; closing: boolean }[] };
  assert.match(got.branch, new RegExp(`^${keyOf(i).toLowerCase()}-rotate-keys$`));
  assert.equal(got.pullRequests[0]?.url, `https://github.com/${repoName()}/pull/${number}`);
  assert.equal(got.pullRequests[0]?.closing, true);
});

test("a late delivery does not undo a merge, and a stale one changes nothing", async () => {
  const i = await freshIssue();
  const over = { title: `${keyOf(i)} x` };
  await sendPull("opened", over);
  const merged = { ...over, state: "closed", merged: true, merged_at: "2026-10-31T11:00:00Z", merged_by: { login: "dan" }, updated_at: "2026-10-31T11:00:00Z" };
  await sendPull("closed", merged);
  const state = (await history(i.id)).github[0]!.state;
  assert.equal(state, "merged");
  // The review GitHub sent before the merge arrives after it, and an older edit too.
  await deliver("pull_request_review", { action: "submitted", review: { state: "approved", user: { login: "a" }, author_association: "OWNER" }, pull_request: simplified(pull(over)) });
  await sendPull("labeled", { title: "An older title" });
  const [row] = (await history(i.id)).github;
  assert.deepEqual([row?.state, row?.title, row?.review], ["merged", `${keyOf(i)} x`, "approved"]);
  // A review dismissed on the merged pull request: state closed, `merged_at` set, no `merged` field.
  await deliver("pull_request_review", { action: "dismissed", review: { state: "dismissed", user: { login: "a" }, author_association: "OWNER" }, pull_request: simplified(pull({ ...merged, updated_at: "2026-10-31T12:00:00Z" })) });
  assert.equal((await history(i.id)).github[0]?.state, "merged");
});

test("a merge that arrives after a newer event still closes the issue", async () => {
  const i = await freshIssue();
  await sendPull("opened", { title: `${keyOf(i)} x`, updated_at: "2026-10-31T12:00:00Z" });
  await sendPull("closed", { title: `${keyOf(i)} x`, state: "closed", merged: true, updated_at: "2026-10-31T11:00:00Z" });
  assert.equal((await stateOf(i.id)).group, "completed");
});

test("a key past what an issue number can be is no key: the delivery still applies", async () => {
  const i = await freshIssue();
  const r = await sendPull("opened", { title: `${keyOf(i)} x`, body: `See ${refs.project.key}-3000000000 and ${refs.project.key}-2147483648` });
  assert.equal(r.status, 200);
  assert.equal((await linksOf(i.id)).length, 1);
  const message = `Fixes ${keyOf(i)}, ${refs.project.key}-3000000000`;
  assert.equal((await deliver("push", { ref: "refs/heads/main", commits: [{ id: "c1", message, timestamp: "2026-10-31T09:00:00Z" }] })).status, 200);
});

test("an old key and the new one name one issue, one link", async () => {
  const i = await freshIssue();
  const old = `OLD${randomInt(1000, 9999)}`;
  await db.update(schema.project).set({ formerKeys: [old] }).where(eq(schema.project.id, refs.project.id));
  try {
    const r = await sendPull("opened", { title: `${keyOf(i)} x`, body: `Refs ${old}-${i.number}` });
    assert.equal(r.status, 200);
    const links = await linksOf(i.id);
    assert.equal(links.length, 1);
    assert.equal(links[0]!.closing, false);
  } finally {
    await db.update(schema.project).set({ formerKeys: [] }).where(eq(schema.project.id, refs.project.id));
  }
});

/** Renames a project as a person does, with the takeover of a key an emptied project gave up (PLNR-448). */
const rename = (id: string, key: string) => db.transaction((tx) => updateProject(tx, ws.workspaceId, id, { key }));
/** Back to its key, with no former keys left behind for the next test. */
async function renameBack(id: string, key: string) {
  await rename(id, key);
  await db.update(schema.project).set({ formerKeys: [] }).where(eq(schema.project.id, id));
}

test("a renamed project stays bound: its old key and the new one link, settings show the new one (PLNR-454)", async () => {
  const i = await freshIssue();
  const was = refs.project.key;
  const now = `REN${randomInt(1000, 9999)}`;
  await db.update(githubRepo).set({ projectIds: [refs.project.id] }).where(eq(githubRepo.id, repoId));
  await rename(refs.project.id, now);
  try {
    const commit = (id: string, message: string) => ({ id, distinct: true, message, timestamp: "2026-10-31T09:58:00Z", author: { username: "atlas", name: "Robin" } });
    await deliver("push", { ref: "refs/heads/main", commits: [commit("c0ffee1aaaa", `Rotate (${was}-${i.number})`), commit("c0ffee2bbbb", `More (${now}-${i.number})`)], sender: { login: "robin" } });
    await sendPull("opened", { title: `${now}-${i.number} x` });
    assert.deepEqual((await linksOf(i.id)).map((l) => l.sha ?? "pull").sort(), ["c0ffee1aaaa", "c0ffee2bbbb", "pull"]);
    const s = (await (await owner(`${server.url}/api/v1/workspaces/${ws.slug}/github`)).json()) as GithubStatus;
    assert.deepEqual(s.repositories.find((r) => r.name === repoName())?.projects, [now]);
  } finally {
    await renameBack(refs.project.id, was);
  }
});

test("a key another project takes over does not take the binding with it (PLNR-454)", async () => {
  const freed = `FREE${randomInt(1000, 9999)}`;
  const [emptied] = await db.insert(schema.project).values({ workspaceId: ws.workspaceId, key: freed, name: "Emptied" }).returning();
  await db.update(githubRepo).set({ projectIds: [emptied!.id] }).where(eq(githubRepo.id, repoId));
  await rename(emptied!.id, `${freed}X`);
  const was = refs.other.key;
  await rename(refs.other.id, freed);
  try {
    const [o] = await db.select().from(issue).where(eq(issue.projectId, refs.other.id)).limit(1);
    await sendPull("opened", { title: `${freed}-${o!.number} x` });
    assert.equal((await linksOf(o!.id)).length, 0);
    // The same delivery once the repository is bound to the taker: the key itself resolves.
    await db.update(githubRepo).set({ projectIds: [refs.other.id] }).where(eq(githubRepo.id, repoId));
    nextPull();
    await sendPull("opened", { title: `${freed}-${o!.number} x` });
    assert.equal((await linksOf(o!.id)).length, 1);
  } finally {
    await renameBack(refs.other.id, was);
    await db.delete(schema.project).where(eq(schema.project.id, emptied!.id));
  }
});

test("two deliveries at once never move an issue backward", async () => {
  for (let n = 0; n < 8; n++) {
    const i = await freshIssue();
    nextPull();
    await Promise.all([deliver("create", { ref_type: "branch", ref: `${keyOf(i).toLowerCase()}-x`, sender: { login: "a" } }), sendPull("opened", { title: `${keyOf(i)} x` })]);
    assert.equal((await stateOf(i.id)).id, started()[1]!.id);
  }
});

test("a revert neither moves nor closes anything", async () => {
  const i = await freshIssue();
  const head = { ref: `revert-44-${keyOf(i).toLowerCase()}-x`, sha: "r1", repo: { id: repoId } };
  await sendPull("opened", { title: `Revert "${keyOf(i)} x"`, head });
  const before = await stateOf(i.id);
  assert.notEqual(before.group, "started");
  await sendPull("closed", { title: `Revert "${keyOf(i)} x"`, head, state: "closed", merged: true });
  assert.equal((await stateOf(i.id)).id, before.id);
  assert.equal((await linksOf(i.id))[0]?.closing, false);
  await deliver("push", { ref: "refs/heads/main", commits: [{ id: "c2", message: `Revert "Fixes ${keyOf(i)}"`, timestamp: "2026-10-31T09:00:00Z" }] });
  assert.equal((await stateOf(i.id)).id, before.id);
});

test("one comment on a pull request, however fast its events come", async () => {
  const i = await freshIssue();
  const j = await freshIssue();
  await Promise.all([sendPull("opened", { title: `${keyOf(i)} x` }), sendPull("edited", { title: `${keyOf(i)} x`, body: `Refs ${keyOf(j)}` })]);
  assert.equal(comments.filter((c) => c.id === null).length, 1);
});

test("an issue title in the comment is plain text and mentions nobody", async () => {
  const i = await freshIssue();
  await db.update(issue).set({ title: "@robin see [x](https://evil.example) acme/x#1" }).where(eq(issue.id, i.id));
  await sendPull("opened", { title: `${keyOf(i)} x` });
  const body = comments.at(-1)!.body;
  assert.ok(body.includes("@<!-- -->robin"));
  assert.ok(!body.includes("[x](https"));
  assert.ok(!body.includes("acme/x#1"));
});

test("the bot is announced once in a workspace's log, and only when it writes", async () => {
  const other = await importFixture();
  await db.update(githubRepo).set({ workspaceId: other.workspaceId }).where(eq(githubRepo.id, repoId));
  const r = await issueWithRefs(other.workspaceId);
  const [bot] = await db.select().from(user).where(eq(user.email, "github-bot@rsva.invalid"));
  const mine = () => db.select().from(syncAction).where(and(eq(syncAction.workspaceId, other.workspaceId), eq(syncAction.model, "User"), eq(syncAction.modelId, bot?.id ?? randomUUID())));
  await sendPull("opened", { title: "No key" });
  assert.equal((await mine()).length, 0);
  await sendPull("edited", { title: `${r.project.key}-${r.issue.number} x` });
  await sendPull("edited", { title: `${r.project.key}-${r.issue.number} y` });
  const told = await mine();
  assert.equal(told.length, 1);
  assert.deepEqual((({ name, role, kind }) => ({ name, role, kind }))(told[0]!.data as { name: string; role: null; kind: string }), { name: "GitHub", role: null, kind: "bot" });
});

test("what nobody can see makes no delta", async () => {
  const i = await freshIssue();
  const over = { title: `${keyOf(i)} x`, head: { ref: "t", sha: "quiet", repo: { id: repoId } } };
  await sendPull("opened", over);
  const check = (name: string) => deliver("check_run", { action: "completed", check_run: { name, status: "completed", conclusion: "success", head_sha: "quiet" } });
  await check("first");
  const s = await lastSyncId(ws.workspaceId);
  await check("second");
  await sendPull("labeled", { ...over, updated_at: "2026-10-31T10:30:00Z" });
  assert.equal(await lastSyncId(ws.workspaceId), s);
});

test("reviews from outside the repository do not count", async () => {
  const i = await freshIssue();
  await sendPull("opened", { title: `${keyOf(i)} x` });
  await deliver("pull_request_review", { action: "submitted", review: { state: "approved", user: { login: "stranger" }, author_association: "NONE" }, pull_request: pull({ title: `${keyOf(i)} x` }) });
  assert.equal((await history(i.id)).github[0]?.review, "required");
});

test("a bound repository stays with its installation", async () => {
  const stranger = randomInt(1, 2 ** 40);
  await db.insert(githubInstallation).values({ id: stranger, account: "stranger", accountType: "User" });
  const body = { action: "added", installation: { id: stranger, account: { login: "stranger", type: "User" } }, repositories_added: [{ id: repoId, full_name: "stranger/took-it", private: false }] };
  await deliver("installation_repositories", body);
  let [r] = await db.select().from(githubRepo).where(eq(githubRepo.id, repoId));
  assert.equal(r?.installationId, installation);

  // Claimed by another installation, nothing of the event is written.
  const was = installation;
  installation = stranger;
  await deliver("push", { ref: "x", repository: { id: repoId, full_name: "stranger/took-it", default_branch: "evil", private: false } });
  installation = was;
  [r] = await db.select().from(githubRepo).where(eq(githubRepo.id, repoId));
  assert.deepEqual([r?.fullName, r?.defaultBranch, r?.isPrivate], [repoName(), "main", true]);

  // Removed from the App, it stops until the operator turns it back on.
  await deliver("installation_repositories", { action: "removed", installation: { id: installation, account: { login: "acme", type: "Organization" } }, repositories_removed: [{ id: repoId }] });
  [r] = await db.select().from(githubRepo).where(eq(githubRepo.id, repoId));
  assert.deepEqual([r?.installationId, r?.enabled], [null, false]);
});

test("an installation first seen on a repository event is recorded", async () => {
  const fresh = randomInt(1, 2 ** 40);
  await db.update(githubRepo).set({ installationId: null }).where(eq(githubRepo.id, repoId));
  installation = fresh;
  const r = await sendPull("opened", {});
  assert.equal(r.status, 200);
  const [row] = await db.select().from(githubInstallation).where(eq(githubInstallation.id, fresh));
  assert.equal(row?.account, "acme");
});

test("a push is bounded, and merged commits count though GitHub saw them on their branch", async () => {
  const i = await freshIssue();
  const many = Array.from({ length: 300 }, (_, n) => ({ id: `bulk${n}`, distinct: false, message: `Refs ${keyOf(i)}`, timestamp: "2026-10-31T09:00:00Z" }));
  assert.equal((await deliver("push", { ref: "refs/heads/main", commits: many })).status, 200);
  assert.equal((await linksOf(i.id)).length, 200);
});

/** Deliveries from `ip` that send their headers and never the rest of the body: each holds a slot while it may. */
async function slowBodies(n: number, ip: string) {
  const open = Array.from({ length: n }, () => connect(Number(new URL(server.url).port), "127.0.0.1"));
  slow.push(...open);
  await Promise.all(open.map((s) => new Promise((ok) => s.once("connect", ok))));
  for (const s of open) s.write(`POST /api/github/webhook HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: ${ip}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`);
  return open;
}

/**
 * Whether a delivery from `ip` gets `status` (by default 503, busy), asked a few times: the server sees slow bodies take
 * their slots, or closed ones give them back, a moment after the client.
 */
async function answers(ip: string, status = 503) {
  for (let i = 0; i < 20; i++) if ((await deliver("ping", {}, { ip })).status === status) return true;
  return false;
}

test("slow bodies take a bounded number of slots, freed when they go", async () => {
  const open = (await Promise.all(["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"].map((ip) => slowBodies(2, ip)))).flat();
  assert.ok(await answers("203.0.113.5"));
  for (const s of open) s.destroy();
  assert.ok(await answers("203.0.113.5", 200));
});

test("one address holds two slots at most; deliveries from other addresses go through meanwhile (RSVA-97)", async () => {
  const open = [...(await slowBodies(2, "198.51.100.1")), ...(await slowBodies(2, "2001:db8:1:2::1"))];
  assert.ok(await answers("198.51.100.1"));
  assert.ok(await answers("2001:db8:1:2::ffff"), "an IPv6 client is one client across its /64");
  for (const ip of ["198.51.100.2", "2001:db8:1:3::1", "127.0.0.1"]) assert.equal((await deliver("ping", {}, { ip })).status, 200, ip);
  for (const s of open) s.destroy();
  assert.ok(await answers("198.51.100.1", 200));
});

test("a delivery read to the end gives its slot back", async () => {
  await slowBodies(1, "198.51.100.7");
  for (let i = 0; i < 3; i++) assert.equal((await deliver("ping", {}, { ip: "198.51.100.7" })).status, 200);
});

test("a body not read in 15 s loses its slot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await slowBodies(2, "198.51.100.9");
  assert.ok(await answers("198.51.100.9"));
  t.mock.timers.tick(15_000);
  t.mock.timers.reset();
  assert.ok(await answers("198.51.100.9", 200));
});

test("a delivery with a bad signature changes nothing any workspace sees, whatever repository its body names", async () => {
  const url = `${server.url}/api/v1/workspaces/${ws.slug}/github`;
  const before = await (await owner(url)).text();
  const body = JSON.stringify({ repository: { id: repoId, full_name: "evil/visit-evil.example" } });
  for (const signature of ["sha256=00", undefined]) {
    const res = await fetch(`${server.url}/api/github/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": randomUUID(), ...(signature ? { "x-hub-signature-256": signature } : {}) }, body });
    assert.equal(res.status, 401);
  }
  assert.equal(await (await owner(url)).text(), before);
});

const imported = async (issueId: string, kind: "github_pr" | "github_commit", path: string) =>
  (await db.insert(attachment).values({ workspaceId: ws.workspaceId, issueId, kind, url: `https://github.com/${repoName()}/${path}` }).returning())[0]!;
const attachmentsOf = (id: string) => db.select().from(attachment).where(eq(attachment.issueId, id));
const lineOf = (lines: Awaited<ReturnType<typeof backfillLinks>>, ref: string) => lines.filter((l) => l.ref === ref);

test("backfill moves an imported pull request to the block and nothing else happens", async () => {
  const i = await freshIssue();
  const before = await stateOf(i.id);
  const link = await imported(i.id, "github_pr", `pull/${number}`);
  pullsOf.set(number, pull({ title: `Fixes ${keyOf(i)}`, state: "closed", merged: true, updated_at: "2026-10-20T10:00:00Z", head: { ref: "topic", sha: "old", repo: { id: repoId } } }) as PullPayload);
  reviewsOf.set(number, [{ state: "COMMENTED", user: { login: "sam" }, author_association: "MEMBER" }, { state: "APPROVED", user: { login: "sam" }, author_association: "MEMBER" }, { state: "CHANGES_REQUESTED", user: { login: "stranger" }, author_association: "NONE" }]);
  runsOf.set("old", [{ name: "ci", status: "completed", conclusion: "success" }]);

  const ref = `${repoName()}#${number}`;
  assert.deepEqual(lineOf(await backfillLinks(fakeApi, true), ref).map((l) => l.result), ["moved"]);
  assert.equal((await linksOf(i.id)).length, 0);
  assert.equal((await attachmentsOf(i.id)).length, 1);

  assert.deepEqual(lineOf(await backfillLinks(fakeApi, false), ref), [{ ref, key: keyOf(i), result: "moved" }]);
  const [row] = await linksOf(i.id);
  assert.equal(row!.closing, true);
  const [stored] = await db.select().from(githubPull).where(eq(githubPull.id, row!.pullId!));
  assert.deepEqual([stored!.state, stored!.reviews, stored!.checks], ["merged", { sam: "approved" }, { ci: "pass" }]);
  assert.equal((await attachmentsOf(i.id)).length, 0);
  assert.deepEqual((await actionsOf("Attachment", link.id)).map((a) => a.action), ["D"]);
  assert.deepEqual((await actionsOf("GithubLink", row!.id)).map((a) => a.action), ["I"]);

  assert.equal((await stateOf(i.id)).id, before.id);
  assert.equal(comments.length, 0);
  assert.equal((await actionsOf("Issue", i.id)).length, 0);
  assert.equal(lineOf(await backfillLinks(fakeApi, false), ref).length, 0);
});

test("backfill keeps a link its pull request does not name, and one it cannot read", async () => {
  const i = await freshIssue();
  await imported(i.id, "github_pr", `pull/${number}`);
  pullsOf.set(number, pull({ title: "Other work" }) as PullPayload);
  const named = number;
  const missing = nextPull();
  await imported(i.id, "github_pr", `pull/${missing}`);
  const lines = await backfillLinks(fakeApi, false);
  assert.deepEqual(lineOf(lines, `${repoName()}#${named}`).map((l) => [l.result, l.why]), [["kept", "does not name the issue"]]);
  assert.equal(lineOf(lines, `${repoName()}#${missing}`)[0]!.result, "failed");
  assert.equal((await attachmentsOf(i.id)).length, 2);
  assert.equal((await linksOf(i.id)).length, 0);
});

test("backfill moves an imported commit; a repository not bound keeps its links", async () => {
  const i = await freshIssue();
  commitMessage = `Refs ${keyOf(i)}: the work\n\nMore text`;
  await imported(i.id, "github_commit", "commit/abcdef1234");
  const free = await imported(i.id, "github_pr", "pull/1");
  await db.update(attachment).set({ url: "https://github.com/acme/unknown/pull/1" }).where(eq(attachment.id, free.id));
  const lines = await backfillLinks(fakeApi, false);
  assert.equal(lineOf(lines, "acme/unknown#1").find((l) => l.key === keyOf(i))?.why, "repository not bound");
  const [row] = await linksOf(i.id);
  assert.deepEqual([row!.sha, row!.message, row!.author, row!.authorBot, row!.closing], ["abcdef10000", `Refs ${keyOf(i)}: the work`, "dependabot", true, false]);
  assert.deepEqual((await attachmentsOf(i.id)).map((a) => a.id), [free.id]);
  assert.equal((await actionsOf("Issue", i.id)).length, 0);
});

test("a pull request's next event finds the row backfill made", async () => {
  const i = await freshIssue();
  await imported(i.id, "github_pr", `pull/${number}`);
  const old = pull({ title: `Fixes ${keyOf(i)}`, updated_at: "2026-10-20T10:00:00Z" });
  pullsOf.set(number, old as PullPayload);
  await backfillLinks(fakeApi, false);
  const before = await stateOf(i.id);
  await sendPull("edited", { title: `Fixes ${keyOf(i)} better` });
  const rows = await linksOf(i.id);
  assert.equal(rows.length, 1);
  assert.equal((await stateOf(i.id)).id, before.id);
  assert.equal(comments.length, 0);
});
