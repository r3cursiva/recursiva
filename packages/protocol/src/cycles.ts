// A cycle's burn-up (PLNR-63): GET /sync/cycle-progress/:cycleId?tz=<IANA zone>, JSON.
//
// Days that are over never change, so the server reads them from the log once and the answer for a day can be kept; the
// day in progress is not in it: the client counts it from the issues it holds, live with every delta. A completed
// cycle's series is frozen in its summary and needs no request. Days are the viewer's (`tz`, UTC without it), as the
// client counts today (RSVA-528); a summary's are those of who completed the cycle.

/**
 * Counts at the cycle's first moment, then at the end of each day from `start` on: issues in the cycle, those of them
 * started or done, and done (completed). Cancelled issues count in scope only; the percentage done leaves them out
 * (doneShare).
 */
export interface CycleProgress {
  start: string;
  scope: number[];
  started: number[];
  done: number[];
}

/** Done ÷ (scope − cancelled), as a whole percentage; 0 for an empty cycle. */
export function doneShare(done: number, scope: number, cancelled: number): number {
  const base = scope - cancelled;
  return base > 0 ? Math.round((done / base) * 100) : 0;
}
