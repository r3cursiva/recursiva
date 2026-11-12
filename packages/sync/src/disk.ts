// Where the engine keeps its copy between starts: a snapshot, the queue of changes not confirmed yet, and issues'
// activity. The browser keeps it in IndexedDB (idb.ts); the TUI in a folder of files (apps/tui, PLNR-306). The engine
// sees only this interface, so both run the same code.
import type { KeptFeed } from "@rsva/protocol";

export interface Disk {
  loadSnapshot<T>(): Promise<T | undefined>;
  saveSnapshot(value: unknown): Promise<void>;
  /** The queued changes, in no particular order: the engine sorts them. */
  pendingTxs<T>(): Promise<T[]>;
  putTx(id: string, value: unknown): Promise<void>;
  delTx(id: string): Promise<void>;
  getFeed(issueId: string): Promise<KeptFeed | undefined>;
  /** Keeps a copy cut later than the one given; `replace` drops every stored feed the list does not have. */
  putFeeds(feeds: KeptFeed[], replace?: boolean): Promise<void>;
  delFeeds(issueIds: string[]): Promise<void>;
  close(): void;
}

const PREFIX = "rsva:";

/** A workspace's copy, by name. */
export const copyName = (slug: string): string => PREFIX + slug;

/** The workspace a copy belongs to, by its name; null for a name that is not a copy's. */
export const copySlug = (name: string | undefined): string | null => (name?.startsWith(PREFIX) ? name.slice(PREFIX.length) : null);

/** One copy per workspace, by name (copyName). */
export interface Disks {
  open(name: string): Promise<Disk>;
  /** The copy and its queue go: the viewer lost access to the workspace. The engine does not wait for it. */
  remove(name: string): void | Promise<void>;
}
