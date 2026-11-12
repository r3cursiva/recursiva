// The observable part of an opened issue that is not in the snapshot. Rows (comments, reactions) live in the pool, so
// the engine's optimistic machinery covers them as it covers issues; the feed adds the history list, the load state and
// derived views (threads, reaction groups).
import type { Action, HistoryEntry } from "@rsva/protocol";
import { compareStructural, computed, makeObservable, observable, type IComputedValue, type IObservableArray } from "mobx";
import type { Pool } from "./pool.ts";
import type { CommentThread, IssueFeed, NotSentComment, ReactionGroup } from "./store.ts";
import { groupBy } from "@rsva/schema/util";

/** A delta that arrived while the feed was loading, with the history entry it makes (issue changes only). */
export interface Buffered {
  a: Action;
  entry?: HistoryEntry;
}

export class Feed implements IssueFeed {
  status: IssueFeed["status"] = "loading";
  readonly history: IObservableArray<HistoryEntry> = observable.array([], { deep: false });
  readonly notSent: IObservableArray<NotSentComment> = observable.array([], { deep: false });
  /** Log number the last answer was cut at: actions up to it are already in. -1 before the first answer. */
  s = -1;
  /** While a load is in flight, deltas for this issue wait here and are applied after the answer, past its `s`. */
  buffer: Buffered[] | null = null;
  /** A load is scheduled for the end of this render and has not started yet. */
  queued = false;
  /** Bumped by each load; an answer for an older one is dropped. */
  gen = 0;
  failedAt = 0;
  /** Where older activity starts (the server's `older`): the next page's `until`; null when all of it is in. */
  older: string | null = null;
  /** Showing a copy from disk that is known to be out of date, until a request brings the current one. */
  behind = false;
  loadingOlder = false;
  private readonly groups = new Map<string, IComputedValue<ReactionGroup[]>>();
  readonly issueId: string;
  private readonly pool: Pool;
  private readonly me: () => string;
  private readonly fetchOlder: (f: Feed) => void;
  private readonly reload: (f: Feed) => void;

  constructor(issueId: string, pool: Pool, me: () => string, fetchOlder: (f: Feed) => void, reload: (f: Feed) => void) {
    this.issueId = issueId;
    this.pool = pool;
    this.me = me;
    this.fetchOlder = fetchOlder;
    this.reload = reload;
    makeObservable(this, { status: observable, older: observable, behind: observable, loadingOlder: observable, threads: computed, hasOlder: computed });
  }

  get hasOlder(): boolean {
    return this.older !== null;
  }

  dropNotSent(id: string): void {
    const c = this.notSent.find((x) => x.id === id);
    if (c) this.notSent.remove(c);
  }

  loadOlder(): void {
    if (this.older !== null && !this.loadingOlder) this.fetchOlder(this);
  }

  retry(): void {
    if (this.status === "error") this.reload(this);
  }

  get threads(): CommentThread[] {
    const all = this.pool.commentsOf(this.issueId);
    const ids = new Set(all.map((c) => c.id));
    const replies = groupBy(
      all.filter((c) => c.parentId && ids.has(c.parentId) && !c.deletedAt),
      (c) => c.parentId!,
    );
    const out: CommentThread[] = [];
    for (const c of all) {
      // A reply whose parent is unknown shows as a thread of its own rather than disappearing.
      if (c.parentId && ids.has(c.parentId)) continue;
      const r = replies.get(c.id) ?? [];
      if (c.deletedAt && r.length === 0) continue;
      out.push({ comment: c, replies: r });
    }
    return out;
  }

  reactions(targetId: string): ReactionGroup[] {
    let c = this.groups.get(targetId);
    if (!c) {
      const onIssue = targetId === this.issueId;
      c = computed(
        () => {
          const me = this.me();
          const by = new Map<string, ReactionGroup>();
          for (const r of this.pool.reactionsOf(this.issueId)) {
            if (onIssue ? r.commentId !== null : r.commentId !== targetId) continue;
            let g = by.get(r.emoji);
            if (!g) by.set(r.emoji, (g = { emoji: r.emoji, userIds: [], mine: false }));
            g.userIds.push(r.userId);
            if (r.userId === me) g.mine = true;
          }
          return [...by.values()];
        },
        { equals: compareStructural },
      );
      this.groups.set(targetId, c);
    }
    return c.get();
  }
}
