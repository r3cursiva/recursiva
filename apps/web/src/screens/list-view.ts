// UI state of the issue list: selection, the issues marked for a bulk action, collapsed groups, the open picker of the
// issue pane.
// Not synced, not persisted.
import type { Issue } from "@rsva/schema/models";
import { computed, makeAutoObservable, observable } from "mobx";
import { useMemo } from "react";
import { typedInto } from "../lib/typing.ts";

export type Picker = "state" | "priority" | "assignees" | "labels";

class ListView {
  selectedId: string | null = null;
  /** The board column an open card is shown in (PLNR-55): the one it was opened from or moved to with ‹ ›. */
  column: string | null = null;
  /** "<projectId>:<group key>" of collapsed groups, so "priority:1" collapses in one project only. */
  readonly collapsed = observable.set<string>();
  /** The issue pane's property picker that is open, so its shortcut and Esc do not leak to the list. */
  picker: Picker | null = null;
  /** Issues marked for a bulk action (PLNR-294): `x`, Shift with a click or an arrow, ⌘A; the bar acts on them. */
  readonly marked = observable.set<string>();
  /** Where a Shift range starts: the issue last marked or unmarked by itself. */
  anchor: string | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  select(id: string | null): void {
    this.selectedId = id;
  }

  setColumn(key: string | null): void {
    this.column = key;
  }

  toggle(key: string): void {
    if (!this.collapsed.delete(key)) this.collapsed.add(key);
  }

  setPicker(p: Picker | null): void {
    this.picker = p;
  }

  toggleMark(id: string): void {
    if (!this.marked.delete(id)) this.marked.add(id);
    this.anchor = id;
  }

  /** Marks the issues from the anchor to `id` in `order` (the list as shown), keeping the anchor. */
  markRange(order: readonly string[], id: string): void {
    const from = this.anchor ? order.indexOf(this.anchor) : -1;
    const to = order.indexOf(id);
    if (from < 0 || to < 0) return this.toggleMark(id);
    for (const i of order.slice(Math.min(from, to), Math.max(from, to) + 1)) this.marked.add(i);
  }

  markAll(ids: Iterable<string>): void {
    for (const id of ids) this.marked.add(id);
  }

  clearMarks(): void {
    this.marked.clear();
    this.anchor = null;
  }
}

export const listView = new ListView();

/** Re-renders the caller only when this row's own selection flips, not on every selection change. */
/** S, P, A, L: the property a key picks, on an open issue and on a home widget's row. */
export const PICKER_KEYS: Record<string, Picker> = { s: "state", p: "priority", a: "assignees", l: "labels" };

/** Keys an open issue leaves alone: with a modifier, while a picker is open, or typed into a field, menu or dialog. */
export function ignoredKey(e: KeyboardEvent, alt = false): boolean {
  if (e.metaKey || e.ctrlKey || (e.altKey && !alt) || listView.picker) return true;
  // An arrow in a row or a column of buttons moves along it (lib/areas.ts, PLNR-304), not through the list.
  if (/^(Arrow|Home$|End$)/.test(e.key) && e.target instanceof Element && e.target.closest("[data-roving=row], [data-roving=column]")) return true;
  return typedInto(e);
}

/** S, P, A, L on an open issue open that property's picker; false for any other key, or when the issue is in the trash. */
export function pickerKey(e: KeyboardEvent, issue: Issue | undefined): boolean {
  const picker = !e.shiftKey && !issue?.deletedAt && PICKER_KEYS[e.key.toLowerCase()];
  if (picker) listView.setPicker(picker);
  return !!picker;
}

/** An issue's row or card on screen: the hidden board keeps its cards in the DOM. */
export function shownIssue(id: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-issue="${id}"]`)) if (el.checkVisibility()) return el;
  return null;
}

export function useIsSelected(id: string): boolean {
  return useMemo(() => computed(() => listView.selectedId === id), [id]).get();
}

/** Re-renders the caller only when this issue's own mark flips. */
export function useIsMarked(id: string): boolean {
  return useMemo(() => computed(() => listView.marked.has(id)), [id]).get();
}
