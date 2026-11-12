// Plane's list layout: the groups of runQuery (by the project's view), collapsible, one dense row per issue showing
// the display properties the view has on, each one editable in place (issue-chips.tsx).
import { CollapsibleCaret } from "@rsva/ui/components/collapsible-caret";
import { isEmptyFilter, runQuery, type DisplayProperty, type IssueGroup } from "@rsva/query";
import type { Issue, Project } from "@rsva/schema/models";
import { cn } from "@rsva/ui/lib/utils";
import { computed, type IComputedValue } from "mobx";
import { observer } from "mobx-react-lite";
import { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { columnIssues, columnOf, laneList } from "../lib/board-lanes.ts";
import { LabelRoom, useLabelRoom } from "../lib/label-room.ts";
import { useIsPhone } from "../lib/phone.ts";
import { listCommitted } from "../perf.ts";
import { paths, router } from "../router.ts";
import { Link } from "../link.tsx";
import { perEngine, store } from "../store.ts";
import { listIssues, queryContext, type ProjectView } from "../view-state.ts";
import { GroupAddButton, GroupLabel } from "./group-icon.tsx";
import { IssueCells, PendingDot, PriorityCell, StateCell } from "./issue-chips.tsx";
import { NativeCheckbox } from "@rsva/ui/components/native-checkbox";
import { typedInto } from "../lib/typing.ts";
import { normKey, stepIn, stepKey } from "../lib/step-keys.ts";
import { listView, shownIssue, useIsMarked, useIsSelected } from "./list-view.ts";
import { markOnClick, orderOnScreen } from "./marking.ts";
import { QuickAdd } from "./quick-add.tsx";
import { shownList } from "./view-panel-state.ts";
import { onRowMenu, RowMenuButton } from "./row-menu.tsx";
import { listIssuePath } from "./issue-actions.ts";

const queries = perEngine(() => new Map<string, IComputedValue<IssueGroup[]>>());

/**
 * A list's issues through its view: filtered, ordered, grouped. A computed per view state and place (a project, or
 * null across every project on a view's own page), so a list, the board and the ↑/↓ handler share one result,
 * recomputed only when the issues or the view change. In a project it runs with the project's states and labels.
 */
export function listGroups(view: ProjectView, project: Project | null): IssueGroup[] {
  const key = `${view.key}@${project?.id ?? "*"}`;
  let q = queries().get(key);
  if (!q) {
    q = computed(() => runQuery(view.base?.issues() ?? listIssues(project?.id ?? null), view.filter, view.display, queryContext(project?.id ?? view.scope)), { keepAlive: true });
    queries().set(key, q);
  }
  return q.get();
}

/** What a project shows now: its active tab's view narrowed to it, or All issues. */
export const projectGroups = (project: Project): IssueGroup[] => listGroups(shownList(project.id), project);

/** How many issues a list shows in a place, an issue in two groups once. */
export function shownCount(view: ProjectView, project: Project | null): number {
  const seen = new Set<string>();
  for (const g of listGroups(view, project)) for (const i of g.issues) seen.add(i.id);
  return seen.size;
}

const collapseKey = (view: ProjectView, g: IssueGroup) => `${view.key}:${g.key}`;

/** Issues in on-screen order, skipping collapsed groups; an issue shown in two groups is visited once. */
export function visibleIssues(view: ProjectView, project: Project | null): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const g of listGroups(view, project)) {
    if (listView.collapsed.has(collapseKey(view, g))) continue;
    for (const i of g.issues) {
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      out.push(i);
    }
  }
  return out;
}

/**
 * What J/K walk and N / M count from `fromId`: the list's on-screen order, or on the board the cards of the column
 * that issue is in (PLNR-55), so walking stays in the column the board narrowed to.
 */
export function walkOrder(project: Project, fromId: string | null): Issue[] {
  const view = shownList(project.id);
  if (view.layout !== "board") return visibleIssues(view, project);
  const groups = listGroups(view, project);
  const column = columnOf(groups, fromId, listView.column);
  return column ? columnIssues(column, view.display.subGroupBy ? laneList(groups) : null) : [];
}

/**
 * Moves the selection `by` rows in on-screen order from `fromId` (the selected row by default), staying at the ends;
 * returns the issue it lands on.
 */
export function stepSelection(project: Project, by: number, fromId = listView.selectedId): Issue | undefined {
  const rows = walkOrder(project, fromId);
  const at = rows.findIndex((i) => i.id === fromId);
  const next = stepIn(rows, at, by);
  if (!next) return;
  listView.select(next.id);
  scrollToIssue(next.id);
  return next;
}

/**
 * The keys that mark issues for a bulk action (PLNR-294): `x` the selected one, Shift with an arrow or J/K the selected
 * one and the next, ⌘A every one on screen. True when the key was one of them.
 */
export function markKey(e: KeyboardEvent, project: Project): boolean {
  if (listView.picker || typedInto(e) || e.altKey) return false;
  const mod = e.metaKey || e.ctrlKey;
  const key = normKey(e);
  if (mod && !e.shiftKey && key === "a") {
    const box = document.querySelector("[data-slot=issue-list], [data-slot=board]");
    if (!box?.checkVisibility()) return false;
    listView.markAll(orderOnScreen(box));
    return true;
  }
  if (mod) return false;
  if (key === "x" && !e.shiftKey && listView.selectedId) {
    listView.toggleMark(listView.selectedId);
    return true;
  }
  const by = stepKey(key);
  if (e.shiftKey && by) {
    const from = listView.selectedId;
    const next = stepSelection(project, by);
    if (from) listView.marked.add(from);
    if (next) {
      listView.marked.add(next.id);
      focusIssue(next.id);
    }
    return true;
  }
  return false;
}

/** Scrolls an issue's row or card into view. */
export function scrollToIssue(id: string): void {
  shownIssue(id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/**
 * Hands the real focus to the row or card a key step landed on, so that one cursor walks the list: left behind, it would
 * draw the keyboard ring on the row last clicked. The selected row draws no ring, its tint is the cursor.
 */
export function focusIssue(id: string): void {
  shownIssue(id)?.querySelector("a")?.focus({ preventScroll: true });
}


/** Opens an issue beside the list; `replace` while walking the list from an open one, so the history does not fill. */
export function openIssue(ws: string, issue: Issue, replace = false): void {
  const path = listIssuePath(ws, issue);
  if (replace) router.replace(path);
  else router.push(path);
}

/** Rendered once the store is ready; keyed by the list, so a project switch mounts a fresh list. */
export const IssueList = observer(function IssueList({ view, project, ws }: { view: ProjectView; project: Project | null; ws: string }) {
  const groups = listGroups(view, project);
  const properties = view.display.properties;
  // One Set per change of the properties, so rows (memoized observers) keep equal props across filter keystrokes.
  const shown = useMemo(() => new Set(properties), [properties]);
  const phone = useIsPhone();
  const box = useRef<HTMLDivElement>(null);
  const room = useLabelRoom(box, !phone);
  // Room for the longest key, so titles line up: "INFRA-239"; across projects, the longest of them.
  const keyWidth = project ? `${project.key.length + String(project.issueCounter).length + 1.5}ch` : `${longestKey() + 1.5}ch`;

  useLayoutEffect(listCommitted, []);

  // A project switch mounts this list fresh. Its first commit renders only the rows that fit on screen; the rest follow
  // in a transition right after that frame is painted (interruptible by input). At CPU ×4 that took the INFRA switch
  // (240 rows) from ~70 ms to the cost of a small project. Unlike virtualization, every row is in the DOM a frame
  // later, so find-in-page and keyboard walking keep working; filter changes don't remount and render in full.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (full) return;
    const id = requestAnimationFrame(() => startTransition(() => setFull(true)));
    return () => cancelAnimationFrame(id);
  }, [full]);
  let budget = full ? Infinity : Math.ceil(window.innerHeight / 32) + 10;

  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto bg-ground max-md:pb-24" data-slot="issue-list" data-roving="list">
      <LabelRoom.Provider value={room}>
        {groups.map((g) => {
          const limit = listView.collapsed.has(collapseKey(view, g)) ? 0 : Math.min(g.issues.length, budget);
          budget -= limit;
          return <Group key={g.key} group={g} view={view} project={project} limit={limit} ws={ws} beside={!!project} keyWidth={keyWidth} shown={shown} />;
        })}
      </LabelRoom.Provider>
      {groups.every((g) => g.issues.length === 0) && (
        <div className="p-6 text-ink-3">{isEmptyFilter(view.filter) ? "No issues yet." : "No issues match the filters."}</div>
      )}
    </div>
  );
});

/** Characters of the longest issue key across the active projects. */
function longestKey(): number {
  return Math.max(6, ...store.projectList().map((p) => p.key.length + String(p.issueCounter).length + 1));
}

interface RowOptions {
  ws: string;
  /** Opens beside its project's list; across projects an issue opens on its own page. */
  beside: boolean;
  keyWidth: string;
  shown: ReadonlySet<DisplayProperty>;
}

const Group = observer(function Group({
  group,
  view,
  project,
  limit,
  ...row
}: { group: IssueGroup; view: ProjectView; project: Project | null; limit: number } & RowOptions) {
  const key = collapseKey(view, group);
  // Across projects there is no one project a new issue would go to: no adding from a group there.
  const collapsed = listView.collapsed.has(key);
  return (
    <section aria-label={group.name} className="list-group">
      <div data-group-head className="group/head sticky top-0 z-10 flex h-(--row-head) items-center border-b bg-group pr-6 in-data-[split]:pr-4 max-md:z-5 max-md:h-9 max-md:pr-1.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => listView.toggle(key)}
          className="relative flex h-full min-w-0 flex-1 items-center gap-2.5 pl-[30px] text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-md:pl-[34px]"
        >
          {/* A touch screen has no hover: its caret stays before the header, in its own room. */}
          <CollapsibleCaret open={!collapsed} className="absolute left-2 hidden transition max-md:left-[18px] pointer-coarse:block" />
          <GroupLabel
            group={group}
            caret={
              <CollapsibleCaret
                open={!collapsed}
                className="opacity-0 transition duration-150 pointer-fine:group-hover/head:opacity-100 group-has-focus-visible/head:opacity-100 pointer-coarse:hidden"
              />
            }
          />
        </button>
        {project && !view.base?.closed() && <GroupAddButton group={group} projectId={project.id} base={view.base?.targets} />}
      </div>
      {!collapsed && group.issues.slice(0, limit).map((i) => <Row key={i.id} issue={i} {...row} />)}
      {project && !view.base?.closed() && !collapsed && limit === group.issues.length && (
        <span className="contents max-md:hidden">
          <QuickAdd projectId={project.id} targets={[...(view.base?.targets ?? []), group]} last={group.issues.at(-1)} />
        </span>
      )}
    </section>
  );
});

/**
 * What a list row and a board card show of their issue's place: selected, marked, its key, and its link, which is the
 * issue's page (new tab, copied address) while a plain click opens it beside the list.
 */
export function useIssueRow(issue: Issue, ws: string) {
  const key = store.issueKey(issue);
  return { selected: useIsSelected(issue.id), marked: useIsMarked(issue.id), key, href: paths.browse(ws, key) };
}

const Row = observer(function Row({ issue, ws, beside, keyWidth, shown }: { issue: Issue } & RowOptions) {
  const { selected, marked, key, href } = useIssueRow(issue, ws);
  // One ledger line: priority, key, state, title, then the other properties in fixed places, so keys and numbers line
  // up down the page. A div with one stretched link: the cells are buttons, and buttons may not sit inside a link.
  return (
    <div
      data-issue={issue.id}
      aria-current={selected || undefined}
      onContextMenu={onRowMenu}
      className={cn(
        "list-row group/row relative flex h-(--row) items-center gap-3 pr-6 pl-[30px] transition-colors in-data-[split]:pr-4 duration-120 [contain-intrinsic-size:auto_var(--row)] [content-visibility:auto] hover:bg-row-hover",
        // A phone's row after the LedgerPhoneList artboard: state and title on top, the rest in one quiet line under the
        // title. The same elements, reordered: tapping anywhere opens the issue, its cells are read only.
        "max-md:h-auto max-md:min-h-[60px] max-md:flex-wrap max-md:gap-x-2.5 max-md:gap-y-1 max-md:px-4 max-md:pl-4 max-md:py-3 max-md:select-none max-md:[-webkit-touch-callout:none] max-md:[contain-intrinsic-size:auto_66px] max-md:active:bg-row-hover",
        (selected || marked) && "bg-row-selected hover:bg-row-selected",
      )}
    >
      {/* In a column of its own at the row's left (6px in, the row's content from 30px, beside an open issue too), over the
          stretched link: shown on hover, and on every row once one is marked. */}
      <NativeCheckbox
        aria-label={`Select ${key}`}
        checked={marked}
        onChange={() => listView.toggleMark(issue.id)}
        className="absolute top-1/2 left-1.5 z-10 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 in-data-marking:opacity-100 has-checked:opacity-100 max-md:hidden"
      />
      {/* Beside an open issue the row narrows to key, state and title. */}
      {shown.has("priority") && <PriorityCell issue={issue} className="in-data-[split]:hidden max-md:pointer-events-none max-md:order-3 max-md:w-auto" />}
      {shown.has("key") && (
        <span className={cn("shrink-0 font-mono text-id text-ink-3 max-md:order-2 max-md:ml-6 max-md:w-auto!", selected && "font-semibold text-ink")} style={{ width: `max(68px, ${keyWidth})` }}>
          {key}
        </span>
      )}
      {shown.has("state") && <StateCell issue={issue} />}
      <Link
        href={href}
        {...(beside ? { to: listIssuePath(ws, issue) } : {})}
        before={() => listView.select(issue.id)}
        data-roving-item
        onClick={(e) => markOnClick(e, issue.id)}
        className={cn(
          "min-w-0 flex-1 truncate outline-none after:absolute after:inset-0 max-md:order-1 max-md:line-clamp-2 max-md:basis-[calc(100%-24px)] max-md:text-[15px]/[1.35] max-md:font-medium max-md:whitespace-normal",
          !selected && "focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset",
        )}
      >
        {issue.title}
      </Link>
      {store.isPending(issue.id) && <PendingDot />}
      {/* The ledger's trailing columns, 12px apart; avatars at 22px. */}
      <span className="flex shrink-0 items-center gap-3 in-data-[split]:hidden max-md:order-4 max-md:h-5 max-md:min-w-0 max-md:flex-1 max-md:shrink max-md:gap-2.5 max-md:overflow-hidden [&_[data-slot=avatar]]:size-[22px] [&_[data-slot=avatar]]:text-[9px] max-md:[&_button]:pointer-events-none">
        <IssueCells issue={issue} shown={shown} subs={shown.has("subIssueCount") ? store.subIssuesOf(issue.id).length : 0} />
      </span>
      {/* A phone has no right click: the row menu is behind a "…" at the end of the quiet line. */}
      <RowMenuButton className="relative order-5 -my-3 -mr-2.5 size-11 text-ink-3 opacity-100 md:hidden" />
    </div>
  );
});
