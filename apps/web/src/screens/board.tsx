// Plane's board (kanban): a column per group of runQuery (state by default), cards with the display properties,
// drag and drop between and within columns, collapsible columns, swimlanes when display.subGroupBy is set, quick add
// at the end of a column. With a card open the board narrows to that card's column beside it (BoardColumn, PLNR-55).
// Lazy chunk (layout-switch.tsx).
//
// Large columns (INFRA's Backlog has 178 cards) stay cheap with content-visibility: auto on cards, as the list does
// with rows: off-screen cards skip layout and paint. Measured on INFRA, see the commit message.
import { CaretLeftIcon, CaretRightIcon, ArrowsInLineHorizontalIcon } from "@phosphor-icons/react";
import type { DisplayProperty, IssueGroup } from "@rsva/query";
import type { Issue, Project } from "@rsva/schema/models";
import { plural } from "@rsva/schema/util";
import type { IssueChange } from "@rsva/sync";
import { Button } from "@rsva/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@rsva/ui/components/collapsible";
import { CollapsibleCaret } from "@rsva/ui/components/collapsible-caret";
import { KeyHint } from "@rsva/ui/components/kbd";
import { Hint } from "@rsva/ui/components/tooltip";
import { cn } from "@rsva/ui/lib/utils";
import { observable } from "mobx";
import { observer } from "mobx-react-lite";
import { createContext, use, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { columnIssues, columnOf, laneList, sameHeight, type Lane } from "../lib/board-lanes.ts";
import { canMoveBetween, movePatch, type GroupTarget } from "../lib/group-patch.ts";
import { undoOf } from "../lib/bulk.ts";
import { keyForMove, keysForMove } from "../lib/sort-keys.ts";
import { typing } from "../lib/typing.ts";
import { afterPaint } from "../perf.ts";
import { store } from "../store.ts";
import type { ProjectView } from "../view-state.ts";
import { shownList } from "./view-panel-state.ts";
import { attachDragDrop, type DropPlace } from "./drag-drop.ts";
import { GroupAddButton, groupButton, GroupIcon, GroupLabel } from "./group-icon.tsx";
import { DateCell, IssueCells, PendingDot, PriorityCell, StateCell } from "./issue-chips.tsx";
import { focusIssue, listGroups, openIssue, projectGroups, scrollToIssue, useIssueRow } from "./issue-list.tsx";
import { listIssuePath } from "./issue-actions.ts";
import { Link } from "../link.tsx";
import { ignoredKey, listView } from "./list-view.ts";
import { stepIn } from "../lib/step-keys.ts";
import { useWindowKeys } from "./list-keys.ts";
import { markOnClick } from "./marking.ts";
import { notice } from "./notice.ts";
import { QuickAdd } from "./quick-add.tsx";
import { onRowMenu } from "./row-menu.tsx";

/** Collapsed columns and swimlanes, by project and group key. UI state: not synced, not persisted (like the list's). */
const collapsed = observable.set<string>();
const toggle = (k: string) => (collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k));

// On a phone a column takes most of the screen and the next one peeks in; a swipe stops on a column.
// The board's frame: the scrolling area, the row of columns, a column,
// its header, the plate under its cards, a collapsed column and a card.
const COLUMN = "w-[296px] max-md:w-[84vw] max-md:snap-start";
const BOARD_SCROLL = "relative min-h-0 flex-1 overflow-auto bg-ground max-md:snap-x max-md:snap-mandatory";
const BOARD_ROW = "flex min-h-full w-max items-stretch framed:gap-2 framed:px-2 framed:pb-2.5";
const COLUMN_HEAD = "sticky top-0 z-20 flex h-[calc(40px+var(--air))] items-center gap-[9px] border-b bg-ground pr-3 pl-4 framed:border-b-transparent";
const COLUMN_PLATE = "flex flex-col p-3 framed:min-h-[120px] framed:rounded-(--float-radius) framed:border framed:border-rule-soft framed:bg-sidebar framed:p-2";
const FOLDED_COLUMN =
  "flex w-10 shrink-0 flex-col items-center gap-2 self-stretch border-r py-3 framed:border-r-transparent outline-none transition-colors duration-120 hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-drop-over:bg-row-selected";
/** Swimlanes: the row of column heads, a lane, its header, its row of cells, a cell (empty: an outline at the lane's top). */
const SWIM = "w-max min-w-full framed:px-2 framed:pb-2";
const SWIM_HEADS = "sticky top-0 z-30 flex bg-ground framed:gap-2 framed:px-[9px] framed:*:border-r-transparent";
const SWIM_LANE = "border-b framed:mt-2 framed:overflow-clip framed:rounded-(--float-radius) framed:border framed:border-rule-soft framed:bg-sidebar";
const SWIM_TRIGGER = "sticky left-0 flex h-(--row-head) items-center gap-2.5 px-4 outline-none transition-colors duration-120 hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring";
const SWIM_ROW = "flex items-stretch framed:gap-2 framed:px-2 framed:pb-2";
// Framed, an empty cell is a 44px outline at the top of the lane, as the artboard's: not stretched to the lane's tallest cell.
const swimCell = (filled: boolean): string =>
  cn("flex shrink-0 flex-col border-r p-3 pt-1 framed:p-0", filled ? "framed:border-r-transparent" : cn("framed:min-h-11 framed:self-start framed:rounded-(--card-radius) framed:p-1", EMPTY_OUTLINE), COLUMN);
const CARD = "relative flex flex-col gap-2 rounded-(--card-radius) border bg-panel px-3 py-[calc(10px+var(--air))] max-md:rounded-lg max-md:px-3.5 max-md:py-3";

/** On a view's own page (a view of one project, PLNR-74) a card opens on the issue's page: no list to open it beside. */
const OnViewPage = createContext(false);

/** `list`: a view's own page shows that view's board; a project shows its current tab's. */
export const Board = observer(function Board({ project, ws, list }: { project: Project; ws: string; list?: ProjectView }) {
  const view = list ?? shownList(project.id);
  const groups = list ? listGroups(list, project) : projectGroups(project);
  const scroller = useRef<HTMLDivElement>(null);
  const properties = view.display.properties;
  // One Set per change of the properties, so cards (memoized observers) keep equal props.
  const shown = useMemo(() => new Set(properties), [properties]);
  const lanes = view.display.subGroupBy ? laneList(groups) : null;
  const base = view.base?.closed() ? CLOSED : (view.base?.targets ?? NO_BASE);

  // Drag and drop: one set of listeners on the board for its lifetime; the drop reads the groups of that moment.
  const latest = useRef(groups);
  latest.current = groups;
  useEffect(() => {
    const el = scroller.current!;
    return attachDragDrop(el, { scroller: el, onDrop: (id, from, to) => drop(project, view, latest.current, id, from, to) });
  }, [project, view]);

  useLayoutEffect(() => {
    if (!performance.getEntriesByName("rsva:layout-start").length) return;
    performance.measure("rsva:board-render", "rsva:layout-start");
    afterPaint(() => {
      performance.measure("rsva:board", "rsva:layout-start");
      performance.clearMarks("rsva:layout-start");
    });
  }, []);

  useBoardKeys(groups);

  return (
    <OnViewPage value={!!list}>
      <div
        ref={scroller}
        data-slot="board"
        data-roving="list"
        className={cn(BOARD_SCROLL, "[[data-dragging]_&]:cursor-grabbing [[data-dragging]_&]:select-none")}
      >
        {lanes ? (
          <Swimlanes project={project} ws={ws} groups={groups} lanes={lanes} shown={shown} base={base} />
        ) : (
          <div className={BOARD_ROW}>
            {groups.map((g) => (
              <Column key={g.key} project={project} ws={ws} group={g} shown={shown} base={base} />
            ))}
          </div>
        )}
      </div>
    </OnViewPage>
  );
});

function collapseKey(project: Project, key: string) {
  return `${project.id}:${key}`;
}

/** The list's own groups every new card also joins (a cycle's board, PLNR-63). */
type Base = readonly GroupTarget[] | null;
const NO_BASE: Base = [];
/** A list that takes no new cards (a completed cycle's board): no adding anywhere. */
const CLOSED: Base = null;

const Column = observer(function Column({ project, ws, group, shown, base }: { project: Project; ws: string; group: IssueGroup; shown: ReadonlySet<DisplayProperty>; base: Base }) {
  const k = collapseKey(project, group.key);
  if (collapsed.has(k))
    return (
      <Hint label={`Expand ${group.name}`}>
        <button
          type="button"
          data-cell
          data-group={group.key}
          onClick={() => toggle(k)}
          className={FOLDED_COLUMN}
        >
          <GroupIcon group={group} />
          <span className="text-label font-semibold [writing-mode:vertical-rl]">{group.name}</span>
          <span className="font-mono text-meta text-ink-3">{group.issues.length}</span>
        </button>
      </Hint>
    );
  return (
    <section aria-label={group.name} className={cn("flex shrink-0 flex-col border-r framed:border-r-transparent", COLUMN)}>
      <ColumnHeader project={project} group={group} base={base} onCollapse={() => toggle(k)} className="framed:pr-1.5 framed:pl-2.5" />
      <div
        className={cn(
          COLUMN_PLATE,
          !group.issues.length && cn("framed:min-h-[300px]", EMPTY_OUTLINE),
        )}
      >
        <Cell
          group={group}
          ws={ws}
          issues={group.issues}
          shown={shown}
          add={base && <QuickAdd projectId={project.id} targets={[...base, group]} last={group.issues.at(-1)} variant="card" centered={!group.issues.length} />}
        />
      </div>
    </section>
  );
});

function ColumnHeader({ project, group, base, onCollapse, className }: { project: Project; group: IssueGroup; base: Base; onCollapse?: () => void; className?: string }) {
  return (
    <header className={cn(COLUMN_HEAD, className)}>
      <GroupLabel group={group} />
      <span className="ml-auto flex items-center">
        {onCollapse && (
          <Hint label="Collapse">
            <Button variant="ghost" size="icon-sm" aria-label={`Collapse ${group.name}`} onClick={onCollapse} className={cn(groupButton, "border-0 active:scale-100!")}>
              <ArrowsInLineHorizontalIcon className="size-3 max-md:size-4" />
            </Button>
          </Hint>
        )}
        {base && <GroupAddButton group={group} projectId={project.id} base={base} />}
      </span>
    </header>
  );
}

/**
 * The drop cell: the cards of one group (or one group × swimlane), then New issue, inside the cell so that all of
 * an empty outline takes a drop (the drop counts only `[data-card]` children). In an empty cell the button is centred.
 */
const Cell = observer(function Cell({
  group,
  sub,
  ws,
  issues,
  shown,
  add,
}: {
  group: IssueGroup;
  sub?: string;
  ws: string;
  issues: Issue[];
  shown: ReadonlySet<DisplayProperty>;
  add?: ReactNode;
}) {
  const empty = !issues.length;
  return (
    <div
      data-cell
      data-group={group.key}
      data-sub={sub}
      className={cn(
        "relative flex min-h-16 flex-col gap-[calc(8px+var(--air))] rounded-(--card-radius) transition-colors duration-200 data-drop-over:bg-row-hover",
        !add && "pb-2",
        empty && "flex-1 justify-center",
        // Framed, an empty swimlane cell is only as tall as its button: the outline around it is the column.
        empty && sub !== undefined && "framed:min-h-0",
      )}
    >
      {issues.map((i) => (
        <Card key={i.id} issue={i} ws={ws} column={group.key} shown={shown} />
      ))}
      {add}
    </div>
  );
});

/**
 * One rule for both boards (RSVA-504): a column or a swimlane cell with cards is a plate, an empty one a dashed outline
 * of the same place with only New issue in its middle, as the FramedBoardEmpty artboard but without its note (the
 * owner, 2026-11-08: a note in every empty cell is too much). Stronger than a plate's edge (rule, not rule-soft), so it
 * reads as a place to put something, not as an empty field.
 */
const EMPTY_OUTLINE = "framed:border-[1.5px] framed:border-dashed framed:border-rule framed:bg-transparent";

const Card = observer(function Card({ issue, ws, column, shown }: { issue: Issue; ws: string; column: string; shown: ReadonlySet<DisplayProperty> }) {
  const { selected, marked, key, href } = useIssueRow(issue, ws);
  const onViewPage = use(OnViewPage);
  return (
    <div
      data-card={issue.id}
      data-issue={issue.id}
      aria-current={selected || undefined}
      onContextMenu={onRowMenu}
      className={cn(
        CARD,
        "group/row cursor-grab in-data-[split]:cursor-pointer select-none [contain-intrinsic-size:auto_96px] [content-visibility:auto] max-md:[-webkit-touch-callout:none] max-md:active:bg-row-hover",
        // Hover softly tints the background only: no lift, border unchanged (owner's call, 2026-10-28).
        "transition-[background-color,opacity] duration-200 hover:bg-row-hover data-dragging:opacity-35",
        selected && "border-ink-3",
        marked && "border-ink-3 bg-row-selected hover:bg-row-selected",
      )}
    >
      <div className="-my-1 flex h-6 items-center gap-2">
        {shown.has("priority") && <PriorityCell issue={issue} />}
        {shown.has("key") && <span className="font-mono text-meta text-ink-3">{key}</span>}
        {shown.has("state") && <StateCell issue={issue} />}
        {store.isPending(issue.id) && <PendingDot />}
        {/* No hover buttons on a card, as the NavProjectBoard artboard: the due date only when set, the menu on right
            click. */}
        {shown.has("dueDate") && issue.dueDate && (
          <span className="ml-auto flex items-center">
            <DateCell issue={issue} field="dueDate" />
          </span>
        )}
      </div>
      <Link
        href={href}
        {...(onViewPage ? {} : { to: listIssuePath(ws, issue) })}
        before={() => {
          listView.select(issue.id);
          listView.setColumn(column);
        }}
        data-roving-item
        draggable={false}
        onClick={(e) => markOnClick(e, issue.id)}
        className={cn(
          "line-clamp-3 leading-[1.35] font-medium text-pretty outline-none after:absolute after:inset-0 after:rounded-md",
          !selected && "focus-visible:after:ring-2 focus-visible:after:ring-ring",
        )}
      >
        {issue.title}
      </Link>
      {/* The assignee sits at the end of the line, as in the ledger card. */}
      <div className="-my-0.5 flex flex-wrap items-center gap-2.5 empty:hidden [&>[data-chip=assignees]]:ml-auto">
        <IssueCells
          issue={issue}
          shown={shown}
          subs={shown.has("subIssueCount") ? store.subIssuesOf(issue.id).length : 0}
          withDue={false}
        />
      </div>
    </div>
  );
});

// ── Beside an open card ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The board narrowed to the open card's column (PLNR-55), as the list narrows to a column: the same cards, lane by
 * lane when sub-grouped, ‹ › and ←/→ to the neighbouring columns. No drag and drop here: the state is the S key or the
 * pane's property, and the column follows the card when it changes.
 */
export const BoardColumn = observer(function BoardColumn({ project, ws, openId }: { project: Project; ws: string; openId: string }) {
  const view = shownList(project.id);
  const groups = projectGroups(project);
  const properties = view.display.properties;
  const shown = useMemo(() => new Set(properties), [properties]);
  const lanes = view.display.subGroupBy ? laneList(groups) : null;
  const group = columnOf(groups, openId, listView.column);
  const cols = groups.filter((g) => g.issues.length);
  const at = group ? cols.indexOf(group) : -1;

  const step = (by: number) => {
    const next = cols[at + by];
    if (!next || !group) return;
    // At the same height, as ←/→ move on the whole board.
    const issue = sameHeight(columnIssues(group, lanes), columnIssues(next, lanes), openId);
    if (!issue) return;
    listView.setColumn(next.key);
    openIssue(ws, issue, true);
  };
  // Opened from the board, the card that had the focus gave way to this column: the focus goes on to it here. The board
  // is hidden after this mounts, so a focus still on one of its cards counts as lost.
  const column = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const had = document.activeElement;
    if (!had || had === document.body || had.closest("[data-slot=board]")) column.current?.querySelector<HTMLElement>(`[data-issue="${openId}"] a`)?.focus({ preventScroll: true });
  }, []);
  useWindowKeys((e) => {
    if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || ignoredKey(e)) return;
    e.preventDefault();
    step(e.key === "ArrowRight" ? 1 : -1);
  });

  if (!group) return null;
  const cells = lanes
    ? lanes.flatMap(({ lane }) => {
        const issues = group.subGroups?.find((s) => s.key === lane.key)?.issues ?? [];
        return issues.length ? [{ lane, issues }] : [];
      })
    : [{ lane: null, issues: group.issues }];
  return (
    <div data-slot="board-column" className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-(--topbar) shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <GroupIcon group={group} />
        <span className="truncate text-label font-semibold">{group.name}</span>
        <span className="font-mono text-meta text-ink-3">{columnIssues(group, lanes).length}</span>
        <span className="ml-auto flex items-center">
          <Hint label={<KeyHint label="Previous column" keys="←" />}>
            <Button variant="ghost" size="icon" aria-label="Previous column" disabled={at <= 0} onClick={() => step(-1)}>
              <CaretLeftIcon />
            </Button>
          </Hint>
          <Hint label={<KeyHint label="Next column" keys="→" />}>
            <Button variant="ghost" size="icon" aria-label="Next column" disabled={at < 0 || at >= cols.length - 1} onClick={() => step(1)}>
              <CaretRightIcon />
            </Button>
          </Hint>
        </span>
      </header>
      <div ref={column} data-roving="list" className="min-h-0 flex-1 overflow-y-auto bg-ground p-3">
        {cells.map(({ lane, issues }) => (
          <section key={lane?.key ?? ""} aria-label={lane?.name}>
            {lane && (
              <div className="flex h-(--row-head) items-center gap-2.5">
                <GroupIcon group={lane} />
                <span className="truncate text-label font-semibold">{lane.name}</span>
                <span className="font-mono text-meta text-ink-3">{issues.length}</span>
              </div>
            )}
            <Cell group={group} {...(lane && { sub: lane.key })} ws={ws} issues={issues} shown={shown} />
          </section>
        ))}
      </div>
    </div>
  );
});

// ── Swimlanes ────────────────────────────────────────────────────────────────────────────────────────────────────

const Swimlanes = observer(function Swimlanes({
  project,
  ws,
  groups,
  lanes,
  shown,
  base,
}: {
  project: Project;
  ws: string;
  groups: IssueGroup[];
  lanes: Lane[];
  shown: ReadonlySet<DisplayProperty>;
  base: Base;
}) {
  return (
    <div className={SWIM}>
      {/* The heads line up with the cells: past the board's 8px, a swimlane's 1px edge and its 8px inside. */}
      <div className={SWIM_HEADS}>
        {groups.map((g) => (
          <div key={g.key} className={cn("shrink-0 border-r", COLUMN)}>
            <ColumnHeader project={project} group={g} base={base} />
          </div>
        ))}
      </div>
      {lanes.map(({ lane, count }) => {
        const k = collapseKey(project, `lane:${lane.key}`);
        const shut = collapsed.has(k);
        return (
          <Collapsible key={lane.key} open={!shut} onOpenChange={() => toggle(k)} render={<section aria-label={lane.name} className={SWIM_LANE} />}>
            <CollapsibleTrigger className={SWIM_TRIGGER}>
              <CollapsibleCaret open={!shut} />
              <GroupIcon group={lane} />
              <span className="text-label font-semibold">{lane.name}</span>
              <span className="font-mono text-meta text-ink-3">{count}</span>
            </CollapsibleTrigger>
            <CollapsibleContent className={SWIM_ROW}>
              {groups.map((g) => {
                const cell = g.subGroups?.find((s) => s.key === lane.key);
                const issues = cell?.issues ?? [];
                return (
                  <div key={g.key} className={swimCell(issues.length > 0)}>
                    <Cell
                      group={g}
                      sub={lane.key}
                      ws={ws}
                      issues={issues}
                      shown={shown}
                      add={base && <QuickAdd projectId={project.id} targets={[...base, g, lane]} last={issues.at(-1)} variant="card" centered={!issues.length} />}
                    />
                  </div>
                );
              })}
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
});

// ── Drop and keyboard ────────────────────────────────────────────────────────────────────────────────────────────

/** Applies a drop: the grouped fields (and the swimlane's) change, and in manual order the position, in one transaction. */
function drop(project: Project, view: ProjectView, groups: IssueGroup[], id: string, from: DropPlace, to: DropPlace): void {
  if (listView.marked.size > 1 && listView.marked.has(id)) return dropMarked(project, view, groups, id, from, to);
  const issue = store.issues.get(id);
  const fromGroup = groups.find((g) => g.key === from.groupKey);
  const toGroup = groups.find((g) => g.key === to.groupKey);
  if (!issue || !fromGroup || !toGroup) return;
  const fromSub = from.subKey ? fromGroup.subGroups?.find((s) => s.key === from.subKey) : undefined;
  const toSub = to.subKey ? toGroup.subGroups?.find((s) => s.key === to.subKey) : undefined;
  const states = store.statesOf(project.id);
  const main = movePatch(issue, fromGroup, toGroup, states);
  const lane = fromSub && toSub ? movePatch(issue, fromSub, toSub, states) : {};
  if (!main || !lane) {
    notice.show(`Cannot move issues between ${canMoveBetween(toGroup.groupBy) ? "these swimlanes" : "authors"}`);
    return;
  }
  const patch = { ...main, ...lane };
  const cell = toSub ? toSub.issues : toGroup.issues;
  if (view.display.orderBy === "manual") {
    const key = keyForMove(store.issuesOf(project.id), cell, id, to.index);
    if (key) Object.assign(patch, { sortOrder: key });
  } else if (!Object.keys(patch).length) {
    notice.show("Sorted by a field: switch to manual order to rearrange cards");
    return;
  }
  if (!Object.keys(patch).length) return;
  performance.clearMarks("rsva:drop-start");
  performance.mark("rsva:drop-start");
  store.updateIssue(id, patch);
  afterPaint(() => performance.measure("rsva:drop", "rsva:drop-start"));
  listView.select(id);
}

/** The group (and swimlane) an issue's card is in: the dragged card's own when it is there too (an issue may be in several). */
function placeOfIssue(groups: IssueGroup[], id: string, from: DropPlace): { group: IssueGroup; sub: IssueGroup | undefined } | undefined {
  const has = (g: IssueGroup) => g.issues.some((i) => i.id === id);
  const group = groups.find((g) => g.key === from.groupKey && has(g)) ?? groups.find(has);
  if (!group) return undefined;
  const subs = group.subGroups ?? [];
  return { group, sub: subs.find((s) => s.key === from.subKey && has(s)) ?? subs.find(has) };
}

/**
 * A marked card dragged with others marked (RSVA-303): every marked card on the board moves to the drop place, each from
 * its own column, in one write and one Undo; in manual order they stand there as one block, in board order.
 */
function dropMarked(project: Project, view: ProjectView, groups: IssueGroup[], id: string, from: DropPlace, to: DropPlace): void {
  const toGroup = groups.find((g) => g.key === to.groupKey);
  if (!toGroup) return;
  const toSub = to.subKey ? toGroup.subGroups?.find((s) => s.key === to.subKey) : undefined;
  const states = store.statesOf(project.id);
  const seen = new Set<string>();
  const issues: Issue[] = [];
  for (const g of groups) for (const i of g.issues) if (listView.marked.has(i.id) && !seen.has(i.id)) issues.push((seen.add(i.id), i));
  const changes: IssueChange[] = [];
  for (const issue of issues) {
    const at = placeOfIssue(groups, issue.id, from);
    const main = at && movePatch(issue, at.group, toGroup, states);
    const lane = at?.sub && toSub ? movePatch(issue, at.sub, toSub, states) : {};
    if (!main || !lane) return notice.show(`Cannot move issues between ${canMoveBetween(toGroup.groupBy) ? "these swimlanes" : "authors"}`);
    changes.push({ id: issue.id, patch: { ...main, ...lane } });
  }
  if (view.display.orderBy === "manual") {
    const keys = keysForMove(store.issuesOf(project.id), toSub ? toSub.issues : toGroup.issues, id, issues.map((i) => i.id), to.index);
    changes.forEach((c, n) => Object.assign(c.patch, { sortOrder: keys[n] }));
  } else if (changes.every((c) => !Object.keys(c.patch).length)) {
    return notice.show("Sorted by a field: switch to manual order to rearrange cards");
  }
  const moved = changes.filter((c) => Object.keys(c.patch).length);
  if (!moved.length) return;
  const undo = undoOf(issues, moved);
  store.updateIssues(moved);
  notice.show(`${plural(moved.length, "issue")} moved`, () => store.updateIssues(undo));
  listView.select(id);
}

/** ←/→ move the selection to the neighbouring column at the same height; ↑/↓ and Enter are the list's handler's. */
function useBoardKeys(groups: IssueGroup[]): void {
  useWindowKeys((e) => {
    if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.metaKey || e.ctrlKey || e.altKey || typing(e.target, true)) return;
    const cols = groups.filter((g) => g.issues.length);
    const at = cols.findIndex((g) => g.issues.some((i) => i.id === listView.selectedId));
    const next = stepIn(cols, at, e.key === "ArrowRight" ? 1 : -1);
    const issue = next && sameHeight(cols[at]?.issues ?? [], next.issues, listView.selectedId);
    if (!issue) return;
    e.preventDefault();
    listView.select(issue.id);
    scrollToIssue(issue.id);
    focusIssue(issue.id);
  });
}
