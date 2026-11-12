// An in-memory stand-in for the server: snapshot over a fake fetch, frames over a fake socket the test drives by hand.
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, VIEWER_HEADERS, settingsHeaders, type AccountSettings, type ClientFrame, type IssueFeeds, type IssueHistory, type ProjectHistory, type ServerFrame, type SnapshotLine } from "@rsva/protocol";
import { until as waitFor } from "@rsva/test-kit";
import { IDBFactory } from "fake-indexeddb";
import { createSyncStore, type SocketLike, type SyncEngine, type SyncStoreOptions } from "../src/index.ts";

export const WS = { id: "00000000-0000-7000-8000-00000000000a", slug: "atlas", name: "Atlas", color: null, memberRights: ["labels.write"], triagers: [] };
export const ME = "00000000-0000-7000-8000-0000000000a1";
export const PROJECT = "00000000-0000-7000-8000-0000000000b1";
export const TODO = "00000000-0000-7000-8000-0000000000c1";
export const DONE = "00000000-0000-7000-8000-0000000000c2";
export const ISSUE = ["00000000-0000-7000-8000-0000000000d1", "00000000-0000-7000-8000-0000000000d2", "00000000-0000-7000-8000-0000000000d3"] as const;

const ISSUE_COLS = ["id", "projectId", "number", "title", "stateId", "priority", "assigneeIds", "delegateId", "labelIds", "parentId", "blockedByIds", "relatedIds", "duplicateOfId", "startDate", "dueDate", "sortOrder", "createdById", "createdAt", "updatedAt", "completedAt", "archivedAt", "deletedAt"];

export function issueRow(id: string, number: number, title: string, sortOrder: string): unknown[] {
  return [id, PROJECT, number, title, TODO, 0, [], null, [], null, [], [], null, null, null, sortOrder, ME, "2026-10-27T00:00:00Z", "2026-10-27T00:00:00Z", null, null, null];
}

export function snapshot(s: number, titles: readonly string[] = ["First", "Second", "Third"]): SnapshotLine[] {
  return [
    { t: "meta", v: PROTOCOL_VERSION, s, ws: WS },
    { t: "b", m: "User", c: ["id", "email", "name", "kind", "role"], r: [[ME, "a@x.dev", "Robin", "human", "owner"]] },
    { t: "b", m: "Project", c: ["id", "key", "name", "color", "formerKeys", "issueCounter", "createdAt", "archivedAt"], r: [[PROJECT, "PLANE", "Plane", null, ["PLN"], 3, "2026-10-27T00:00:00Z", null]] },
    {
      t: "b",
      m: "WorkflowState",
      c: ["id", "projectId", "name", "group", "color", "position", "isDefault"],
      r: [[DONE, PROJECT, "Done", "completed", "#0f0", 2, false], [TODO, PROJECT, "Todo", "unstarted", "#999", 1, true]],
    },
    {
      t: "b",
      m: "Label",
      c: ["id", "projectId", "parentId", "name", "color", "position"],
      r: [["00000000-0000-7000-8000-0000000000e1", PROJECT, null, "bug", "#f00", 2], ["00000000-0000-7000-8000-0000000000e2", null, null, "ws", "#00f", 1]],
    },
    // Out of sortOrder on purpose: issuesOf must sort.
    { t: "b", m: "Issue", c: ISSUE_COLS, r: [issueRow(ISSUE[1], 2, titles[1]!, "a2"), issueRow(ISSUE[0], 1, titles[0]!, "a1")] },
    { t: "ready" },
    { t: "b", m: "Issue", c: ISSUE_COLS, r: [issueRow(ISSUE[2], 3, titles[2]!, "a3")] },
    { t: "end" },
  ];
}

export class FakeSocket implements SocketLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readonly sent: ClientFrame[] = [];
  closed = false;
  bufferedAmount = 0;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string): void {
    if (this.closed) throw new Error("send on a closed socket");
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.onclose?.({}));
  }
  /** The server closes the connection with this code. */
  closeBy(code: number): void {
    this.closed = true;
    this.onclose?.({ code });
  }
  push(f: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  hello(v = PROTOCOL_VERSION, u = ME): void {
    this.push({ t: "hello", v, u });
  }
  /** Frames of one type the client sent. */
  frames<T extends ClientFrame["t"]>(t: T): Extract<ClientFrame, { t: T }>[] {
    return this.sent.filter((f): f is Extract<ClientFrame, { t: T }> => f.t === t);
  }
}

export interface Harness {
  store: SyncEngine;
  sockets: FakeSocket[];
  /** The latest socket. */
  socket: () => FakeSocket;
  requests: string[];
  reloads: number;
  idb: IDBFactory;
  /** What the next snapshot request returns. */
  serve: SnapshotLine[];
  /** A status the snapshot request fails with instead (401, 403, 404). */
  refuse: number | null;
  /** The viewer's settings the snapshot answer carries; null for a server that sends none. */
  settings: AccountSettings | null;
  /** The person the snapshot answer is for: the credential the browser holds. */
  me: string;
  /** Answers to GET /sync/history/:issueId; a missing issue is a 404. A promise holds the answer back. */
  history: Map<string, IssueHistory | Promise<IssueHistory>>;
  /** Answers to GET /sync/project-history by its query (`project=…&level=…[&until=…]`); a missing one is a 404. */
  projectHistory: Map<string, ProjectHistory | Promise<ProjectHistory>>;
  /** Answers POST /sync/feeds, given the ids the request named; a 404 when unset. */
  feeds: ((ids: string[] | undefined) => IssueFeeds | Promise<IssueFeeds>) | null;
  /** The ids each POST /sync/feeds named, undefined for "all". */
  fills: (string[] | undefined)[];
}

/** Splits NDJSON into odd-sized chunks so line reassembly across chunks is exercised. */
function ndjson(lines: SnapshotLine[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(lines.map((l) => JSON.stringify(l) + "\n").join(""));
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, (at += 97)));
    },
  });
}

export function harness(opts: Partial<SyncStoreOptions> & { idb?: IDBFactory; serve?: SnapshotLine[] } = {}): Harness {
  const h: Harness = {
    store: undefined as unknown as SyncEngine,
    sockets: [],
    socket: () => h.sockets.at(-1)!,
    requests: [],
    reloads: 0,
    idb: opts.idb ?? new IDBFactory(),
    serve: opts.serve ?? snapshot(10),
    refuse: null,
    settings: { timeZone: "Europe/Sofia", weekStart: 0, theme: { mode: "dark", light: "latte", dark: "mocha" }, ui: { panes: "flat", density: "comfortable", start: "inbox", project: "issues", quiet: 7 } },
    me: ME,
    history: new Map(),
    projectHistory: new Map(),
    feeds: null,
    fills: [],
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    h.requests.push(url);
    if (url.includes("/sync/feeds")) {
      const { ids } = JSON.parse(init!.body as string) as { ids?: string[] };
      h.fills.push(ids);
      return h.feeds ? Response.json(structuredClone(await h.feeds(ids))) : new Response(null, { status: 404 });
    }
    if (url.includes("/sync/bootstrap"))
      return h.refuse ? new Response(null, { status: h.refuse }) : new Response(ndjson(h.serve), {
            headers: { [VIEWER_HEADERS.me]: h.me, [VIEWER_HEADERS.role]: "owner", ...(h.settings ? settingsHeaders(h.settings) : {}) },
          });
    const project = /\/sync\/project-history\?(.+)$/.exec(url);
    const hist = /\/sync\/history\/(.+)$/.exec(url);
    const answer = project ? h.projectHistory.get(project[1]!) : hist && h.history.get(hist[1]!);
    if (answer) return Response.json(structuredClone(await answer));
    return new Response(null, { status: 404 });
  };
  h.store = createSyncStore({
    workspace: "atlas",
    project: "PLANE",
    baseUrl: "http://planner.test",
    fetch: fetch as typeof globalThis.fetch,
    WebSocket: class extends FakeSocket {
      constructor(url: string) {
        super(url);
        h.sockets.push(this);
      }
    },
    indexedDB: h.idb,
    reload: () => void h.reloads++,
    persistDelay: 5,
    backoff: [1, 2],
    fillDelay: 60_000,
    ...opts,
  });
  return h;
}

/** Waits for a condition the engine reaches asynchronously (streams, IndexedDB, timers): up to 5 s, checked every ms. */
export const until = (cond: () => boolean, what = "condition"): Promise<number> => waitFor(cond, 5000, what, 1);

/** A started store, past the snapshot and subscribed on a live socket. */
export async function online(opts: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = harness(opts);
  await h.store.start();
  h.socket().hello();
  await until(() => h.socket().frames("sub").length > 0, "sub");
  return h;
}

/** A started store with issue `id`'s feed loaded from `history` (answer cut at s = 10). */
export async function openedFeed(id: string, history: Partial<IssueHistory> = {}) {
  const h = await online();
  h.history.set(id, { s: 10, history: [], comments: [], reactions: [], github: [], doc: null, ...history });
  const feed = h.store.feed(id);
  assert.equal(feed.status, "loading");
  await until(() => feed.status === "ready", "feed");
  return { ...h, feed };
}

/** Changes the snapshot saved in this IndexedDB. */
export async function editSaved(idb: IDBFactory, edit: (saved: Record<string, any>) => unknown): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve) => {
    const r = idb.open("rsva:atlas");
    r.onsuccess = () => resolve(r.result);
  });
  await new Promise((resolve) => {
    const s = db.transaction("kv", "readwrite").objectStore("kv");
    s.get("snapshot").onsuccess = (e) => {
      s.put(edit((e.target as IDBRequest).result as Record<string, any>), "snapshot").onsuccess = resolve;
    };
  });
  db.close();
}

/** Another tab's sign-in as someone else: it deletes the workspace's database, and the open engine lets it go. */
export async function deleteCopy(idb: IDBFactory): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const r = idb.deleteDatabase("rsva:atlas");
    r.onsuccess = () => resolve();
    r.onblocked = () => reject(new Error("the open tab blocked the delete"));
  });
}

/** Saves the store, closes it and starts a new one on the same IndexedDB, as a reload does. */
export async function reopened(h: Harness): Promise<Harness> {
  await h.store.persist();
  h.store.dispose();
  const again = harness({ idb: h.idb });
  await again.store.start();
  return again;
}
