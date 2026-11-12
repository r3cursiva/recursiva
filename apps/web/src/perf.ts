// Performance marks the perf checks and manual profiling read (tools/perf, DevTools → Performance → Timings).
//   rsva:screen      the issue list first painted with data
//   rsva:nav-start   a project link was clicked
//   rsva:nav-render  the page it opens (the project's home) was committed to the DOM (measure from nav-start)
//   rsva:nav         that page was painted (measure from nav-start; budget 50 ms)

let screenMarked = false;
let navPending = false;

/** Runs after the next paint: rAF fires before the frame is painted, the task queued from it runs after. */
export function afterPaint(fn: () => void): void {
  requestAnimationFrame(() => setTimeout(fn, 0));
}

export function markNavStart(): void {
  performance.clearMarks("rsva:nav-start");
  performance.mark("rsva:nav-start");
  navPending = true;
}

/** Call from useLayoutEffect of the list once it has rendered with data. */
export function listCommitted(): void {
  if (!screenMarked) {
    screenMarked = true;
    afterPaint(() => performance.mark("rsva:screen"));
  }
}

/** Call from useLayoutEffect of the project's home, the page a project link opens, once it has rendered with data. */
export function navCommitted(): void {
  if (!navPending) return;
  navPending = false;
  performance.measure("rsva:nav-render", "rsva:nav-start");
  afterPaint(() => {
    performance.mark("rsva:nav-end");
    performance.measure("rsva:nav", "rsva:nav-start", "rsva:nav-end");
  });
}
