// The sync engine's copy on this Mac (PLNR-306, owner's decision 2026-11-05): a folder per workspace under
// ~/Library/Caches/rsva, the same copy a browser keeps in IndexedDB. Files are 0600 in folders of 0700: the copy is the
// workspace in the clear, for this user only. Values go through node:v8's serialize, the structured clone IndexedDB
// uses, so Maps and Dates come back as they went in. A write goes to a temporary file renamed over the old one: a crash
// leaves the old copy or the new, never half of one.
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import type { KeptFeed } from "@rsva/protocol";
import type { Disk, Disks } from "@rsva/sync";

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
/** A name as one path segment: ids are UUIDs, but nothing from the server becomes a path unchecked. */
const segment = (name: string) => encodeURIComponent(name).replaceAll(".", "%2E");

let writes = 0;

async function read<T>(file: string): Promise<T | undefined> {
  try {
    return deserialize(await readFile(file)) as T;
  } catch (e) {
    if (missing(e)) return undefined;
    throw e;
  }
}

async function write(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${++writes}.tmp`;
  await writeFile(tmp, serialize(value), { mode: 0o600 });
  await rename(tmp, file);
}

async function remove(file: string): Promise<void> {
  await unlink(file).catch((e: unknown) => (missing(e) ? undefined : Promise.reject(e)));
}

/** The values of a folder's files, by name without the extension. */
async function all<T>(dir: string): Promise<Map<string, T>> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".bin"));
  const values = await Promise.all(names.map((n) => read<T>(join(dir, n))));
  return new Map(names.flatMap((n, i) => (values[i] === undefined ? [] : [[decodeURIComponent(n.slice(0, -4)), values[i]!]])));
}

export function fileDisks(root: string): Disks {
  const folder = (name: string) => join(root, segment(name));
  return {
    async open(name) {
      const dir = folder(name);
      const tx = join(dir, "tx");
      const feeds = join(dir, "feeds");
      await Promise.all([mkdir(tx, { recursive: true, mode: 0o700 }), mkdir(feeds, { recursive: true, mode: 0o700 })]);
      const feedFile = (issueId: string) => join(feeds, `${segment(issueId)}.bin`);
      const getFeed = (issueId: string) => read<KeptFeed>(feedFile(issueId));
      return {
        loadSnapshot: <T>() => read<T>(join(dir, "snapshot.bin")),
        saveSnapshot: (value) => write(join(dir, "snapshot.bin"), value),
        pendingTxs: async <T>() => [...(await all<T>(tx)).values()],
        putTx: (id, value) => write(join(tx, `${segment(id)}.bin`), value),
        delTx: (id) => remove(join(tx, `${segment(id)}.bin`)),
        getFeed,
        async putFeeds(list, replace) {
          if (replace) {
            const answered = new Set(list.map((f) => `${segment(f.id)}.bin`));
            const names = (await readdir(feeds)).filter((n) => n.endsWith(".bin") && !answered.has(n));
            await Promise.all(names.map((n) => remove(join(feeds, n))));
          }
          // A copy cut later stays: an opened issue may have written one while this answer was on its way.
          await Promise.all(list.map(async (f) => ((await getFeed(f.id))?.s ?? -1) > f.s || write(feedFile(f.id), f)));
        },
        delFeeds: async (ids) => void (await Promise.all(ids.map((id) => remove(feedFile(id))))),
        close() {},
      } satisfies Disk;
    },
    remove: (name) => rm(folder(name), { recursive: true, force: true }),
  };
}
