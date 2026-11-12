// Opening an issue beside its project's list or board column, and closing it, as one motion (PLNR-56): the list or the
// board narrows into its column, the issue pane slides in, and the open row or card moves to its place in the column.
//
// The browser's View Transitions API, called directly. React's <ViewTransition> animates only updates made inside
// startTransition, and our screens re-render through MobX (mobx-react-lite reads it with useSyncExternalStore), whose
// updates React always applies synchronously: so the route changes inside flushSync, in the transition's callback.
// Snapshots are animated by the compositor, so nothing is laid out again per frame, unlike the width transition the
// list used before. Walking issues (J/K, ←/→) replaces the route and stays instant; reduced motion and browsers
// without the API switch at once.
import { flushSync } from "react-dom";
import { routeIssue, router, type Route } from "../router.ts";
import { store } from "../store.ts";
import { shownIssue } from "./list-view.ts";
import { canAnimate, settle } from "./view-transition.ts";

/** Open or close: the same project's list with and without an issue beside it. */
function kindOf(from: Route, to: Route): "open" | "close" | null {
  if (from.name === "issues" && to.name === "listIssue") return from.ws === to.ws && from.projectKey === to.projectKey ? "open" : null;
  if (from.name === "listIssue" && to.name === "issues") return from.ws === to.ws && from.projectKey === to.projectKey ? "close" : null;
  return null;
}

/** Where the row's or card's title is: a narrowed row keeps its left edge but drops cells before the title. */
const titleBox = (el: HTMLElement | null) => (el?.querySelector("a") ?? el)?.getBoundingClientRect();

function play(from: Route, to: Route, apply: () => void): void {
  const kind = kindOf(from, to);
  if (!kind || !canAnimate()) return apply();
  const key = routeIssue(kind === "open" ? to : from);
  const id = key ? store.issueByKey(key)?.id : undefined;
  const root = document.documentElement;
  // The panes are named only while a transition runs (index.css), so the inbox's split view never takes part.
  root.dataset.vt = kind;
  let moving = id ? shownIssue(id) : null;
  const before = titleBox(moving);
  moving?.style.setProperty("view-transition-name", "split-item");
  const t = document.startViewTransition(async () => {
    flushSync(apply);
    moving?.style.removeProperty("view-transition-name");
    // The board's column and the issue pane are lazy: wait for the row or card.
    if (id) await settle(() => !!shownIssue(id));
    moving = id ? shownIssue(id) : null;
    moving?.style.setProperty("view-transition-name", "split-item");
    // How far the open row or card moved: the list pane's two snapshots move by as much, so their rows stay on top of
    // each other instead of showing twice, and the board slides its card's column to where the column now is.
    const after = titleBox(moving);
    root.style.setProperty("--vt-dx", `${before && after ? after.left - before.left : 0}px`);
    root.style.setProperty("--vt-dy", `${before && after ? after.top - before.top : 0}px`);
  });
  void t.finished.finally(() => {
    moving?.style.removeProperty("view-transition-name");
    if (root.dataset.vt !== kind) return;
    delete root.dataset.vt;
    root.style.removeProperty("--vt-dx");
    root.style.removeProperty("--vt-dy");
  });
}

router.animate = play;
