// Compressed snapshots, reused while the log does not move. Key: workspace + open project (resolved to a real project);
// an entry is valid for one lastSyncId. The first request at a new number builds the snapshot and sends brotli 5 at once; brotli 11 (16-18 %
// smaller, 75-120x slower: 130 ms for our workspace, 3.4 s for 10,000 issues) then runs in the libuv thread pool and
// replaces the entry, so later requests get the smaller body without paying for it. docs/research/snapshot-2026-10-27.md.
import { promisify } from "node:util";
import { brotliCompress, constants } from "node:zlib";
import type { SnapshotLine } from "@rsva/protocol";
import { and, eq } from "drizzle-orm";
import { db, projectKeyIs, schema } from "../db.ts";
import { snapshot } from "./bootstrap.ts";

const brotli = promisify(brotliCompress);
const params = (quality: number, size: number) => ({ params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: size } });

interface Entry {
  s: number;
  body: Buffer;
  quality: 5 | 11;
}

/**
 * Per workspace, entries for its newest lastSyncId only: one per real project opened first, plus "" for none. A newer
 * number drops the older entries, and an unknown project key is the same as no key, so a workspace holds at most
 * (projects + 1) entries and request parameters cannot add more. Workspaces themselves are capped, oldest out.
 */
interface WorkspaceEntries {
  s: number;
  byProject: Map<string, Entry>;
}
const MAX_WORKSPACES = 16;
const cache = new Map<string, WorkspaceEntries>();

/** brotli 11 jobs in flight across all keys; beyond this the brotli 5 body stays (it is valid, just bigger). */
export const MAX_UPGRADES = 2;
const upgrading = new Set<string>();

/**
 * Builds in flight per workspace and open project, with the number they started at: a burst of requests at one number
 * (many tabs after a restart, or a member flooding the route) reads the workspace once, not once each.
 */
const building = new Map<string, { s: number; entry: Promise<Entry> }>();

export const snapshotCacheStats = { hits: 0, builds: 0, upgrades: 0, skippedUpgrades: 0, maxInFlight: 0 };

/**
 * The snapshot as brotli NDJSON for the workspace's current lastSyncId. Throws 404 for an unknown workspace. Requests
 * without brotli are served from it too, decompressed (app.ts).
 */
export async function brotliSnapshot(slug: string, projectKey: string | undefined): Promise<Entry> {
  const { workspace, project } = schema;
  const [ws] = await db
    .select({ id: workspace.id, s: workspace.lastSyncId, projectId: project.id })
    .from(workspace)
    .leftJoin(project, and(eq(project.workspaceId, workspace.id), projectKeyIs(projectKey ?? "")))
    .where(eq(workspace.slug, slug));
  if (!ws) throw Object.assign(new Error(`no workspace ${slug}`), { statusCode: 404 });
  const projectId = ws.projectId ?? "";
  const hit = cache.get(ws.id);
  const entry = hit?.s === ws.s ? hit.byProject.get(projectId) : undefined;
  if (entry) {
    snapshotCacheStats.hits++;
    return entry;
  }
  // A miss while the same snapshot is being built at this number or a newer one waits for that build (RSVA-608).
  const job = `${ws.id}\n${projectId}`;
  const running = building.get(job);
  if (running && running.s >= ws.s) return running.entry;
  const built = build(ws.id, projectId, job, slug, ws.projectId ? projectKey : undefined);
  building.set(job, { s: ws.s, entry: built });
  const done = () => void (building.get(job)?.entry === built && building.delete(job));
  built.then(done, done);
  return built;
}

async function build(workspaceId: string, projectId: string, job: string, slug: string, projectKey: string | undefined): Promise<Entry> {
  const lines: SnapshotLine[] = [];
  for await (const l of snapshot(slug, projectKey)) lines.push(l);
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  // The snapshot's own cut: a write between brotliSnapshot's lookup and the read is included, so the entry is keyed by it.
  const s = (lines[0] as Extract<SnapshotLine, { t: "meta" }>).s;
  const built: Entry = { s, body: await brotli(text, params(5, text.length)), quality: 5 };
  snapshotCacheStats.builds++;
  put(workspaceId, projectId, built);

  if (upgrading.has(job) || upgrading.size >= MAX_UPGRADES) {
    snapshotCacheStats.skippedUpgrades++;
    return built;
  }
  upgrading.add(job);
  snapshotCacheStats.maxInFlight = Math.max(snapshotCacheStats.maxInFlight, upgrading.size);
  void brotli(text, params(11, text.length))
    .then((body) => {
      if (put(workspaceId, projectId, { s, body, quality: 11 })) snapshotCacheStats.upgrades++;
    })
    .catch((e: unknown) => console.error("snapshot cache: brotli 11 failed", e))
    .finally(() => upgrading.delete(job));
  return built;
}

/** Stores the entry unless the workspace already has a newer number; true if stored. */
function put(workspaceId: string, projectId: string, entry: Entry): boolean {
  let w = cache.get(workspaceId);
  if (w && w.s > entry.s) return false;
  if (!w || w.s < entry.s) w = { s: entry.s, byProject: new Map() };
  cache.delete(workspaceId);
  cache.set(workspaceId, w);
  if (cache.size > MAX_WORKSPACES) cache.delete(cache.keys().next().value!);
  w.byProject.set(projectId, entry);
  return true;
}

/** Number of cached bodies (tests, metrics). */
export function cachedEntries(): number {
  let n = 0;
  for (const w of cache.values()) n += w.byProject.size;
  return n;
}

/** Waits until background compressions finish (tests). */
export async function settled(): Promise<void> {
  while (upgrading.size) await new Promise((r) => setTimeout(r, 5));
}
