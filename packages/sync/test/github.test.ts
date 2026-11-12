import assert from "node:assert/strict";
import { test } from "node:test";
import type { Action, IssueHistory, ProjectHistory } from "@rsva/protocol";
import type { GithubEvent, GithubLink } from "@rsva/schema/models";
import { DONE, ISSUE, online, openedFeed, PROJECT, TODO, until } from "./fake.ts";

const [A, B] = ISSUE;
const BOT = "00000000-0000-7000-8000-0000000000e1";
const T0 = "2026-10-30T10:00:00.000Z";
const T1 = "2026-10-30T11:00:00.000Z";
const lid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const pull = (id: string, over: Partial<GithubLink> = {}): GithubLink => ({
  id, issueId: A, kind: "pull", repo: "acme/infra", number: 412, sha: null, title: "Rotate restic keys", state: "open", head: "infra-246-rotate", base: "main",
  review: "required", checks: "run", failing: 0, author: "robin", authorBot: false, at: T0, closing: true, ...over,
});
const event = (over: Partial<GithubEvent> = {}): GithubEvent => ({ verb: "merged", repo: "acme/infra", number: 412, sha: null, title: "Rotate restic keys", state: "merged", by: "atlas", closing: true, at: T1, ...over });
const issueAction = (id: number, mid: string, d: Record<string, unknown>): Action => ({ id, m: "Issue", mid, a: "U", d, by: BOT });

test("an issue's links come with its feed and follow deltas: a checks change, a new link, a removal", async () => {
  const { store, socket } = await openedFeed(A, { github: [pull(lid(1))] });
  assert.deepEqual(store.githubOf(A).map((l) => l.state), ["open"]);
  socket().push({ t: "d", a: [{ id: 11, m: "GithubLink", mid: lid(1), a: "U", d: { issueId: A, checks: "fail", failing: 2 }, by: BOT }] });
  assert.equal(store.githubOf(A)[0]!.checks, "fail");
  assert.equal(store.githubOf(A)[0]!.failing, 2);
  socket().push({ t: "d", a: [{ id: 12, m: "GithubLink", mid: lid(2), a: "I", d: { ...pull(lid(2), { number: 413 }) }, by: BOT }] });
  assert.equal(store.githubOf(A).length, 2);
  socket().push({ t: "d", a: [{ id: 13, m: "GithubLink", mid: lid(1), a: "D", d: { issueId: A }, by: BOT }] });
  assert.deepEqual(store.githubOf(A).map((l) => l.number), [413]);
  store.dispose();
});

test("a link on an issue nobody opened is not kept: the feed brings it when the issue opens", async () => {
  const { store, socket } = await openedFeed(A);
  socket().push({ t: "d", a: [{ id: 11, m: "GithubLink", mid: lid(3), a: "I", d: { ...pull(lid(3), { issueId: B! }) }, by: BOT }, issueAction(12, A!, { priority: 1 })] });
  assert.deepEqual(store.githubOf(B!), []);
  store.dispose();
});

test("a reload drops links the server no longer has", async () => {
  const h = await openedFeed(A, { github: [pull(lid(1)), pull(lid(2), { number: 413 })] });
  h.history.set(A, { s: 40, history: [], comments: [], reactions: [], github: [pull(lid(2), { number: 413, state: "merged" })], doc: null });
  h.serve = (await import("./fake.ts")).snapshot(40);
  h.socket().push({ t: "resync" });
  await until(() => h.store.githubOf(A).length === 1, "reloaded feed");
  assert.equal(h.store.githubOf(A)[0]!.state, "merged");
  h.store.dispose();
});

test("`gh` stays out of the row: a state move by GitHub keeps it in the live feed entry", async () => {
  const { store, socket, feed } = await openedFeed(A);
  const gh = event();
  socket().push({ t: "d", a: [issueAction(11, A!, { stateId: DONE, updatedAt: T1, gh })] });
  assert.deepEqual(feed.history.map((e) => [e.d, e.p, e.gh, e.by]), [[{ stateId: DONE }, { stateId: TODO }, gh, BOT]]);
  const row = store.issuesOf(PROJECT).find((i) => i.id === A)!;
  assert.equal(row.stateId, DONE);
  assert.equal("gh" in row, false);
  store.dispose();
});

test("a GitHub event alone, with no field changed, is an entry too", async () => {
  const { store, socket, feed } = await openedFeed(A);
  const gh = event({ closing: false });
  socket().push({ t: "d", a: [issueAction(11, A!, { gh })] });
  assert.deepEqual(feed.history[0]!.d, {});
  assert.deepEqual(feed.history[0]!.gh, gh);
  store.dispose();
});

test("a live entry takes the action's time, else the event's: a catch-up read does not date an old event now", async () => {
  const { store, socket, feed } = await openedFeed(A);
  socket().push({ t: "d", a: [issueAction(11, A!, { gh: event({ at: T0 }) }), issueAction(12, A!, { stateId: DONE, updatedAt: T1, gh: event({ at: T0 }) })] });
  assert.deepEqual(feed.history.map((e) => e.at), [T0, T1]);
  store.dispose();
});

test("`gh` of an action that arrives while the feed loads waits in the buffer and is entered once, on top of the answer", async () => {
  const h = await online();
  let answer!: (x: IssueHistory) => void;
  h.history.set(A!, new Promise<IssueHistory>((r) => (answer = r)));
  const feed = h.store.feed(A!);
  await until(() => h.requests.some((u) => u.includes("/sync/history/")), "request");
  const gh = event({ at: T0 });
  h.socket().push({ t: "d", a: [issueAction(9, A!, { gh: event({ title: "in the answer" }) }), issueAction(12, A!, { gh })] });
  assert.equal(feed.history.length, 0, "held back");
  answer({ s: 10, history: [{ id: 9, a: "U", by: BOT, at: T0, d: {}, p: {}, gh: event({ title: "in the answer" }) }], comments: [], reactions: [], github: [], doc: null });
  await until(() => feed.status === "ready", "feed");
  assert.deepEqual(feed.history.map((e) => [e.id, e.gh?.title]), [[9, "in the answer"], [12, gh.title]]);
  h.store.dispose();
});

test("an older page has no links: those loaded stay, and one that arrives meanwhile is applied after it", async () => {
  const TOLD = "2026-10-29 09:00:00.123456+00";
  const h = await openedFeed(A, { github: [pull(lid(1))], older: TOLD });
  let answer!: (x: IssueHistory) => void;
  h.history.set(`${A}?until=${encodeURIComponent(TOLD)}`, new Promise<IssueHistory>((r) => (answer = r)));
  h.feed.loadOlder();
  await until(() => h.requests.some((u) => u.includes("until=")), "request");
  h.socket().push({ t: "d", a: [{ id: 11, m: "GithubLink", mid: lid(2), a: "I", d: { ...pull(lid(2), { number: 413 }) }, by: BOT }] });
  assert.equal(h.store.githubOf(A).length, 1, "held back");
  answer({ s: 11, history: [], comments: [], reactions: [], github: [], doc: null, older: null });
  await until(() => !h.feed.loadingOlder, "page");
  assert.deepEqual(h.store.githubOf(A).map((l) => l.number).sort(), [412, 413]);
  h.store.dispose();
});

test("a feed pushed out of memory takes its links with it", async () => {
  const h = await openedFeed(A, { github: [pull(lid(1))] });
  assert.equal(h.store.githubOf(A).length, 1);
  // Fifty more feeds (MAX_FEEDS): issues the server has not heard of answer 404 and load as empty.
  for (let n = 0; n < 50; n++) h.store.feed(`00000000-0000-7000-8000-1${String(n).padStart(11, "0")}`);
  assert.deepEqual(h.store.githubOf(A), []);
  h.store.dispose();
});

test("a project's live history keeps `gh` beside the state it moved; of what moved nothing, a merge is a step at any level and a push only in the full record", async () => {
  const h = await online();
  const page: ProjectHistory = { s: 10, history: [], comments: [] };
  h.projectHistory.set(`project=${PROJECT}&level=outcomes`, page);
  const feed = h.store.projectHistory(PROJECT, "outcomes");
  await until(() => feed.status === "ready", "ready");
  const gh = event();
  const merged = event({ closing: false });
  h.socket().push({ t: "d", a: [issueAction(11, A!, { stateId: DONE, updatedAt: T1, gh }), issueAction(12, A!, { gh: merged }), issueAction(13, A!, { gh: event({ verb: "pushed" }) })] });
  assert.deepEqual(feed.entries.map((e) => [e.id, e.gh]), [
    [11, gh],
    [12, merged],
  ]);
  h.store.dispose();
});
