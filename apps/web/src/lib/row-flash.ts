// A row someone else just changed lights up once and fades (PLNR-284): the list is live, and this shows it happening.
//
// Considered (2026-11-05): an observable "changed at" per issue that each row reads and turns into a class needs the
// same code in every list (rows, cards, the archive) and re-renders the row twice, once to light it and once to clear
// the class. Here the engine names the issues and the rows are found by the data-issue every list already carries:
// no render, no state to clear, and any list that marks its rows gets it. Not a lasting mark like the inbox's unread
// ring: a row in a list changes too often for that to mean anything.

const FLASH_MS = 1200;

/** Lights up every row and card of these issues on screen, after the render that shows the change. */
export function flashRows(issueIds: readonly string[]): void {
  // A hidden tab sees nothing now; queued, the frames would all light up at once on coming back.
  if (document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  requestAnimationFrame(() => {
    const root = document.documentElement;
    const signal = getComputedStyle(root).getPropertyValue("--color-signal").trim();
    if (!signal) return;
    // One keyframe at the start: the end is the row's own background, whatever it is (selected, hovered, a card's panel).
    const from = [{ offset: 0, backgroundColor: `color-mix(in oklab, ${signal} 16%, transparent)` }];
    for (const id of issueIds) for (const el of root.querySelectorAll(`[data-issue="${CSS.escape(id)}"]`)) el.animate(from, { duration: FLASH_MS, easing: "ease-out" });
  });
}
