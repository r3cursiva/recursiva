// A project's history at one level (PLNR-71), as its History page reads it: pages from the server, newest first, and
// the workspace's deltas on top while the page is open. Entries, comments and the project's own changes are kept as the
// server sends them; the page folds them into days and stories. Creations come from the issues in the pool; an I entry
// only says what one started with.
import {
  COMMENT_EXCERPT,
  atLevel,
  levelComments,
  levelSettings,
  type Action,
  type HistoryEntry,
  type HistoryLevel,
  type ProjectComment,
  type ProjectHistory,
  type ProjectHistoryEntry,
  type ProjectSettingEntry,
} from "@rsva/protocol";
import { computed, makeObservable, observable, runInAction } from "mobx";
import type { ProjectHistoryFeed } from "./store.ts";

/** What one delta adds: a change of an issue, a comment or a change of the project's own, with the action's log number. */
interface Item {
  id: number;
  entry?: ProjectHistoryEntry;
  comment?: ProjectComment;
  setting?: ProjectSettingEntry;
}

/** A change of a state or label the engine read off a delta, with the project it belongs to (null: the workspace's). */
export interface SettingDelta {
  projectId: string | null;
  entry: ProjectSettingEntry;
}

/** One page of the history after `until` (the newest one without it); null when the request ended the session. */
export type FetchPage = (query: string) => Promise<ProjectHistory | null>;

export class ProjectFeed implements ProjectHistoryFeed {
  status: ProjectHistoryFeed["status"] = "loading";
  readonly entries = observable.array<ProjectHistoryEntry>([], { deep: false });
  readonly comments = observable.array<ProjectComment>([], { deep: false });
  readonly settings = observable.array<ProjectSettingEntry>([], { deep: false });
  older: string | null = null;
  loadingOlder = false;
  failedAt = 0;
  /** A load is in flight: deltas wait in `buffer` until its answer, then those past its cut go on top. */
  private buffer: Item[] | null = null;
  /** Log number the newest page was cut at. */
  private s = -1;
  private gen = 0;
  private started = false;
  readonly projectId: string;
  readonly level: HistoryLevel;
  private readonly fetchPage: FetchPage;
  private readonly warn: (e: unknown) => void;

  constructor(projectId: string, level: HistoryLevel, fetchPage: FetchPage, warn: (e: unknown) => void) {
    this.projectId = projectId;
    this.level = level;
    this.fetchPage = fetchPage;
    this.warn = warn;
    makeObservable(this, { status: observable, older: observable, loadingOlder: observable, hasOlder: computed });
  }

  get hasOlder(): boolean {
    return this.older !== null;
  }

  /** A load is due: none has started yet, or the last one failed a while ago. */
  due(now: number, retryMs: number): boolean {
    return this.status === "loading" ? !this.started : this.status === "error" && now - this.failedAt > retryMs;
  }

  private query(until?: string): string {
    const q = new URLSearchParams({ project: this.projectId, level: this.level });
    if (until) q.set("until", until);
    return q.toString();
  }

  /** Loads (or reloads) the newest page; the history drawn so far stays until the answer replaces it. */
  async load(): Promise<void> {
    const gen = ++this.gen;
    this.started = true;
    this.buffer = [];
    try {
      const h = await this.fetchPage(this.query());
      if (gen !== this.gen) return;
      if (!h) {
        this.buffer = null;
        return;
      }
      runInAction(() => {
        this.entries.replace(h.history);
        this.comments.replace(h.comments);
        this.settings.replace(h.settings ?? []);
        this.s = h.s;
        this.older = h.older ?? null;
        const buffered = this.buffer ?? [];
        this.buffer = null;
        for (const b of buffered) if (b.id > h.s) this.add(b);
        this.status = "ready";
      });
    } catch (e) {
      if (gen !== this.gen) return;
      this.warn(e);
      this.failedAt = Date.now();
      runInAction(() => {
        this.buffer = null;
        if (this.status === "loading") this.status = "error";
      });
    }
  }

  /**
   * The page before the oldest one loaded, under what is here. Deltas meanwhile need no waiting: they are newer than
   * anything loaded, and that page is older still.
   */
  loadOlder(): void {
    const until = this.older;
    if (until === null || this.loadingOlder || this.buffer) return;
    const gen = this.gen;
    runInAction(() => (this.loadingOlder = true));
    void this.fetchPage(this.query(until))
      .then((h) => {
        if (!h || gen !== this.gen) return;
        runInAction(() => {
          const have = new Set(this.entries.map((e) => e.id));
          this.entries.replace([...h.history.filter((e) => !have.has(e.id)), ...this.entries]);
          const known = new Set(this.comments.map((c) => c.id));
          this.comments.replace([...h.comments.filter((c) => !known.has(c.id)), ...this.comments]);
          const seen = new Set(this.settings.map((e) => e.id));
          this.settings.replace([...(h.settings ?? []).filter((e) => !seen.has(e.id)), ...this.settings]);
          this.older = h.older ?? null;
        });
      })
      .catch(this.warn)
      .finally(() => runInAction(() => (this.loadingOlder = false)));
  }

  /**
   * A delta of the workspace, applied by the engine before the pool changes. `entry` is the issue history entry it makes
   * (an Issue or Document action, before-values from the pool; an issue's creation with what it started with), `setting`
   * a state's or label's change, `projectOf` names an issue's project.
   */
  take(a: Action, entry: HistoryEntry | null, setting: SettingDelta | null, projectOf: (issueId: string) => string | undefined): void {
    if (a.m === "Comment" && a.a === "U") return this.editComment(a);
    const item = setting ? this.settingOf(a, setting) : this.itemOf(a, entry, projectOf);
    if (!item) return;
    if (this.buffer) this.buffer.push(item);
    else if (this.status === "ready" && a.id > this.s) runInAction(() => this.add(item));
  }

  private itemOf(a: Action, entry: HistoryEntry | null, projectOf: (issueId: string) => string | undefined): Item | null {
    const d = a.d ?? {};
    if (a.m === "Comment" && a.a === "I") {
      const i = d.issueId as string;
      if (!levelComments(this.level) || projectOf(i) !== this.projectId) return null;
      const at = (d.createdAt as string | undefined) ?? new Date().toISOString();
      return { id: a.id, comment: { id: a.mid, i, by: a.by ?? null, at, x: String(d.body ?? "").slice(0, COMMENT_EXCERPT), r: (d.parentId as string | null | undefined) ?? null } };
    }
    // A new issue is not in the pool yet: its action names the project. A move (PLNR-448) is in the history of the project
    // it leaves (the pool's, read before the move applies) and of the one it goes to (the action's).
    if (!entry || ((projectOf(a.mid) ?? (a.a === "I" ? d.projectId : undefined)) !== this.projectId && d.projectId !== this.projectId)) return null;
    const e = atLevel({ ...entry, i: a.mid }, this.level);
    return e && { id: a.id, entry: e };
  }

  private settingOf(a: Action, s: SettingDelta): Item | null {
    return levelSettings(this.level) && s.projectId === this.projectId ? { id: a.id, setting: s.entry } : null;
  }

  private add(item: Item): void {
    if (item.entry) this.entries.push(item.entry);
    if (item.comment) this.comments.push(item.comment);
    if (item.setting) this.settings.push(item.setting);
  }

  /** A comment's edit changes its line; deleting it takes the line away. */
  private editComment(a: Action): void {
    const at = this.comments.findIndex((c) => c.id === a.mid);
    if (at < 0) return;
    const c = this.comments[at]!;
    runInAction(() => {
      if (a.d?.deletedAt) this.comments.splice(at, 1);
      else if (typeof a.d?.body === "string") this.comments[at] = { ...c, x: a.d.body.slice(0, COMMENT_EXCERPT) };
    });
  }
}
