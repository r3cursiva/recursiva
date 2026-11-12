// The few IndexedDB calls the engine needs, on the raw API: a wrapper library would cost more bytes than this file.
//
// One database per workspace ("rsva:<slug>") with two stores: `kv` holds the snapshot under one key, `tx` holds
// pending transactions keyed by their UUIDv7 id, so reading the store back yields them in creation order.
// Issues' activity lives in `kv` under "feed:<issue id>": a store of its own would take a version change, which another
// open tab can block, and with it this tab's start.

import type { KeptFeed } from "@rsva/protocol";
import { copyName, type Disks } from "./disk.ts";

type Store = "kv" | "tx";

/** How long start() waits for the database before it works from the network: another tab's delete can hold it. */
const OPEN_TIMEOUT_MS = 3000;

function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(name, 1);
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      reject(new Error(`IndexedDB ${name} did not open in ${OPEN_TIMEOUT_MS} ms`));
    }, OPEN_TIMEOUT_MS);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("kv");
      r.result.createObjectStore("tx");
    };
    r.onsuccess = () => {
      clearTimeout(timer);
      const db = r.result;
      if (late) return db.close();
      // Another tab deletes the database (a sign-in as someone else) or upgrades it: let it, instead of blocking it and
      // every open queued behind it. This tab's later writes fail and are logged; its data is in memory.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => {
      clearTimeout(timer);
      reject(r.error);
    };
  });
}

const committed = (t: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
  });

/**
 * One request in its own transaction. A read resolves with the request; a write only once the transaction commits:
 * a quota error usually aborts the transaction at commit, after the request itself succeeded. A closed database throws
 * in db.transaction, which the executor turns into a rejection.
 */
function run<T>(db: IDBDatabase, s: Store, mode: IDBTransactionMode, make: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(s, mode);
    const r = make(t.objectStore(s));
    if (mode === "readonly") {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    } else resolve(committed(t).then(() => r.result));
  });
}

const get = <T>(db: IDBDatabase, s: Store, key: string) => run(db, s, "readonly", (st) => st.get(key)) as Promise<T | undefined>;
const getAll = <T>(db: IDBDatabase, s: Store) => run(db, s, "readonly", (st) => st.getAll()) as Promise<T[]>;
const put = (db: IDBDatabase, s: Store, key: string, value: unknown) => run(db, s, "readwrite", (st) => st.put(value, key));
const del = (db: IDBDatabase, s: Store, key: string) => run(db, s, "readwrite", (st) => st.delete(key));

/** Changes waiting in a workspace's queue on this device. */
export async function queued(factory: IDBFactory, slug: string): Promise<number> {
  const db = await openDb(factory, copyName(slug));
  try {
    return (await getAll(db, "tx")).length;
  } finally {
    db.close();
  }
}

const feedKey = (issueId: string) => `feed:${issueId}`;

const getFeed = (db: IDBDatabase, issueId: string) => get<KeptFeed>(db, "kv", feedKey(issueId));

/**
 * Stores issues' activity in one transaction. A copy cut later stays: an opened issue, or another tab, may have written
 * one while this answer was on its way. `replace` also drops every stored feed the answer does not have.
 */
function putFeeds(db: IDBDatabase, feeds: KeptFeed[], replace = false): Promise<void> {
  const t = db.transaction("kv", "readwrite");
  const kv = t.objectStore("kv");
  if (replace) {
    const answered = new Set(feeds.map((f) => feedKey(f.id)));
    const keys = kv.getAllKeys();
    keys.onsuccess = () => {
      for (const k of keys.result) if (String(k).startsWith("feed:") && !answered.has(String(k))) kv.delete(k);
    };
  }
  for (const f of feeds) {
    const have = kv.get(feedKey(f.id));
    have.onsuccess = () => {
      if (!((have.result as KeptFeed | undefined)?.s! > f.s)) kv.put(f, feedKey(f.id));
    };
  }
  return committed(t);
}

function delFeeds(db: IDBDatabase, issueIds: string[]): Promise<void> {
  const t = db.transaction("kv", "readwrite");
  for (const id of issueIds) t.objectStore("kv").delete(feedKey(id));
  return committed(t);
}

/** The engine's disk in the browser: one IndexedDB database per workspace. */
export const idbDisks = (factory: IDBFactory): Disks => ({
  async open(name) {
    const db = await openDb(factory, name);
    return {
      loadSnapshot: <T>() => get<T>(db, "kv", "snapshot"),
      saveSnapshot: async (value) => void (await put(db, "kv", "snapshot", value)),
      pendingTxs: <T>() => getAll<T>(db, "tx"),
      putTx: async (id, value) => void (await put(db, "tx", id, value)),
      delTx: async (id) => void (await del(db, "tx", id)),
      getFeed: (issueId) => getFeed(db, issueId),
      putFeeds: (feeds, replace) => putFeeds(db, feeds, replace),
      delFeeds: (issueIds) => delFeeds(db, issueIds),
      close: () => db.close(),
    };
  },
  remove(name) {
    factory.deleteDatabase(name);
  },
});
