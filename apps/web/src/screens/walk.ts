// Walking issues with the pane open, without the pane jumping (PLNR-82). An issue's description, comments and history
// are not in the snapshot: a step onto one not read yet would paint placeholders and move everything under them when
// the answer lands. So the neighbours load ahead of the walk, and on a miss the pane stays on the issue it shows until
// the next one is ready or the wait is over; either way it swaps in one paint. The list's selection moves at once.
import type { Issue, Project } from "@rsva/schema/models";
import { useEffect, useState } from "react";
import { store } from "../store.ts";
import { walkOrder } from "./issue-list.tsx";
import { listView } from "./list-view.ts";

/** Issues loaded on each side of the open one: two keep up with a step every 200 ms at the owner's 280 ms of latency. */
const AHEAD = 2;
/** A held key repeats faster than this, so it loads nothing ahead of itself. */
const WALK_PAUSE_MS = 100;
/** The longest the pane stays behind: a round trip to the server and its answer. After it, placeholders. */
const HOLD_MS = 400;

/** Loads the issues around `id` in the order J/K walk, once the walk pauses. */
export function useWalkAhead(project: Project, id: string | null): void {
  useEffect(() => {
    if (!id) return;
    const t = setTimeout(() => {
      const rows = walkOrder(project, id);
      const at = rows.findIndex((i) => i.id === id);
      if (at >= 0) for (const i of rows.slice(Math.max(0, at - AHEAD), at + AHEAD + 1)) store.feed(i.id);
    }, WALK_PAUSE_MS);
    return () => clearTimeout(t);
  }, [project, id]);
}

/** What the pane shows for the open issue, and whether it got there from another issue. Call from an observer. */
export function useSteadyIssue(open: Issue | null): { issue: Issue | null; walked: boolean } {
  const [pane, setPane] = useState({ issue: open, walked: false });
  const swap = () => setPane({ issue: open, walked: !!pane.issue && !!open });
  const behind = open?.id !== pane.issue?.id;
  // Nothing to keep beside a closed pane or another project, and a picker's key acts on the open issue.
  if (behind && (!pane.issue || !open || open.projectId !== pane.issue.projectId || listView.picker || store.feed(open.id).status !== "loading")) swap();
  useEffect(() => {
    if (!behind) return;
    const t = setTimeout(swap, HOLD_MS);
    return () => clearTimeout(t);
  }, [open?.id, behind]); // eslint-disable-line react-hooks/exhaustive-deps
  return pane;
}
