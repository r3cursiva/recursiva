// The sidebar's pins and ⌘K's recent pages (PLNR-292): a saved view, an issue or a cycle, as `kind:id`. The pins are
// the viewer's on every device (the sync store's Views); the recent ones are this device's, as a palette convenience.
import { pinRef, type PinRef, type SavedView } from "@rsva/protocol";
import { isLiveIssue, type Cycle, type Issue, type Project } from "@rsva/schema/models";
import { compareStructural, reaction } from "mobx";
import { paths, routeIssue, router } from "../router.ts";
import { currentWs, store } from "../store.ts";
import { readLocal, writeLocal } from "./local-storage.ts";
import { viewPath } from "./views.ts";

/** What a pin or a recent page stands for, while it still exists: a deleted view, a deleted or archived issue, a cycle of an archived project give nothing. */
export type PinTarget =
  | { kind: "view"; ref: PinRef; href: string; label: string; view: SavedView }
  | { kind: "issue"; ref: PinRef; href: string; label: string; issue: Issue; key: string }
  | { kind: "cycle"; ref: PinRef; href: string; label: string; cycle: Cycle; project: Project };

export function pinTarget(ws: string, ref: PinRef): PinTarget | undefined {
  const at = ref.indexOf(":");
  const kind = ref.slice(0, at);
  const id = ref.slice(at + 1);
  if (kind === "view") {
    const view = store.views.get(id);
    return view && { kind, ref, href: viewPath(ws, view), label: view.name, view };
  }
  if (kind === "issue") {
    const issue = store.issues.get(id);
    if (!issue || !isLiveIssue(issue) || issue.number === 0) return undefined;
    const key = store.issueKey(issue);
    return { kind, ref, href: paths.browse(ws, key), label: issue.title, issue, key };
  }
  if (kind === "cycle") {
    const cycle = store.cycles.get(id);
    const project = cycle && store.projects.get(cycle.projectId);
    if (!cycle || !project || project.archivedAt) return undefined;
    return { kind, ref, href: paths.cycle(ws, project.key, cycle.number), label: cycle.name, cycle, project };
  }
  return undefined;
}

/** The pins that still stand for something, in the viewer's order. */
export const pinTargets = (ws: string): PinTarget[] => store.views.pins.flatMap((r) => pinTarget(ws, r) ?? []);

/** What the open page shows, as a pin: the open issue, a view's page, a cycle's page. */
export function routePin(): PinRef | undefined {
  const r = router.route;
  const key = routeIssue(r);
  if (key) {
    const issue = store.issueByKey(key);
    return issue && pinRef("issue", issue.id);
  }
  if (r.name === "view") return store.views.get(r.viewId) && pinRef("view", r.viewId);
  if (r.name === "cycle") {
    const project = store.projectByKey(r.projectKey);
    const cycle = project && store.cyclesOf(project.id).find((c) => c.number === r.cycle);
    return cycle && pinRef("cycle", cycle.id);
  }
  return undefined;
}

// ── Recent ──────────────────────────────────────────────────────────────────────────────────────────────────────

const RECENT_MAX = 8;
const recentKey = (ws: string) => `rsva:recent:${ws}`;

/** This device's last pages of the workspace, the newest first. */
export function recentPins(ws: string): PinRef[] {
  const saved = readLocal(recentKey(ws));
  return Array.isArray(saved) ? saved.filter((r): r is PinRef => typeof r === "string") : [];
}

// Each page opened goes to the front; nothing is written on a page that is not one of them.
reaction(
  () => {
    const ref = routePin();
    return ref ? { ws: currentWs(), ref } : null;
  },
  (open) => {
    if (!open) return;
    const was = recentPins(open.ws);
    if (was[0] !== open.ref) writeLocal(recentKey(open.ws), [open.ref, ...was.filter((r) => r !== open.ref)].slice(0, RECENT_MAX));
  },
  { fireImmediately: true, equals: compareStructural },
);
