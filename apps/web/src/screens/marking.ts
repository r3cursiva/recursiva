// Marking issues for a bulk action from a click (PLNR-294): the list's rows and the board's cards share it.
import type { MouseEvent } from "react";
import { isPhone } from "../lib/phone.ts";
import { listView } from "./list-view.ts";

/** The issues of the list or board `el` is in, in the order they are on screen. */
export function orderOnScreen(el: Element): string[] {
  const box = el.closest("[data-slot=issue-list], [data-slot=board]") ?? document;
  return [...box.querySelectorAll<HTMLElement>("[data-issue]")].filter((e) => e.checkVisibility()).map((e) => e.dataset.issue!);
}

/**
 * A click that marks instead of opening: with Shift, the issues from the last one marked to this one; on a phone while
 * some are marked, this one in or out (a phone has no Shift, and the bar is open). True when it was such a click.
 */
export function markOnClick(e: MouseEvent<HTMLElement>, id: string): boolean {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.shiftKey) listView.markRange(orderOnScreen(e.currentTarget), id);
  else if (isPhone() && listView.marked.size > 0) listView.toggleMark(id);
  else return false;
  e.preventDefault();
  return true;
}
