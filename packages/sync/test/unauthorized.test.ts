// What each request does with a 401 (RSVA-423): the reads of activity stop the engine as an ended session, the snapshot
// stops it with the status it got, and a fill of the activity to keep only fails, for the next fill to try again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, ISSUE, online, openedFeed, PROJECT, until, type Harness } from "./fake.ts";

const [A] = ISSUE;
const ENDED = "the session has ended";

/** From now on requests whose URL has `part` are answered 401; how many were is counted. */
function refuse(h: Harness, part: string): { count: number } {
  const store = h.store as unknown as { http: (u: string, i?: RequestInit) => Promise<Response> };
  const http = store.http;
  const refused = { count: 0 };
  store.http = async (u, i) => {
    if (!u.includes(part)) return http(u, i);
    refused.count++;
    return new Response(null, { status: 401 });
  };
  return refused;
}

test("a 401 on the snapshot stops the engine with the status as its message", async () => {
  const h = harness();
  h.refuse = 401;
  await h.store.start();
  assert.equal(h.store.errorCode, "unauthorized");
  assert.equal(h.store.error, "HTTP 401");
  h.store.dispose();
});

test("a 401 on an issue's history stops the engine: the session has ended", async () => {
  const h = await online();
  refuse(h, "/sync/history/");
  h.store.feed(A);
  await until(() => h.store.errorCode !== null, "stopped");
  assert.equal(h.store.errorCode, "unauthorized");
  assert.equal(h.store.error, ENDED);
  assert.equal(h.store.connection, "offline");
  h.store.dispose();
});

test("a 401 on an older page of activity stops the engine, and the feed stops waiting for the page", async () => {
  const h = await openedFeed(A, { older: "2026-10-01T00:00:00.000Z" });
  refuse(h, "?until=");
  h.feed.loadOlder();
  await until(() => h.store.errorCode !== null, "stopped");
  assert.equal(h.store.error, ENDED);
  await until(() => !h.feed.loadingOlder, "page given up");
  assert.equal((h.feed as unknown as { buffer: unknown }).buffer, null, "the deltas held for the page are let go");
  h.store.dispose();
});

test("a 401 on a project's history stops the engine: the session has ended", async () => {
  const h = await online();
  refuse(h, "/sync/project-history");
  h.store.projectHistory(PROJECT, "outcomes");
  await until(() => h.store.errorCode !== null, "stopped");
  assert.equal(h.store.errorCode, "unauthorized");
  assert.equal(h.store.error, ENDED);
  h.store.dispose();
});

test("a 401 on the fill of activity to keep does not stop the engine", async () => {
  const h = harness({ fillDelay: 0 });
  h.feeds = () => ({ s: 10, feeds: [] });
  const refused = refuse(h, "/sync/feeds");
  await h.store.start();
  h.socket().hello();
  h.socket().push({ t: "caught-up" });
  await until(() => refused.count > 0, "fill");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.store.errorCode, null);
  assert.equal(h.store.connection, "online");
  h.store.dispose();
});
