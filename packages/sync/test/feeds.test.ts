// Issues' activity kept on disk (PLNR-80): opening an issue needs no request while its copy is up to date.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Action, IssueFeeds, IssueHistory, KeptFeed } from "@rsva/protocol";
import type { Comment, GithubLink } from "@rsva/schema/models";
import { harness, ISSUE, ME, online, reopened, snapshot, until, type Harness } from "./fake.ts";

const [A] = ISSUE;
const T0 = "2026-10-30T10:00:00.000Z";
const CID = "00000000-0000-7000-8000-000000000f01";
const LINK = "00000000-0000-7000-8000-000000000f02";
const comment = (id: string, body: string): Comment => ({ id, issueId: A, parentId: null, authorId: ME, body, createdAt: T0, editedAt: null, deletedAt: null, via: null });
const kept = (id: string, s: number, over: Partial<IssueHistory> = {}): KeptFeed => ({ id, s, history: [], comments: [], reactions: [], github: [], doc: null, ...over });
const said = (id: number, row: Comment): Action => ({ id, m: "Comment", mid: row.id, a: "I", d: { ...row }, by: ME });
const historyRequests = (h: Harness) => h.requests.filter((u) => u.includes("/sync/history/")).length;

const answer = (s: number, ...feeds: KeptFeed[]) => (): IssueFeeds => ({ s, feeds });
/** Time for an answer to reach IndexedDB. */
const settle = () => new Promise((r) => setTimeout(r, 15));

/** This store's first fill is on disk and over. The "rsva:feeds" mark would not do: it is one for the whole process. */
const fillOver = (h: Harness) => {
  const { feeds } = h.store as unknown as { feeds: { kept: boolean; filling: boolean } };
  return feeds.kept && !feeds.filling;
};

/** A store whose first fill has run: `feeds` are on disk, cut at 10. A reconnect (`hello`) brings the next fill. */
async function filled(...feeds: KeptFeed[]) {
  const h = harness({ fillDelay: 0 });
  h.feeds = answer(10, ...feeds);
  await h.store.start();
  h.socket().hello();
  h.socket().push({ t: "caught-up" });
  await until(() => fillOver(h), "fill");
  await h.store.persist();
  return h;
}

test("after the first fill an issue opens from disk: no request", async () => {
  const h = await filled(kept(A, 10, { comments: [comment(CID, "kept")] }));
  const feed = h.store.feed(A);
  assert.equal(feed.status, "loading");
  await until(() => feed.status === "ready", "feed");
  assert.deepEqual(feed.threads.map((t) => t.comment.body), ["kept"]);
  assert.equal(historyRequests(h), 0);
  h.store.dispose();
});

test("the first fill asks for everything, the next ones only for what changed", async () => {
  const h = await filled(kept(A, 10));
  assert.deepEqual(h.fills, [undefined]);
  h.feeds = answer(11, kept(A, 11, { comments: [comment(CID, "new")] }));
  h.socket().push({ t: "d", a: [said(11, comment(CID, "new"))] });
  h.socket().hello();
  await until(() => h.fills.length === 2, "second fill");
  assert.deepEqual(h.fills[1], [A]);
  await until(() => fillOver(h), "second fill on disk");
  h.socket().hello();
  await settle();
  assert.equal(h.fills.length, 2, "nothing changed since: no request");
  const feed = h.store.feed(A);
  await until(() => feed.status === "ready", "feed");
  assert.deepEqual(feed.threads.map((t) => t.comment.body), ["new"]);
  assert.equal(historyRequests(h), 0);
  h.store.dispose();
});

test("a copy brings the issue's GitHub links, and a change to a link makes it stale", async () => {
  const link: GithubLink = {
    id: LINK, issueId: A, kind: "pull", repo: "acme/planner", number: 7, sha: null, title: "Open faster", state: "open", head: "plnr-80", base: "main", review: "required", checks: "run", failing: 0,
    author: "robin", authorBot: false, at: T0, closing: true,
  };
  const h = await filled(kept(A, 10, { github: [link] }));
  const feed = h.store.feed(A);
  await until(() => feed.status === "ready", "feed");
  assert.deepEqual(h.store.githubOf(A).map((l) => l.number), [7]);
  assert.equal(historyRequests(h), 0);
  h.socket().push({ t: "d", a: [{ id: 11, m: "GithubLink", mid: LINK, a: "U", d: { issueId: A, checks: "pass" }, by: ME }] });
  assert.equal(h.store.githubOf(A)[0]!.checks, "pass");
  const again = await reopened(h);
  again.history.set(A, { s: 11, history: [], comments: [], reactions: [], github: [{ ...link, checks: "pass" }], doc: null });
  const copy = again.store.feed(A);
  await until(() => historyRequests(again) === 1, "the stale copy is read again");
  await until(() => copy.status === "ready" && again.store.githubOf(A)[0]?.checks === "pass", "fresh link");
  again.store.dispose();
});

test("before the catch-up a copy shows and is read-only: only `caught-up` vouches for it, with no request", async () => {
  const h = await filled(kept(A, 10, { comments: [comment(CID, "kept")] }));
  const again = await reopened(h);
  const feed = again.store.feed(A);
  await until(() => feed.status === "ready", "feed");
  assert.equal(feed.behind, true, "offline, or on the way: someone may have saved a description meanwhile");
  assert.deepEqual(feed.threads.map((t) => t.comment.body), ["kept"]);
  again.socket().hello();
  await until(() => again.socket().frames("sub").length > 0, "sub");
  assert.equal(feed.behind, true, "subscribed is not caught up");
  again.socket().push({ t: "caught-up" });
  assert.equal(feed.behind, false);
  assert.equal(historyRequests(again), 0);
  again.store.dispose();
});

test("what the catch-up brought makes the copy stale, and it is read again before it can be edited", async () => {
  const h = await filled(kept(A, 10, { doc: { id: A, doc: { type: "doc", content: [] }, updatedAt: T0 } }));
  const again = await reopened(h);
  const feed = again.store.feed(A);
  await until(() => feed.status === "ready", "feed");
  again.history.set(A, { s: 11, history: [], comments: [], reactions: [], github: [], doc: null });
  again.socket().hello();
  await until(() => again.socket().frames("sub").length > 0, "sub");
  again.socket().push({ t: "d", a: [{ id: 11, m: "Document", mid: A, a: "U", d: { issueId: A, doc: { type: "doc", content: [] }, updatedAt: T0 }, by: ME }] });
  again.socket().push({ t: "caught-up" });
  assert.equal(feed.behind, true);
  await until(() => historyRequests(again) === 1, "the reload");
  await until(() => !feed.behind, "fresh");
  again.store.dispose();
});

test("a gap in the log takes the vouching back until the new `sub` is answered", async () => {
  const h = await filled(kept(A, 10));
  h.socket().push({ t: "d", a: [said(20, comment(CID, "past a gap"))] });
  const feed = h.store.feed(A);
  await until(() => feed.status === "ready", "feed");
  assert.equal(feed.behind, true);
  assert.equal(h.socket().frames("sub").length, 2);
  h.socket().push({ t: "caught-up" });
  assert.equal(feed.behind, false);
  h.store.dispose();
});

test("while a resync loads its snapshot deltas are dropped, so a copy opened then is not vouched for", async () => {
  const h = await filled(kept(A, 10));
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  h.feeds = answer(50, kept(A, 50));
  const http = (h.store as unknown as { http: (u: string, i: unknown) => Promise<unknown> }).http;
  (h.store as unknown as { http: typeof http }).http = async (u, i) => {
    if (u.includes("/sync/bootstrap")) await held;
    return http(u, i);
  };
  h.serve = snapshot(50);
  h.socket().push({ t: "resync" });
  await settle();
  const feed = h.store.feed(A);
  await until(() => feed.status === "ready", "feed");
  assert.equal(feed.behind, true);
  release();
  h.store.dispose();
});

test("a reload that fails after `caught-up` is tried again with no render asking", async () => {
  const h = await filled(kept(A, 10, { comments: [comment(CID, "old")] }));
  const again = await reopened(h);
  again.socket().hello();
  await until(() => again.socket().frames("sub").length > 0, "sub");
  again.socket().push({ t: "d", a: [said(11, comment(CID, "old"))] });
  let fail = () => {};
  again.history.set(A, new Promise((_, no) => (fail = () => no(new Error("down")))));
  const feed = again.store.feed(A);
  await until(() => historyRequests(again) === 1, "reload on its way");
  again.socket().push({ t: "caught-up" });
  again.history.set(A, { s: 11, history: [], comments: [comment(CID, "fresh")], reactions: [], github: [], doc: null });
  fail();
  await new Promise((r) => setTimeout(r, 5100));
  await until(() => !feed.behind, "the second try");
  assert.equal(historyRequests(again), 2);
  again.store.dispose();
});

test("a lost connection does not take an open description away", async () => {
  const h = await filled(kept(A, 10));
  const feed = h.store.feed(A);
  await until(() => feed.status === "ready", "feed");
  assert.equal(feed.behind, false);
  h.socket().closeBy(1006);
  assert.equal(feed.behind, false);
  h.store.dispose();
});

for (const [name, action] of [
  ["a reaction", { id: 11, m: "Reaction", mid: CID, a: "I", d: { id: CID, issueId: A, commentId: null, emoji: "+1", userId: ME, createdAt: T0 }, by: ME }],
  ["a removed reaction", { id: 11, m: "Reaction", mid: CID, a: "D", d: { issueId: A }, by: ME }],
  ["an edited comment", { id: 11, m: "Comment", mid: CID, a: "U", d: { issueId: A, body: "edited" }, by: ME }],
  ["a description", { id: 11, m: "Document", mid: A, a: "U", d: { issueId: A, updatedAt: T0 }, by: ME }],
] as [string, Action][]) {
  test(`${name} makes the copy stale`, async () => {
    const h = await filled(kept(A, 10));
    h.socket().push({ t: "d", a: [action] });
    h.history.set(A, { s: 11, history: [], comments: [], reactions: [], github: [], doc: null });
    const feed = h.store.feed(A);
    await until(() => historyRequests(h) === 1, "read again");
    await until(() => !feed.behind && feed.status === "ready", "fresh");
    h.store.dispose();
  });
}

test("a copy behind a delta shows at once and is read again", async () => {
  const h = await filled(kept(A, 10, { comments: [comment(CID, "old")] }));
  h.socket().push({ t: "d", a: [said(11, comment(CID, "old"))] });
  h.history.set(A, { s: 11, history: [], comments: [comment(CID, "fresh")], reactions: [], github: [], doc: null });
  const before = historyRequests(h);
  const feed = h.store.feed(A);
  await until(() => feed.status === "ready", "feed");
  await until(() => historyRequests(h) === before + 1, "reload");
  await until(() => feed.threads[0]?.comment.body === "fresh", "fresh comment");
  h.store.dispose();
});

const reloaded = async (h: Harness) => {
  const again = await reopened(h);
  again.history.set(A, { s: 11, history: [], comments: [comment(CID, "fresh")], reactions: [], github: [], doc: null });
  return again;
};
const showsFresh = async (h: Harness) => {
  const feed = h.store.feed(A);
  await until(() => feed.threads[0]?.comment.body === "fresh", "fresh comment");
  h.store.dispose();
};

test("what changed while the tab was closed is known from the catch-up", async () => {
  const again = await reloaded(await filled(kept(A, 10, { comments: [comment(CID, "old")] })));
  again.socket().hello();
  await until(() => again.socket().frames("sub").length > 0, "sub");
  assert.equal(again.socket().frames("sub")[0]!.s, 10);
  again.socket().push({ t: "d", a: [said(11, comment(CID, "old"))] });
  await showsFresh(again);
});

test("a stale mark survives a reload: an issue changed in the last session is read again", async () => {
  const h = await filled(kept(A, 10, { comments: [comment(CID, "old")] }));
  h.socket().push({ t: "d", a: [said(11, comment(CID, "old"))] });
  await showsFresh(await reloaded(h));
});

test("a delta that lands during the read of IndexedDB is not lost", async () => {
  const h = await filled(kept(A, 10));
  const feed = h.store.feed(A);
  await Promise.resolve();
  h.socket().push({ t: "d", a: [said(11, comment(CID, "live"))] });
  h.history.set(A, { s: 11, history: [], comments: [comment(CID, "live")], reactions: [], github: [], doc: null });
  await until(() => feed.status === "ready", "feed");
  assert.deepEqual(feed.threads.map((t) => t.comment.body), ["live"]);
  h.store.dispose();
});

test("an opened issue's answer is kept: closing and opening it again sends nothing", async () => {
  const h = await filled();
  h.history.set(A, { s: 10, history: [], comments: [comment(CID, "read")], reactions: [], github: [], doc: null });
  const feed = h.store.feed(A);
  await until(() => feed.status === "ready", "feed");
  const again = await reopened(h);
  const before = historyRequests(again);
  const same = again.store.feed(A);
  await until(() => same.status === "ready", "feed");
  assert.deepEqual(same.threads.map((t) => t.comment.body), ["read"]);
  assert.equal(historyRequests(again), before);
  again.store.dispose();
});

test("an issue the fill does not return loses its copy and loads when opened", async () => {
  const h = await filled(kept(A, 10, { comments: [comment(CID, "old")] }));
  h.socket().push({ t: "d", a: [said(11, comment(CID, "old"))] });
  h.feeds = answer(11);
  h.socket().hello();
  await until(() => h.fills.length === 2, "fill");
  await until(() => fillOver(h), "fill on disk");
  h.history.set(A, { s: 11, history: [], comments: [], reactions: [], github: [], doc: null });
  const feed = h.store.feed(A);
  await until(() => feed.status === "ready", "feed");
  assert.equal(feed.threads.length, 0);
  assert.equal(historyRequests(h), 1);
  h.store.dispose();
});

test("a new snapshot vouches for nothing on disk: everything is fetched again", async () => {
  const h = await filled(kept(A, 10, { comments: [comment(CID, "old")] }));
  h.serve = snapshot(50);
  h.feeds = answer(50, kept(A, 50));
  const n = h.fills.length;
  h.socket().push({ t: "resync" });
  await until(() => h.fills.length > n, "fill after resync");
  assert.equal(h.fills.at(-1), undefined);
  h.store.dispose();
});

test("a fill overtaken by a new snapshot vouches for nothing, and a new one follows", async () => {
  const h = await filled(kept(A, 10, { comments: [comment(CID, "old")] }));
  let release = (_: IssueFeeds) => {};
  h.socket().push({ t: "d", a: [said(11, comment(CID, "old"))] });
  h.feeds = () => new Promise((r) => (release = r));
  h.socket().hello();
  await until(() => h.fills.length === 2, "fill on its way");
  h.serve = snapshot(50);
  h.socket().push({ t: "resync" });
  await until(() => h.requests.filter((u) => u.includes("/sync/bootstrap")).length === 2, "snapshot");
  h.feeds = answer(50, kept(A, 50, { comments: [comment(CID, "after")] }));
  await settle();
  h.history.set(A, { s: 50, history: [], comments: [comment(CID, "server")], reactions: [], github: [], doc: null });
  release({ s: 11, feeds: [kept(A, 11, { comments: [comment(CID, "before")] })] });
  await until(() => h.fills.length === 3, "the fill after the snapshot");
  assert.equal(h.fills[2], undefined, "all of it");
  await until(() => fillOver(h), "the fill after the snapshot on disk");
  const feed = h.store.feed(A);
  await until(() => feed.status === "ready", "feed");
  assert.deepEqual(feed.threads.map((t) => t.comment.body), ["after"]);
  h.store.dispose();
});

test("a first fill that lands late does not put an older copy over an opened issue's", async () => {
  const h = harness({ fillDelay: 0 });
  let release = (_: IssueFeeds) => {};
  h.feeds = () => new Promise((r) => (release = r));
  await h.store.start();
  h.socket().hello();
  await until(() => h.fills.length === 1, "fill on its way");
  h.socket().push({ t: "d", a: [said(11, comment(CID, "new"))] });
  h.history.set(A, { s: 11, history: [], comments: [comment(CID, "new")], reactions: [], github: [], doc: null });
  const feed = h.store.feed(A);
  await until(() => feed.status === "ready", "feed");
  await settle();
  release({ s: 10, feeds: [kept(A, 10, { comments: [comment(CID, "old")] })] });
  await until(() => fillOver(h), "the late fill on disk");
  const again = await reopened(h);
  const same = again.store.feed(A);
  await until(() => same.status === "ready", "feed");
  assert.deepEqual(same.threads.map((t) => t.comment.body), ["new"]);
  again.store.dispose();
});

const down = { then: (_: unknown, no: (e: Error) => void) => no(new Error("down")) } as unknown as Promise<IssueHistory>;

test("a copy behind stays read-only and live when its reload fails, and is read again on the next connection", async () => {
  const h = await filled(kept(A, 10, { comments: [comment(CID, "old")] }));
  h.socket().push({ t: "d", a: [said(11, comment(CID, "old"))] });
  h.history.set(A, down);
  const feed = h.store.feed(A);
  await until(() => historyRequests(h) === 1, "failed reload");
  await settle();
  assert.equal(feed.status, "ready");
  assert.equal(feed.behind, true);
  const second = "00000000-0000-7000-8000-000000000f02";
  h.socket().push({ t: "d", a: [said(12, comment(second, "still live"))] });
  assert.deepEqual(feed.threads.map((t) => t.comment.body), ["old", "still live"]);
  h.history.set(A, { s: 12, history: [], comments: [comment(CID, "fresh")], reactions: [], github: [], doc: null });
  h.socket().hello();
  h.socket().push({ t: "caught-up" });
  await until(() => feed.threads[0]?.comment.body === "fresh", "reload");
  assert.equal(feed.behind, false);
  h.store.dispose();
});

test("a delta during a failed reload is not lost", async () => {
  const h = await filled(kept(A, 10, { comments: [comment(CID, "old")] }));
  h.socket().push({ t: "d", a: [said(11, comment(CID, "old"))] });
  let fail = () => {};
  h.history.set(A, new Promise((_, no) => (fail = () => no(new Error("down")))));
  const feed = h.store.feed(A);
  await until(() => historyRequests(h) === 1, "reload on its way");
  const second = "00000000-0000-7000-8000-000000000f02";
  h.socket().push({ t: "d", a: [said(12, comment(second, "meanwhile"))] });
  fail();
  await until(() => feed.threads.length === 2, "the delta");
  assert.equal(feed.threads[1]!.comment.body, "meanwhile");
  h.store.dispose();
});

test("a lost IndexedDB connection falls back to the server", async () => {
  const h = await filled(kept(A, 10));
  (h.store as unknown as { db: IDBDatabase }).db.close();
  h.history.set(A, { s: 10, history: [], comments: [comment(CID, "server")], reactions: [], github: [], doc: null });
  const feed = h.store.feed(A);
  await until(() => feed.status === "ready", "feed");
  assert.deepEqual(feed.threads.map((t) => t.comment.body), ["server"]);
  h.store.dispose();
});

test("before the first fill an issue opens from the server, as it always did", async () => {
  const h = await online();
  h.history.set(A, { s: 10, history: [], comments: [comment(CID, "x")], reactions: [], github: [], doc: null });
  const feed = h.store.feed(A);
  await until(() => feed.status === "ready", "feed");
  assert.equal(historyRequests(h), 1);
  assert.equal(h.fills.length, 0);
  h.store.dispose();
});

test("without storage nothing is fetched to keep", async () => {
  const h = harness({ indexedDB: null, fillDelay: 0 });
  await h.store.start();
  h.socket().hello();
  await settle();
  assert.equal(h.fills.length, 0);
  h.store.dispose();
});
