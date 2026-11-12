// What the list pane's view transitions share (index.css): opening and closing an issue beside the list
// (split-transition.ts), and list ↔ board.
//
// Compared for list ↔ board: a fade-in on the new layout's mount (no JS, but the old one vanishes at once, and the
// board's Activity replays the animation each time it is shown again); a view transition (chosen): the old and new
// panes cross-fade as snapshots, with the code already here for the split. Tabs switch at once: they are walked often,
// and a transition blocks clicks while it plays (their underline slides by CSS, view-tabs.tsx).
import { flushSync } from "react-dom";

/** The API is there and the person has not asked for less motion. */
export const canAnimate = (): boolean => !!document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Lazy parts render their fallback first while the browser holds the old frame: waits for `ready`, at most 100 ms. */
export async function settle(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 10 && !ready(); i++) await new Promise((r) => setTimeout(r, 10));
}

/** List ↔ board: the pane cross-fades. */
export function swapLayout(apply: () => void, ready?: () => boolean): void {
  if (!canAnimate()) return apply();
  const root = document.documentElement;
  root.dataset.vt = "layout";
  const t = document.startViewTransition(async () => {
    flushSync(apply);
    if (ready) await settle(ready);
  });
  void t.finished.finally(() => {
    if (root.dataset.vt === "layout") delete root.dataset.vt;
  });
}
