// The viewer's inbox on the client (PLNR-26). Events come once from the server (the `inbox` frame), then from the
// engine's own deltas through the same classifier the server runs (packages/protocol/src/inbox.ts); marks are applied
// here at once and confirmed by the server's `marks` echo, like issue edits. The whole of it is saved with the snapshot,
// so a warm start shows the inbox before any network and asks only for marks set elsewhere meanwhile. Subscribe and
// Unsubscribe (PLNR-28) are marks as well, so they travel and settle the same way.
import { mayManage } from "@rsva/policy";
import { blankMark, commentLine, INBOX_DAYS, INBOX_MAX, inboxEvent, isReviewer, inboxGroups, markArchived, markRead, type Action, type ClientFrame, type InboxEvent, type InboxFrame, type InboxMark, type MarksFrame } from "@rsva/protocol";
import { isLiveIssue, startedStage, type Issue } from "@rsva/schema/models";
import { computed, makeObservable, observable, observableRef, runInAction } from "mobx";
import type { Pool } from "./pool.ts";
import type { InboxRow, InboxStore, Subscription } from "./store.ts";

/** What the snapshot copy in IndexedDB keeps of the inbox: the last answer, as the server sent it, and what is local. */
export interface SavedInbox extends Omit<InboxFrame, "t" | "s"> {
  /** Marks set here that the server has not echoed yet: sent again on the next connection. */
  p: InboxMark[];
  /** The last answer's cut (missing in a copy saved before it existed). */
  s?: number;
  /** What its events hold (SAVED_EVENTS); a copy without it, or with an older one, is shown and then asked for anew. */
  v?: number;
}

/** 1: a comment's event carries its first line (RSVA-571). */
const SAVED_EVENTS = 1;

const EPOCH = "1970-01-01T00:00:00Z";
/** More deltas than the server's catch-up limit before the first answer means a new snapshot anyway. */
const EARLY_MAX = 5000;
/** A mark's subscription fields, or none when the viewer never chose. */
const subscriptionOf = ({ subscribed, subscribedId }: InboxMark) => (subscribed === undefined ? {} : { subscribed, subscribedId: subscribedId ?? 0 });
const sameMark = (a: InboxMark, b: InboxMark) =>
  a.readId === b.readId &&
  a.archivedId === b.archivedId &&
  a.snoozedId === b.snoozedId &&
  (a.snoozedUntil === null ? b.snoozedUntil === null : b.snoozedUntil !== null && Date.parse(a.snoozedUntil) === Date.parse(b.snoozedUntil)) &&
  a.subscribed === b.subscribed &&
  a.subscribedId === b.subscribedId;

export class Inbox implements InboxStore {
  status: InboxStore["status"] = "loading";
  private events: InboxEvent[] = [];
  private readonly marks = observable.map<string, InboxMark>({}, { deep: false });
  /** Marks set here and not echoed yet, and the server's values under them (what the saved copy keeps). */
  private readonly pending = new Map<string, InboxMark>();
  private readonly serverMarks = new Map<string, InboxMark>();
  private commented = new Set<string>();
  private threads = new Set<string>();
  private at: string | null = null;
  /** Bumped when a snooze ends, so rows read the clock again. */
  private tick = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly pool: Pool;
  private readonly me: () => string;
  /** The viewer's role in the workspace: whoever manages it reviews the agents' issues. */
  private readonly role: () => string | null;
  /** The engine's lastSyncId: where a subscription choice starts. */
  private readonly head: () => number;
  private readonly send: (f: ClientFrame) => void;
  private readonly changed: () => void;

  constructor(pool: Pool, me: () => string, role: () => string | null, head: () => number, send: (f: ClientFrame) => void, changed: () => void) {
    this.pool = pool;
    this.me = me;
    this.role = role;
    this.head = head;
    this.send = send;
    this.changed = changed;
    makeObservable<Inbox, "events" | "tick">(this, { status: observable, events: observableRef, tick: observable, rows: computed, unread: computed });
  }

  get rows(): InboxRow[] {
    void this.tick;
    const issues = this.pool.maps.Issue;
    const live = (id: string) => {
      const i = issues.get(id);
      return !!i && isLiveIssue(i);
    };
    return inboxGroups(this.events, (id) => this.marks.get(id), Date.now(), live).map(({ issueId, ...g }) => ({ ...g, issue: issues.get(issueId)!, kinds: new Set(g.events.map((e) => e.kind)) }));
  }

  get unread(): number {
    return this.rows.filter((r) => r.unread && !r.snoozedUntil).length;
  }

  read(issueIds: readonly string[], read = true): void {
    this.set(
      this.rowsOf(issueIds).map((r) => markRead(this.markOf(r.issue.id), r.latest.id, read)),
    );
  }

  archive(issueIds: readonly string[]): void {
    this.set(this.rowsOf(issueIds).map((r) => markArchived(this.markOf(r.issue.id), r.latest.id)));
  }

  snooze(issueId: string, until: Date | null): void {
    const r = this.rowsOf([issueId])[0];
    if (!r) return;
    const m = this.markOf(issueId);
    this.set([until ? { ...m, snoozedId: r.latest.id, snoozedUntil: until.toISOString() } : { ...m, snoozedId: 0, snoozedUntil: null }]);
  }

  subscription(issue: Issue): Subscription {
    const me = this.me();
    const involved = issue.assigneeIds.includes(me) ? "assignee" : issue.createdById === me ? "creator" : this.commented.has(issue.id) ? "commenter" : null;
    const { subscribed } = this.markOf(issue.id);
    return { following: subscribed ?? involved !== null, chosen: subscribed !== undefined, involved };
  }

  subscribe(issueId: string, on: boolean): void {
    this.set([{ ...this.markOf(issueId), subscribed: on, subscribedId: this.head() }]);
  }

  marksOf(issueIds: readonly string[]): InboxMark[] {
    return issueIds.map((id) => this.markOf(id));
  }

  /** Puts marks back as they were (undo); a subscription chosen since stays. */
  restore(marks: readonly InboxMark[]): void {
    const back = marks.map(({ subscribed: _, subscribedId: __, ...m }) => ({ ...m, ...subscriptionOf(this.markOf(m.issueId)) }));
    this.set(back.filter((m) => !sameMark(m, this.markOf(m.issueId))));
  }

  // ── Engine side ─────────────────────────────────────────────────────────────────────────────────────────────

  /** Holds every event up to the engine's lastSyncId: a connection asks only for newer marks. */
  private based = false;
  /** The last answer's cut: a delta at or below it is already in its events (the fan-out may deliver it after). */
  private cut = 0;
  /** Deltas applied before the first answer, classified once its context (comments, threads) is here. */
  private early: { a: Action; prev: readonly string[] | undefined; was?: string | null | undefined }[] = [];

  /** After `sub`: the whole inbox, or only marks set elsewhere since the last, then marks still unconfirmed. */
  request(): void {
    this.send(this.based ? { t: "inbox", at: this.at ?? EPOCH } : { t: "inbox" });
    if (this.pending.size) this.send({ t: "mark", m: [...this.pending.values()] });
  }

  /** A mark the server has not echoed: it reaches the disk only with the snapshot (persistDelay later). */
  get unconfirmed(): boolean {
    return this.pending.size > 0;
  }

  /** A new snapshot skipped deltas: events may be missing, so the next request asks for everything. */
  invalidate(): void {
    this.based = false;
  }

  load(saved: SavedInbox): void {
    this.commented = new Set(saved.c);
    this.threads = new Set(saved.th);
    this.at = saved.at;
    this.cut = saved.s ?? 0;
    runInAction(() => {
      this.events = trim(saved.e);
      this.marks.replace(saved.m.map((m) => [m.issueId, m] as const));
      for (const p of saved.p) {
        this.serverMarks.set(p.issueId, this.markOf(p.issueId));
        this.pending.set(p.issueId, p);
        this.marks.set(p.issueId, p);
      }
      this.status = "ready";
      // Events saved before they held what they hold now are shown at once and replaced by the next answer.
      this.based = saved.v === SAVED_EVENTS;
    });
    this.schedule();
  }

  save(): SavedInbox | undefined {
    if (!this.based) return undefined;
    const m = [...this.marks.values()].map((x) => (this.pending.has(x.issueId) ? this.serverMarks.get(x.issueId)! : x));
    return { e: this.events, m, c: [...this.commented], th: [...this.threads], at: this.at, p: [...this.pending.values()], s: this.cut, v: SAVED_EVENTS };
  }

  onInbox(f: InboxFrame): void {
    for (const c of f.c) this.commented.add(c);
    for (const t of f.th) this.threads.add(t);
    this.at = f.at;
    this.cut = f.s;
    const early = this.early;
    this.early = [];
    runInAction(() => {
      this.events = trim([...f.e, ...this.events.filter((e) => e.id > f.s)]);
      this.serverMarks.clear();
      this.marks.replace(f.m.map((m) => [m.issueId, m] as const));
      for (const p of this.pending.values()) {
        this.serverMarks.set(p.issueId, this.marks.get(p.issueId) ?? blankMark(p.issueId));
        this.marks.set(p.issueId, p);
      }
      this.status = "ready";
      this.based = true;
      for (const x of early) if (x.a.id > f.s) this.classify(x.a, x.prev, x.was);
    });
    this.schedule();
    this.changed();
  }

  onMarks(f: MarksFrame): void {
    if (!this.at || f.at > this.at) this.at = f.at;
    runInAction(() => {
      for (const m of f.m) {
        const p = this.pending.get(m.issueId);
        if (p) {
          // An echo of an older write of ours, or someone else's: ours, sent later, wins on the server too.
          this.serverMarks.set(m.issueId, m);
          if (!sameMark(p, m)) continue;
          this.pending.delete(m.issueId);
          this.serverMarks.delete(m.issueId);
        }
        this.marks.set(m.issueId, m);
      }
    });
    this.schedule();
    this.changed();
  }

  /** A refused mark (bad issue id): start over from the server's inbox. */
  onRejected(): void {
    this.pending.clear();
    this.serverMarks.clear();
    this.invalidate();
    this.send({ t: "inbox" });
  }

  /**
   * Every applied delta, after the engine applied it. `prevAssignees`: the issue's server assignees before the action.
   * The viewer's own comments feed the classifier's context; everyone else's actions may become events.
   */
  observe(a: Action, prevAssignees: readonly string[] | undefined, prevStateId?: string | null): void {
    // A description counts only when it mentions someone; the others (whole documents) are not kept for the classifier.
    if (a.id <= this.cut || (a.m !== "Issue" && a.m !== "Comment" && !(a.m === "Document" && a.d?.mentionIds))) return;
    if (!this.based) {
      if (this.early.length < EARLY_MAX) this.early.push({ a, prev: prevAssignees, was: prevStateId });
      return;
    }
    this.classify(a, prevAssignees, prevStateId);
  }

  private classify(a: Action, prevAssignees: readonly string[] | undefined, prevStateId?: string | null): void {
    const me = this.me();
    // Events are in log order and complete up to the newest one: an older action is already counted, or is not one.
    if (!me || a.id <= (this.events.at(-1)?.id ?? 0)) return;
    if (a.m === "Comment" && a.a === "I" && a.by === me) {
      this.commented.add(a.d?.issueId as string);
      this.threads.add((a.d?.parentId as string | null | undefined) ?? a.mid);
      return;
    }
    // An edited comment reads anew in the events it made: an agent's comment arrives empty and is filled by an edit.
    if (a.m === "Comment" && a.a === "U" && typeof a.d?.body === "string") this.retext(a.mid, commentLine(a.d.body));
    const at = ((a.m === "Comment" ? (a.d?.editedAt ?? a.d?.createdAt) : a.d?.updatedAt) as string | undefined) ?? new Date().toISOString();
    const e = inboxEvent(a, prevAssignees, at, {
      me,
      issue: (id) => this.pool.maps.Issue.get(id),
      stage: (id) => {
        const s = this.pool.maps.WorkflowState.get(id);
        return s ? startedStage(this.pool.statesOf(s.projectId), id) : undefined;
      },
      group: (id) => this.pool.maps.WorkflowState.get(id)?.group,
      reviews: (id) => {
        const by = this.pool.maps.Issue.get(id)?.createdById ?? null;
        return isReviewer(me, mayManage(this.role()), by, !!by && this.pool.maps.User.get(by)?.kind === "agent");
      },
      commented: (id) => this.commented.has(id),
      inThread: (id) => this.threads.has(id),
      mark: (id) => this.marks.get(id),
    }, prevStateId);
    if (e) runInAction(() => (this.events = trim([...this.events, e])));
  }

  /** Gives the events of a comment its line as it reads now. */
  private retext(commentId: string, text: string): void {
    if (!this.events.some((e) => e.commentId === commentId && (e.text ?? "") !== text)) return;
    runInAction(() => {
      this.events = this.events.map((e) => {
        if (e.commentId !== commentId) return e;
        const { text: _was, ...rest } = e;
        return text ? { ...rest, text } : rest;
      });
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  // ── Internals ───────────────────────────────────────────────────────────────────────────────────────────────

  private markOf(issueId: string): InboxMark {
    return this.marks.get(issueId) ?? blankMark(issueId);
  }

  private rowsOf(issueIds: readonly string[]) {
    const ids = new Set(issueIds);
    return this.rows.filter((r) => ids.has(r.issue.id));
  }

  private set(marks: InboxMark[]): void {
    if (!marks.length) return;
    runInAction(() => {
      for (const m of marks) {
        if (!this.pending.has(m.issueId)) this.serverMarks.set(m.issueId, this.markOf(m.issueId));
        this.pending.set(m.issueId, m);
        this.marks.set(m.issueId, m);
      }
    });
    this.send({ t: "mark", m: marks });
    this.schedule();
    this.changed();
  }

  /** Wakes the rows when the nearest snooze ends. */
  private schedule(): void {
    clearTimeout(this.timer);
    const now = Date.now();
    let next = Infinity;
    for (const m of this.marks.values()) {
      const t = m.snoozedUntil ? Date.parse(m.snoozedUntil) : Infinity;
      if (t > now && t < next) next = t;
    }
    // setTimeout holds 32 bits of milliseconds: a snooze weeks away is re-checked daily.
    if (next !== Infinity) this.timer = setTimeout(() => (runInAction(() => this.tick++), this.schedule()), Math.min(next - now + 50, 86_400_000));
  }
}

/** The window the server reads, kept on the client too: the last INBOX_DAYS, at most INBOX_MAX, oldest first. */
function trim(events: InboxEvent[]): InboxEvent[] {
  const from = Date.now() - INBOX_DAYS * 86_400_000;
  const kept = events.filter((e) => Date.parse(e.at) >= from);
  return kept.length > INBOX_MAX ? kept.slice(-INBOX_MAX) : kept;
}
