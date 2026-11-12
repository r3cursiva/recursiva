// The engine's cache of activity: opened issues' feeds (comments, reactions, history) and project histories, both live,
// and the copy of every issue's activity kept on disk so that opening one needs no request (PLNR-80).
//
// An open feed loads once and then follows the log: deltas for it that arrive while an answer is on its way wait in its
// buffer and go on top of the answer, past its cut. The engine owns the log and the pool; this owns which issues are
// tracked, what their copies on disk vouch for, and the requests that fill them.
import { FEEDS_MAX_IDS, type Action, type HistoryEntry, type HistoryLevel, type IssueFeeds, type IssueHistory, type KeptFeed, type ProjectHistory } from "@rsva/protocol";
import { runInAction } from "mobx";
import { warn } from "./log.ts";
import type { Disk } from "./disk.ts";
import { Feed } from "./feed.ts";
import type { AnyModel, Pool, Row } from "./pool.ts";
import { ProjectFeed, type SettingDelta } from "./project-feed.ts";

/** Opened issues whose comments and history stay loaded and live; the least recently opened beyond this are dropped. */
const MAX_FEEDS = 50;
/** Project histories kept live (a level each): the open one and the levels switched through recently. */
const MAX_PROJECT_FEEDS = 4;
/** A failed feed load is retried on the next read after this long. */
const FEED_RETRY_MS = 5000;

/** What the cache reads of the engine. */
export interface FeedHost {
  readonly pool: Pool;
  readonly slug: string;
  /** How long the start (or a reconnect) has the network to itself before the activity to keep is fetched, ms. */
  readonly fillDelay: number;
  readonly meId: string;
  readonly db: Disk | null;
  readonly disposed: boolean;
  readonly lastSyncId: number;
  /** This connection has the log up to now: `stale` knows of everything that changed. */
  readonly caughtUp: boolean;
  /** A full copy on a live connection: what changes from now on arrives as deltas. */
  readonly linked: boolean;
  readonly abort: AbortController;
  /** Rows made here and not echoed by the server yet, and rows removed here while the removal is pending. */
  readonly created: ReadonlyMap<string, unknown>;
  readonly removed: ReadonlyMap<string, unknown>;
  /** A request to the server, with the engine's abort signal. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** The server says the session has ended: the engine stops. */
  ended(): void;
  /** Writes a server row under the pending local changes. */
  applyServer(m: AnyModel, kind: Action["a"], mid: string, data: Row): void;
  /** A local change of the row (of a description: model "Document") is in flight. */
  isPending(id: string, model?: "Document"): boolean;
  /** Something the copy on disk keeps changed: save it soon. */
  markDirty(): void;
  persistNow(): Promise<void>;
}

/** Gets `key` from an LRU map, made by `make` when missing, as the most recently used: last. */
function recent<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const had = map.get(key);
  if (had !== undefined) map.delete(key);
  const v = had ?? make();
  map.set(key, v);
  return v;
}

export class FeedCache {
  /** Opened issues' feeds, least recently opened first. */
  private readonly feeds = new Map<string, Feed>();
  /** Opened project histories by project and level, least recently opened first. */
  private readonly projectFeeds = new Map<string, ProjectFeed>();
  /**
   * The activity on disk can be read (PLNR-80): for every issue not in `stale`, a kept copy holds all there is up to
   * lastSyncId. Deltas keep that true, so opening such an issue needs no request and works offline.
   */
  private kept = false;
  /** Issues changed since their copy on disk was cut, each with its last action. Saved with lastSyncId in one value. */
  private readonly stale = new Map<string, number>();
  private filling = false;
  /** Bumped by a new snapshot: a fill already on its way cut its answer before it and vouches for nothing. */
  private fillEpoch = 0;
  private fillTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly host: FeedHost;
  private readonly pool: Pool;
  private readonly projectOf = (issueId: string) => this.pool.get("Issue", issueId)?.projectId as string | undefined;

  constructor(host: FeedHost) {
    this.host = host;
    this.pool = host.pool;
  }

  feed(issueId: string): Feed {
    const fresh = !this.feeds.has(issueId);
    const feed = recent(this.feeds, issueId, () => new Feed(
      issueId,
      this.pool,
      () => this.host.meId,
      (x) => void this.loadOlder(x),
      (x) => {
        runInAction(() => (x.status = "loading"));
        void this.loadFeed(x);
      },
    ));
    if (fresh) this.evict();
    // Called from render: the load starts outside the reactive context.
    if (!feed.queued && (feed.status === "loading" ? !feed.buffer : (feed.status === "error" || (feed.behind && this.host.caughtUp)) && !feed.buffer && Date.now() - feed.failedAt > FEED_RETRY_MS)) {
      // One render reads a feed from several components: without the mark each read would send its own request.
      feed.queued = true;
      queueMicrotask(() => {
        feed.queued = false;
        void (feed.behind ? this.loadFeed(feed) : this.open(feed));
      });
    }
    return feed;
  }

  projectHistory(projectId: string, level: HistoryLevel): ProjectFeed {
    const feed = recent(this.projectFeeds, `${projectId}:${level}`, () => new ProjectFeed(projectId, level, (q) => this.fetchProjectHistory(q), warn));
    for (const [k, old] of this.projectFeeds) if (this.projectFeeds.size > MAX_PROJECT_FEEDS && !old.loadingOlder) this.projectFeeds.delete(k);
    // Called from render: the load starts outside the reactive context.
    if (feed.due(Date.now(), FEED_RETRY_MS)) queueMicrotask(() => void feed.load());
    return feed;
  }

  /** A request to the sync API. An ended session stops the engine and answers null. */
  private async sync(path: string): Promise<Response | null> {
    const r = await this.host.fetch(path);
    if (r.status !== 401) return r;
    this.host.ended();
    return null;
  }

  /** A page of a project's history; a project made here that the server does not have yet has none. */
  private async fetchProjectHistory(query: string): Promise<ProjectHistory | null> {
    const r = await this.sync(`/sync/project-history?${query}`);
    if (!r) return null;
    if (r.status === 404) return { s: this.host.lastSyncId, history: [], comments: [], settings: [] };
    if (!r.ok) throw new Error(`Project history request failed: HTTP ${r.status}`);
    return (await r.json()) as ProjectHistory;
  }

  /** A newly read feed: from the copy on disk when there is one, with a request only if that copy is missing or behind. */
  private async open(f: Feed): Promise<void> {
    if (this.host.disposed) return;
    const db = this.host.db;
    if (db && this.kept) {
      const gen = ++f.gen;
      f.buffer = [];
      let kept: KeptFeed | undefined;
      try {
        kept = await db.getFeed(f.issueId);
      } catch (e) {
        warn(e); // a lost connection throws before there is a promise
      }
      if (gen !== f.gen || this.host.disposed) return;
      // A new snapshot during the read leaves `stale` empty and the copy unvouched for.
      if (kept && this.kept) {
        const stale = this.stale.has(f.issueId);
        // Offline or before the catch-up the copy may miss what others did: it shows, and a save waits for `caught-up`.
        this.fill(f, kept, stale || !this.host.caughtUp);
        if (!stale) return;
      }
    }
    return this.loadFeed(f);
  }

  /** The log has been read up to now: copies shown before that are either fine as they are or need reading again. */
  confirm(): void {
    runInAction(() => {
      for (const f of this.feeds.values()) {
        if (!f.behind || f.buffer) continue;
        if (this.stale.has(f.issueId)) void this.loadFeed(f);
        else f.behind = false;
      }
    });
  }

  /** Applies the deltas that waited in the feed's buffer, except those `done` says are in already. */
  private drain(f: Feed, done: (a: Action) => boolean): void {
    const buffered = f.buffer ?? [];
    f.buffer = null;
    for (const b of buffered) {
      if (done(b.a)) continue;
      if (b.entry) f.history.push(b.entry);
      else this.applyIssueModel(b.a);
    }
  }

  /** Puts an answer into the feed, then the deltas that waited for it, past its cut `s`. */
  private fill(f: Feed, h: IssueHistory, behind = false): void {
    runInAction(() => {
      const keep = new Set([...h.comments.map((c) => c.id), ...h.reactions.map((x) => x.id)]);
      // On a reload, rows the server no longer has go, except the ones made here and not yet sent back.
      for (const c of this.pool.commentsOf(f.issueId)) if (!keep.has(c.id) && !this.host.created.has(c.id)) this.pool.remove("Comment", c.id);
      for (const x of this.pool.reactionsOf(f.issueId)) if (!keep.has(x.id) && !this.host.created.has(x.id)) this.pool.remove("Reaction", x.id);
      const linked = new Set(h.github.map((l) => l.id));
      for (const l of this.pool.githubOf(f.issueId)) if (!linked.has(l.id)) this.pool.remove("GithubLink", l.id);
      for (const c of h.comments) this.host.applyServer("Comment", "I", c.id, c as unknown as Row);
      for (const x of h.reactions) this.host.applyServer("Reaction", "I", x.id, x as unknown as Row);
      for (const l of h.github) this.host.applyServer("GithubLink", "I", l.id, l as unknown as Row);
      if (h.doc) this.host.applyServer("Document", "I", h.doc.id, h.doc as unknown as Row);
      f.history.replace(h.history);
      f.s = h.s;
      f.older = h.older ?? null;
      f.behind = behind;
      this.drain(f, (a) => a.id <= h.s);
      f.status = "ready";
    });
  }

  /** Keeps an issue's answer on disk; the issue stops being stale unless it changed after the cut. */
  private async keep(feed: KeptFeed): Promise<void> {
    const db = this.host.db;
    if (!db) return;
    try {
      await db.putFeeds([feed]);
      this.settle([feed.id], feed.s);
    } catch (e) {
      warn(e);
    }
  }

  private settle(ids: Iterable<string>, s: number): void {
    let any = false;
    for (const id of ids) {
      const last = this.stale.get(id);
      if (last !== undefined && last <= s) any = this.stale.delete(id);
    }
    if (any) this.host.markDirty();
  }

  /**
   * Schedules a fill. It is held back so that it never competes with the start for the network, and comes again after a
   * reconnect for what changed in the meantime.
   */
  scheduleFill(): void {
    if (this.host.db && !this.fillTimer && !this.host.disposed) {
      this.fillTimer = setTimeout(() => {
        this.fillTimer = undefined;
        void this.fillAll();
      }, this.host.fillDelay);
    }
  }

  /**
   * Fetches the activity of the issues to keep, so that opening them needs no request: everything that fits the first
   * time (docs/research/feed-prefetch-2026-10-30.md), and after that the issues that changed. Issues changed in a session
   * are not fetched until the next fill: most are never opened, and an open one is live already.
   */
  private async fillAll(): Promise<void> {
    const db = this.host.db;
    const saveData = (globalThis.navigator as { connection?: { saveData?: boolean } } | undefined)?.connection?.saveData;
    if (!db || !this.host.linked || this.filling || (saveData && !this.kept)) return;
    const ids = this.kept ? [...this.stale.keys()].slice(0, FEEDS_MAX_IDS) : undefined;
    if (ids?.length === 0) return;
    this.filling = true;
    const epoch = this.fillEpoch;
    try {
      const r = await this.host.fetch(`/sync/feeds?ws=${encodeURIComponent(this.host.slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ids ? { ids } : {}),
      });
      if (!r.ok) throw new Error(`Feeds request failed: HTTP ${r.status}`);
      const { s, feeds } = (await r.json()) as IssueFeeds;
      await db.putFeeds(feeds, !ids);
      if (ids) {
        // Not in the answer: too long to keep, or gone. Its copy is behind, and it loads when opened.
        const got = new Set(feeds.map((f) => f.id));
        await db.delFeeds(ids.filter((id) => !got.has(id)));
      }
      if (epoch !== this.fillEpoch) return;
      this.kept = true;
      this.settle(ids ?? [...this.stale.keys()], s);
      // At once, not after the debounce: lost, the next start would fetch all of it again.
      await this.host.persistNow();
      performance.mark?.("rsva:feeds");
    } catch (e) {
      if (!this.host.abort.signal.aborted) warn(e);
    } finally {
      this.filling = false;
      if (epoch !== this.fillEpoch) this.scheduleFill();
    }
  }

  /**
   * Loads (or reloads) an issue's feed. Deltas for the issue that arrive meanwhile wait in the feed's buffer; after the
   * answer, those past its cut `s` are applied on top, so nothing is lost or applied twice.
   */
  private async loadFeed(f: Feed): Promise<void> {
    if (this.host.disposed) return;
    const gen = ++f.gen;
    f.buffer = [];
    const startedAt = this.host.lastSyncId;
    try {
      const r = await this.sync(`/sync/history/${encodeURIComponent(f.issueId)}`);
      if (!r) return;
      // An issue created here that the server does not have yet: nothing to load.
      let h: IssueHistory = { s: startedAt, history: [], comments: [], reactions: [], github: [], doc: null };
      if (r.ok) h = (await r.json()) as IssueHistory;
      else if (r.status !== 404) throw new Error(`History request failed: HTTP ${r.status}`);
      if (gen !== f.gen) return;
      this.fill(f, h);
      if (r.ok) void this.keep({ ...h, id: f.issueId });
    } catch (e) {
      if (this.host.abort.signal.aborted || gen !== f.gen) return;
      warn(e);
      f.failedAt = Date.now();
      runInAction(() => {
        // What it shows stays, and stays live: a reload that failed must not lose what happened meanwhile.
        if (f.status === "loading") {
          f.buffer = null;
          f.status = "error";
        } else this.drain(f, (a) => a.id <= f.s);
      });
      // A description waits for this, and `caught-up` will not come again: no render has to ask.
      if (f.behind && this.host.caughtUp) {
        setTimeout(() => {
          if (!this.host.disposed && f.behind && !f.buffer && this.feeds.get(f.issueId) === f) void this.loadFeed(f);
        }, FEED_RETRY_MS);
      }
    }
  }

  /**
   * Loads the page of activity before the oldest one loaded and adds it under what the feed has. Rows already here are
   * newer than the page and stay. Deltas for the issue wait in the buffer meantime: those on the page's own rows up to its
   * cut `s` are in the answer already, every other one is applied after it as usual.
   */
  private async loadOlder(f: Feed): Promise<void> {
    const until = f.older;
    if (this.host.disposed || until === null || f.loadingOlder || f.buffer) return;
    const gen = f.gen;
    f.buffer = [];
    runInAction(() => (f.loadingOlder = true));
    let h: IssueHistory | null = null;
    try {
      const r = await this.sync(`/sync/history/${encodeURIComponent(f.issueId)}?until=${encodeURIComponent(until)}`);
      if (!r) return;
      if (!r.ok) throw new Error(`History request failed: HTTP ${r.status}`);
      h = (await r.json()) as IssueHistory;
    } catch (e) {
      if (!this.host.abort.signal.aborted) warn(e);
    } finally {
      // A reload started meanwhile owns the buffer now and its answer decides; otherwise the page goes in (if it came)
      // and the deltas held for it after.
      if (gen === f.gen) runInAction(() => this.addOlder(f, h));
      runInAction(() => (f.loadingOlder = false));
    }
  }

  private addOlder(f: Feed, h: IssueHistory | null): void {
    const page = new Set<string>();
    if (h) {
      for (const [m, rows] of [["Comment", h.comments], ["Reaction", h.reactions]] as const) {
        for (const row of rows) {
          page.add(row.id);
          if (!this.pool.get(m, row.id)) this.host.applyServer(m, "I", row.id, row as unknown as Row);
        }
      }
      const have = new Set(f.history.map((e) => e.id));
      f.history.replace([...h.history.filter((e) => !have.has(e.id)), ...f.history]);
      f.older = h.older ?? null;
    }
    this.drain(f, (a) => a.id <= f.s || (!!h && page.has(a.mid) && a.id <= h.s));
  }

  /** After a new snapshot: deltas were dropped while it loaded, so every tracked feed is read again. */
  reload(): void {
    // What changed before this snapshot is unknown, so nothing on disk can be vouched for: all of it is fetched again.
    this.kept = false;
    this.stale.clear();
    this.fillEpoch++;
    this.scheduleFill();
    for (const f of this.feeds.values()) if (f.status !== "error") void this.loadFeed(f);
    for (const f of this.projectFeeds.values()) if (f.status !== "error") void f.load();
  }

  /** Drops the least recently opened feeds beyond MAX_FEEDS, keeping any with local changes in flight. */
  private evict(): void {
    for (const [issueId, f] of this.feeds) {
      if (this.feeds.size <= MAX_FEEDS) return;
      const rows = [...this.pool.commentsOf(issueId), ...this.pool.reactionsOf(issueId)];
      if (rows.some((r) => this.host.isPending(r.id)) || this.host.isPending(issueId, "Document") || f.buffer || f.notSent.length) continue;
      runInAction(() => this.drop(issueId));
    }
  }

  /** An issue's feed and what it loaded: its comments, reactions, GitHub links and description. */
  private drop(issueId: string): void {
    this.feeds.delete(issueId);
    for (const c of this.pool.commentsOf(issueId)) this.pool.remove("Comment", c.id);
    for (const x of this.pool.reactionsOf(issueId)) this.pool.remove("Reaction", x.id);
    for (const l of this.pool.githubOf(issueId)) this.pool.remove("GithubLink", l.id);
    this.pool.remove("Document", issueId);
  }

  /** An issue deleted for good (RSVA-457): its feed and its links and files go with it; the server deleted them too. */
  dropIssue(issueId: string): void {
    this.drop(issueId);
    for (const x of this.pool.attachmentsOf(issueId)) this.pool.remove("Attachment", x.id);
  }

  // ── The log ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** Project histories are open: a delta goes to them too, with what `entry` and `setting` make of it. */
  get followsProjects(): boolean {
    return this.projectFeeds.size > 0;
  }

  takeProject(a: Action, entry: HistoryEntry | null, setting: SettingDelta | null): void {
    for (const f of this.projectFeeds.values()) f.take(a, entry, setting, this.projectOf);
  }

  /** The issue's copy on disk is behind action `id`. */
  changed(issueId: string, id: number): void {
    this.stale.set(issueId, id);
  }

  /**
   * Comments and reactions are tracked only for opened issues (their feed), plus rows made here until echoed. Their
   * actions carry `issueId`, which routes them without knowing the row.
   */
  applyIssueModel(a: Action): void {
    const f = this.feeds.get(a.d?.issueId as string);
    if (f?.buffer) {
      f.buffer.push({ a });
      return;
    }
    if (f ? a.id <= f.s : !this.pool.get(a.m as AnyModel, a.mid) && !this.host.removed.has(a.mid)) return;
    this.host.applyServer(a.m as AnyModel, a.a, a.mid, a.d ?? {});
  }

  /** A change to an opened issue, or a save of its description, goes into its feed's history. */
  record(a: Action, entry: HistoryEntry | null): void {
    const f = this.feeds.get(a.mid);
    if (!entry || !f || (!f.buffer && a.id <= f.s)) return;
    if (f.buffer) f.buffer.push({ a, entry });
    else f.history.push(entry);
  }

  // ── The copy on disk ────────────────────────────────────────────────────────────────────────────────────────

  /** What the saved copy keeps: the stale issues, once there is activity on disk to be stale against. */
  saved(): [issueId: string, action: number][] | undefined {
    return this.kept ? [...this.stale] : undefined;
  }

  /** From a saved copy: its activity on disk is vouched for except the stale issues. */
  restore(stale: readonly [issueId: string, action: number][]): void {
    this.kept = true;
    for (const [id, action] of stale) this.stale.set(id, action);
  }

  dispose(): void {
    clearTimeout(this.fillTimer);
  }
}
