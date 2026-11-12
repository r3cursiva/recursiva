import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, test } from "node:test";
import { brotliDecompressSync } from "node:zlib";
import { importFixture, issueWithRefs, lastSyncId, type Fixture } from "../test/helpers.ts";
import { snapshot } from "./bootstrap.ts";
import { brotliSnapshot, cachedEntries, MAX_UPGRADES, settled, snapshotCacheStats } from "./snapshot-cache.ts";
import { applyTx } from "./write.ts";

let ws: Fixture;
before(async () => (ws = await importFixture()));

async function plain(project: string): Promise<string> {
  const lines = [];
  for await (const l of snapshot(ws.slug, project)) lines.push(JSON.stringify(l));
  return lines.join("\n") + "\n";
}

test("served from cache at the same number, upgraded to brotli 11 in the background, rebuilt after a write", async (t) => {
  const { issue } = await issueWithRefs(ws.workspaceId, "CORE");
  const first = await brotliSnapshot(ws.slug, "CORE");
  assert.equal(first.quality, 5);
  assert.equal(brotliDecompressSync(first.body).toString(), await plain("CORE"));

  await settled();
  const hits = snapshotCacheStats.hits;
  const second = await brotliSnapshot(ws.slug, "CORE");
  assert.equal(snapshotCacheStats.hits, hits + 1);
  assert.equal(second.quality, 11);
  assert.ok(second.body.length < first.body.length * 0.9, `brotli 11 ${second.body.length} B vs brotli 5 ${first.body.length} B`);
  assert.equal(brotliDecompressSync(second.body).toString(), await plain("CORE"));
  t.diagnostic(`sample snapshot: brotli 5 ${first.body.length} B, brotli 11 ${second.body.length} B`);

  // Another open project is another entry.
  assert.notEqual(brotliDecompressSync((await brotliSnapshot(ws.slug, "WEB")).body).toString(), brotliDecompressSync(second.body).toString());

  await applyTx(ws.workspaceId, ws.ownerId, randomUUID(), [{ op: "update", m: "Issue", id: issue.id, set: { title: `cache ${randomUUID()}` } }]);
  const third = await brotliSnapshot(ws.slug, "CORE");
  assert.equal(third.s, await lastSyncId(ws.workspaceId));
  assert.equal(brotliDecompressSync(third.body).toString(), await plain("CORE"));
  await settled();
});

test("bogus project keys neither grow the cache nor start more brotli 11 jobs", async () => {
  await settled();
  const plainNone = await plain("");
  const before = cachedEntries();
  const bodies = await Promise.all(Array.from({ length: 200 }, (_, i) => brotliSnapshot(ws.slug, `NOPE${i}`)));
  // An unknown key is no key: one entry for the workspace, the same body as without a project.
  assert.ok(cachedEntries() <= before + 1, `${cachedEntries()} entries`);
  for (const b of bodies) assert.equal(brotliDecompressSync(b.body).toString(), plainNone);
  assert.ok(snapshotCacheStats.maxInFlight <= MAX_UPGRADES, `${snapshotCacheStats.maxInFlight} upgrades at once`);
  await settled();
});

test("concurrent misses across workspaces run at most MAX_UPGRADES brotli 11 jobs", async () => {
  await settled();
  const others = await Promise.all([1, 2, 3, 4].map((seed) => importFixture("sample", undefined, seed + 20)));
  await Promise.all(others.map((o) => brotliSnapshot(o.slug, "CORE")));
  assert.ok(snapshotCacheStats.skippedUpgrades > 0);
  assert.ok(snapshotCacheStats.maxInFlight <= MAX_UPGRADES);
  await settled();
});

test("a write drops the workspace's older entries", async () => {
  await brotliSnapshot(ws.slug, "CORE");
  await brotliSnapshot(ws.slug, "WEB");
  const { issue } = await issueWithRefs(ws.workspaceId, "CORE");
  const n = cachedEntries();
  await applyTx(ws.workspaceId, ws.ownerId, randomUUID(), [{ op: "update", m: "Issue", id: issue.id, set: { title: `drop ${randomUUID()}` } }]);
  await brotliSnapshot(ws.slug, "CORE");
  assert.ok(cachedEntries() < n, `${cachedEntries()} entries, was ${n}`);
  await settled();
});

test("concurrent misses of one snapshot build it once: a burst of requests is one read of the workspace", async () => {
  await settled();
  const { issue } = await issueWithRefs(ws.workspaceId, "CORE");
  await applyTx(ws.workspaceId, ws.ownerId, randomUUID(), [{ op: "update", m: "Issue", id: issue.id, set: { title: `burst ${randomUUID()}` } }]);
  const builds = snapshotCacheStats.builds;
  const bodies = await Promise.all(Array.from({ length: 20 }, () => brotliSnapshot(ws.slug, "CORE")));
  assert.equal(snapshotCacheStats.builds, builds + 1);
  for (const b of bodies) assert.equal(b, bodies[0]);
  await settled();
});

test("an unknown workspace is a 404", async () => {
  await assert.rejects(brotliSnapshot("no-such-workspace", undefined), (e: { statusCode?: number }) => e.statusCode === 404);
});
