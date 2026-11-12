import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { IssueFeeds, IssueHistory, Op } from "@rsva/protocol";
import { eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { addMember, asUser, fetchAs, importFixture, lastSyncId, serverWithIssue } from "../test/helpers.ts";
import { applyTx } from "./write.ts";

const { server, ws, refs, owner } = await serverWithIssue();
after(() => server.close());

const tx = (ops: Op[]) => applyTx(ws.workspaceId, ws.ownerId, randomUUID(), ops);
const say = (issueId: string, body: string): Op => ({ op: "create", m: "Comment", id: randomUUID(), set: { issueId, body } });
const post = (as: typeof owner, body: unknown, slug = ws.slug) =>
  as(`${server.url}/sync/feeds?ws=${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const feeds = async (body: unknown = {}) => {
  const r = await post(owner, body);
  assert.equal(r.status, 200);
  return (await r.json()) as IssueFeeds;
};

test("a feed in the answer is what the issue's own history answers", async () => {
  await tx([say(refs.issue.id, "a comment"), { op: "update", m: "Issue", id: refs.issue.id, set: { priority: 2 } }]);
  await db.insert(schema.githubInstallation).values({ id: 880, account: "acme", accountType: "Organization", installedBy: "robin" });
  await db.insert(schema.githubRepo).values({ id: 881, fullName: "acme/planner", installationId: 880, workspaceId: ws.workspaceId, defaultBranch: "main" });
  await db.insert(schema.githubLink).values({ workspaceId: ws.workspaceId, issueId: refs.issue.id, repoId: 881, sha: "a".repeat(40), message: "Open faster", author: "robin", at: "2026-10-30T10:00:00.000Z", closing: true });
  const { s, feeds: all } = await feeds();
  assert.equal(s, await lastSyncId(ws.workspaceId));
  const { id, ...feed } = all.find((f) => f.id === refs.issue.id)!;
  const single = (await (await owner(`${server.url}/sync/history/${id}`)).json()) as IssueHistory;
  assert.deepEqual({ ...feed, older: null }, single);
  assert.ok(feed.comments.length > 0 && feed.history.length > 0 && feed.github.length === 1);
});

test("ids narrow the answer to the workspace's own issues", async () => {
  const other = await importFixture();
  const { feeds: named } = await feeds({ ids: [refs.issue.id, randomUUID()] });
  assert.deepEqual(named.map((f) => f.id), [refs.issue.id]);
  const theirs = await asUser(other.ownerId);
  const r = await post(fetchAs(theirs), { ids: [refs.issue.id] }, other.slug);
  assert.deepEqual(((await r.json()) as IssueFeeds).feeds, [], "an issue of another workspace");
});

test("a long issue stays out of the answer and loads when opened", async () => {
  for (let i = 0; i < 5; i++) await tx([say(refs.issue.id, "x".repeat(60_000))]);
  const { feeds: named } = await feeds({ ids: [refs.issue.id] });
  assert.deepEqual(named, []);
});

test("a deleted issue stays out of the answer", async () => {
  const rows = await db.select({ id: schema.issue.id }).from(schema.issue).where(eq(schema.issue.workspaceId, ws.workspaceId)).limit(2);
  const id = rows.find((r) => r.id !== refs.issue.id)!.id;
  await tx([{ op: "update", m: "Issue", id, set: { deletedAt: new Date().toISOString() } }]);
  assert.deepEqual((await feeds({ ids: [id] })).feeds, []);
  await tx([{ op: "update", m: "Issue", id, set: { deletedAt: null } }]);
  assert.deepEqual((await feeds({ ids: [id] })).feeds.map((f) => f.id), [id]);
});

test("ids must be issue ids, and only so many", async () => {
  assert.equal((await post(owner, { ids: "x" })).status, 400);
  assert.equal((await post(owner, { ids: ["x"] })).status, 400);
  assert.equal((await post(owner, { ids: Array.from({ length: 501 }, () => randomUUID()) })).status, 400);
});

test("no feeds for those outside the workspace or not signed in", async () => {
  const stranger = await addMember((await importFixture()).workspaceId, "member");
  assert.equal((await post(fetchAs(await asUser(stranger.id)), {})).status, 404);
  assert.equal((await post(fetch, {})).status, 401);
});
