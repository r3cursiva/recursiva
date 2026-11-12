// The keys every list screen shares (RSVA-425): J/K and ↑/↓ step through the rows (lib/step-keys.ts), Enter goes in, Esc
// goes out, and the screen's handler listens on the window for as long as the screen is mounted.
import type { Issue } from "@rsva/schema/models";
import { useEffect, useRef } from "react";
import { stepKey } from "../lib/step-keys.ts";
import { pickerKey } from "./list-view.ts";
import { subscribeKey } from "./subscription.ts";

type KeyHandler = (e: KeyboardEvent) => void;

// Capture handlers share one listener and run newest first: a pane's own keys mount after the list beside it and come
// before it, so E on the comment under the pointer edits the comment instead of archiving the notification (before RSVA-425
// the Inbox kept that order by adding its listener anew on every render). One that stops the event
// (stopImmediatePropagation) stops the older ones too. The listener moves to the end of the window's list on every mount,
// so it stays after the ones added before it (lib/areas.ts, the overlays), as each screen's own listener did.
const captured: { current: KeyHandler }[] = [];
const dispatch = (e: KeyboardEvent) => {
  // A copy: a key that closes a screen must not shift the ones still to run.
  for (const h of captured.toReversed()) {
    if (e.cancelBubble) return;
    h.current(e);
  }
};

/**
 * The screen's keys on the window while it is mounted, always with the handler of its latest render, so the handler may
 * read props and state without listing them. Capture runs before Base UI closes a popup on Esc, so a picker's Esc does
 * not also close the issue.
 */
export function useWindowKeys(handler: KeyHandler, capture = false): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!capture) {
      const onKey = (e: KeyboardEvent) => latest.current(e);
      addEventListener("keydown", onKey);
      return () => removeEventListener("keydown", onKey);
    }
    captured.push(latest);
    removeEventListener("keydown", dispatch, true);
    addEventListener("keydown", dispatch, true);
    return () => {
      captured.splice(captured.indexOf(latest), 1);
    };
  }, [capture]);
}

interface PaneKeys {
  /** J/K and ↑/↓; without it they are not this screen's. */
  move?: ((by: 1 | -1) => void) | undefined;
  /** Enter goes in; false when there was nothing to go into. */
  enter?: (() => boolean) | undefined;
  /** Elements that take their own Enter. */
  ownEnter?: string;
  /** Esc goes out. */
  leave?: (() => void) | undefined;
  /** The open issue: S, P, A, L open its pickers, Shift+S subscribes. */
  issue?: Issue | undefined;
}

/**
 * The keys of a list beside its issue (a project's list, the Inbox) and of the issue's page: true when the key was one of
 * them and has been acted on, so the caller prevents its default.
 */
export function paneKeys(e: KeyboardEvent, key: string, { move, enter, ownEnter = "button, [data-slot=split-detail]", leave, issue }: PaneKeys): boolean {
  const by = stepKey(key);
  if (by) {
    if (!move) return false;
    move(by);
    return true;
  }
  if (key === "Enter") return !!enter && !(e.target as Element).closest(ownEnter) && enter();
  if (key === "Escape") return !!leave && (leave(), true);
  return !!issue && (pickerKey(e, issue) || subscribeKey(e, issue));
}
