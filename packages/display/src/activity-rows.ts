// What an issue's activity puts between its items: day marks, the mark of what is new, a run of state changes folded into
// one row, corrections of one field folded into their result, and the changes of one act joined into one line. The same
// on a phone and a wide pane, the web and the TUI; no drawing here.
import { dayLabel } from "./time.ts";

/** What the layout reads of an item. `move`: a state change, which folds. */
export interface FeedItem {
  at: string;
  by: string | null;
  move?: unknown;
}

/** What the two below read of an issue's feed. */
interface LoadedFeed {
  threads: readonly { comment: { id: string; createdAt: string }; replies: readonly { id: string }[] }[];
  history: readonly { at: string }[];
}

/** The comment is among the pages loaded. */
export const feedHolds = (feed: LoadedFeed, id: string): boolean => feed.threads.some((t) => t.comment.id === id || t.replies.some((r) => r.id === id));

/** The pages loaded go back to `at`: a comment of that time that is not among them is gone, and no older page will have it. */
export function feedReaches(feed: LoadedFeed, at: string): boolean {
  const first = [...feed.history.slice(0, 1).map((h) => h.at), ...feed.threads.map((t) => t.comment.createdAt)].sort()[0];
  return first !== undefined && first <= at;
}

/** Oldest first, for items already in the order they came in: a sort keeps that order between equal times. */
export const byTime = (a: { at: string }, b: { at: string }): number => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

/** The comments of a feed's threads, as its counts say: a deleted comment kept for its replies is not one. */
export const commentCount = (threads: readonly { comment: { deletedAt: string | null }; replies: readonly unknown[] }[]): number =>
  threads.reduce((n, t) => n + (t.comment.deletedAt ? 0 : 1) + t.replies.length, 0);

export type FeedRow<T> =
  | { kind: "day"; key: string; label: string }
  | { kind: "new"; key: string; count: number }
  | { kind: "fold"; items: T[] }
  | { kind: "item"; item: T };

/** A run of this many state changes by one person reads as one line. */
const FOLD_AT = 3;
/** The changes of a run stand no further apart than this: a back-and-forth, not a week's work. */
const FOLD_GAP_MS = 10 * 60 * 1000;
/** Field changes by one person within this long are one act. */
const ACT_MS = 60 * 1000;

const gap = (a: FeedItem, b: FeedItem) => Date.parse(b.at) - Date.parse(a.at);

/** The index of the last item of the run that starts at `i`: the next item belongs while `stays(last, next)`. */
function runEnd<T>(items: readonly T[], i: number, stays: (last: T, next: T) => boolean): number {
  let end = i;
  while (end + 1 < items.length && stays(items[end]!, items[end + 1]!)) end++;
  return end;
}

/** Day marks, the new-activity mark and folded runs between the items, oldest first. `since`: the viewer's last visit. */
export function layOut<T extends FeedItem>(items: readonly T[], now: number, since: string | null, me: string | null | undefined): FeedRow<T>[] {
  const rows: FeedRow<T>[] = [];
  const fresh = since ? items.filter((it) => it.at >= since && it.by !== me).length : 0;
  let day = "";
  let marked = fresh === 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const label = dayLabel(it.at, now);
    if (label !== day) rows.push({ kind: "day", key: `day:${(day = label)}`, label });
    if (!marked && it.at >= since!) {
      marked = true;
      rows.push({ kind: "new", key: "new", count: fresh });
    }
    const end = it.move ? runEnd(items, i, (last, next) => !!next.move && next.by === it.by && gap(last, next) < FOLD_GAP_MS && dayLabel(next.at, now) === label) : i;
    if (end + 1 - i >= FOLD_AT) {
      rows.push({ kind: "fold", items: items.slice(i, end + 1) });
      i = end;
    } else rows.push({ kind: "item", item: it });
  }
  return rows;
}

/**
 * Neighbouring items `joins` accepts, by one person within a minute, as one item made by `merge`: "set the priority,
 * added it to a cycle and set the due date" is one act, however many fields and requests it took.
 */
export function joinActs<T extends FeedItem>(items: readonly T[], joins: (it: T) => boolean, merge: (run: T[]) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < items.length; i++) {
    const first = items[i]!;
    const end = joins(first) ? runEnd(items, i, (_, next) => joins(next) && next.by === first.by && gap(first, next) < ACT_MS) : i;
    out.push(end > i ? merge(items.slice(i, end + 1)) : first);
    i = end;
  }
  return out;
}

/** A change of one single-value field: what it was and what it became. */
export interface Edit {
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * Neighbouring changes of one field by one person, each under a minute after the one before, as one change from the
 * first value to the last: a correction reads as its result, and a run that came back to where it started says nothing.
 * Measured between neighbours, so a slow run stays whole. `merge` makes the item that stands for the run from its first
 * item and the whole change; it takes the time of the run's last change.
 */
export function foldEdits<T extends FeedItem & { edit?: Edit }>(items: readonly T[], merge: (first: T, edit: Edit) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < items.length; i++) {
    const first = items[i]!;
    const edit = first.edit;
    const end = edit ? runEnd(items, i, (last, next) => next.edit?.field === edit.field && next.by === first.by && gap(last, next) < ACT_MS) : i;
    if (end === i) {
      out.push(first);
      continue;
    }
    const last = items[end]!;
    const to = last.edit!.to;
    if ((edit!.from ?? null) !== (to ?? null)) out.push({ ...merge(first, { ...edit!, to }), at: last.at });
    i = end;
  }
  return out;
}
