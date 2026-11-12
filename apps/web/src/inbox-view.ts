// How the viewer looks at the inbox: the filter, display options and its tab (all, unread). Saved per viewer in
// localStorage, like a project's view (view-state.ts), so a reload opens the inbox as it was left. One for every
// workspace since the inbox lists them all (RSVA-613); before, one per workspace, and the open one's is taken over.
//
// It also keeps what the screen needs across a move to another workspace: a row of another workspace opens in the pane
// once the address is that workspace's, and the screen is remounted on its engine (App.tsx keys it by workspace).
import { STATE_GROUP_ORDER } from "@rsva/query";
import { makeAutoObservable, observableRef } from "mobx";
import { readLocal } from "./lib/local-storage.ts";
import { currentWs, store } from "./store.ts";
import { DEFAULT_INBOX_DISPLAY, INBOX_GROUP_OPTIONS, INBOX_ORDER_OPTIONS, KIND_LABELS, type InboxDisplay, type InboxFilter } from "./lib/inbox.ts";
import { persistForViewer } from "./viewer-local.ts";

/**
 * The inbox's tabs: every notification, or the unread ones. The FramedInbox artboard's third, Waiting on you, went
 * (RSVA-571): it counted notifications that offer a move while My work counts what waits, and the two disagreed. What
 * to do is My work; the inbox is what happened. A saved "waiting" opens as all.
 */
export type InboxShow = "all" | "unread";
const SHOWS: readonly InboxShow[] = ["all", "unread"];

export class InboxView {
  filter: InboxFilter = {};
  display: InboxDisplay = DEFAULT_INBOX_DISPLAY;
  show: InboxShow = "all";
  /** The header panel that is open; f and v open them from the list. */
  panel: "filter" | "display" | null = null;

  // ── This visit: kept while the inbox moves between workspaces, dropped when the inbox is entered anew ──────────────
  /** The open row's issue. */
  selected: string | null = null;
  /** Rows read on this visit: they stay in Unread until the tab is left. */
  readHere: ReadonlySet<string> = new Set();
  /** What was read of a row when it was first opened on this visit (RSVA-575). Not observed: read when a pane opens. */
  readBefore = new Map<string, number>();
  /** Workspaces whose read notifications of finished issues were archived on this visit. */
  swept = new Set<string>();
  /** The list's scroll when the inbox moved to another workspace. */
  scrollTop = 0;
  /** Set just before the inbox moves to another workspace to open `selected` there. */
  private moving = false;

  constructor() {
    makeAutoObservable<InboxView, "moving">(this, { filter: observableRef, display: observableRef, readHere: observableRef, readBefore: false, swept: false, moving: false });
  }

  /** The inbox comes on screen: a visit goes on after a move to another workspace, else a new one starts. Says which. */
  arrive(): boolean {
    if (this.moving) {
      this.moving = false;
      return true;
    }
    this.selected = null;
    this.readHere = new Set();
    this.readBefore = new Map();
    this.swept = new Set();
    this.scrollTop = 0;
    return false;
  }

  /** The inbox is about to move to another workspace to open `issueId` there. */
  moveTo(issueId: string, scrollTop: number): void {
    this.moving = true;
    this.selected = issueId;
    this.scrollTop = scrollTop;
  }

  select(issueId: string | null): void {
    this.selected = issueId;
  }

  readOnVisit(issueId: string): void {
    this.readHere = new Set(this.readHere).add(issueId);
  }

  clearReadHere(): void {
    this.readHere = new Set();
  }

  setFilter(filter: InboxFilter): void {
    this.filter = filter;
  }

  setDisplay(patch: Partial<InboxDisplay>): void {
    this.display = { ...this.display, ...patch };
  }

  setShow(show: InboxShow): void {
    this.show = show;
  }

  setPanel(panel: InboxView["panel"]): void {
    this.panel = panel;
  }
}

/** The shape of what is saved: 2 since days became the default grouping. */
const SAVED = 2;

const strings = (v: unknown, ok: (s: string) => boolean = () => true): string[] | undefined => {
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && ok(x)) : [];
  return list.length ? list : undefined;
};

/** Takes what an older or tampered save holds only where it fits the current shape. */
function restore(view: InboxView, saved: unknown): void {
  if (!saved || typeof saved !== "object") return;
  const s = saved as { filter?: Record<string, unknown>; display?: Partial<Record<keyof InboxDisplay, unknown>>; show?: unknown; unreadOnly?: unknown; v?: unknown };
  const f = s.filter ?? {};
  const filter: InboxFilter = {};
  const kind = strings(f.kind, (k) => k in KIND_LABELS) as InboxFilter["kind"];
  if (kind) filter.kind = kind;
  const from = strings(f.from);
  if (from) filter.from = from;
  const project = strings(f.project);
  if (project) filter.project = project;
  const workspace = strings(f.workspace);
  if (workspace) filter.workspace = workspace;
  const priority = Array.isArray(f.priority) ? f.priority.filter((p): p is number => Number.isInteger(p) && p >= 0 && p <= 4) : [];
  if (priority.length) filter.priority = priority;
  const groups = strings(f.stateGroup, (g) => (STATE_GROUP_ORDER as readonly string[]).includes(g)) as InboxFilter["stateGroup"];
  if (groups) filter.stateGroup = groups;
  view.setFilter(filter);
  const d = s.display ?? {};
  // "No grouping" saved while it was the default (before SAVED 2) was not a choice: days are the default now (RSVA-571).
  const grouped = INBOX_GROUP_OPTIONS.some((o) => o.value === d.groupBy) && (s.v === SAVED || d.groupBy !== "none");
  view.setDisplay({
    ...(grouped ? { groupBy: d.groupBy as InboxDisplay["groupBy"] } : {}),
    ...(INBOX_ORDER_OPTIONS.some((o) => o.value === d.orderBy) ? { orderBy: d.orderBy as InboxDisplay["orderBy"] } : {}),
    ...(typeof d.showSnoozed === "boolean" ? { showSnoozed: d.showSnoozed } : {}),
    ...(typeof d.unreadFirst === "boolean" ? { unreadFirst: d.unreadFirst } : {}),
  });
  // Saved before the tabs: "unread only" is the Unread tab.
  if (SHOWS.includes(s.show as InboxShow)) view.setShow(s.show as InboxShow);
  else if (s.unreadOnly === true) view.setShow("unread");
}

let view: InboxView | null = null;

/** The inbox's view, created on first use: restored from local storage, then saved on every change. */
export function inboxView(): InboxView {
  if (!view) {
    const v = (view = new InboxView());
    persistForViewer(
      (me) => `rsva:inbox:${me}`,
      // Nothing saved yet: what was saved for the workspace on screen when each workspace had its own.
      (saved) => restore(v, saved ?? readLocal(`rsva:inbox:${store.me!.id}:${currentWs()}`)),
      () => ({ filter: v.filter, display: v.display, show: v.show, v: SAVED }),
    );
  }
  return view;
}
