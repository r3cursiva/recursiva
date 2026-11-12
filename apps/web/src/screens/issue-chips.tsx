// An issue's display properties as Ledger cells: quiet mono values in fixed places, each one a button that edits the
// property in place. A cell with no value shows only while the row is hovered or the cell focused. The cells only
// record what was clicked (row-popup.ts); the picker itself is rendered once, lazily, by row-popup-host.tsx. Dates open
// the calendar of the issue panel (date-calendar.tsx) the same way, a due date its quick dates first.
import { ArrowElbowDownRightIcon, ArrowsClockwiseIcon, CircleDashedIcon, ProhibitIcon, TagIcon } from "@phosphor-icons/react";
import type { DisplayProperty } from "@rsva/query";
import { cycleStatus, priorityTitle, type Issue, type Label } from "@rsva/schema/models";
import { LabelTags } from "@rsva/ui/components/color-chip";
import { PriorityIcon } from "@rsva/ui/components/priority-icon";
import { NoAvatar, UserAvatarStack } from "@rsva/ui/components/user-avatar";
import { faceOf } from "../lib/face.ts";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useContext, type MouseEvent, type ReactNode } from "react";
import { localToday } from "@rsva/query";
import { formatDate } from "@rsva/display/time";
import { fitLabels, LabelRoom, tagWidth } from "../lib/label-room.ts";
import { router } from "../router.ts";
import { store } from "../store.ts";
import { rowPopup, type RowPopupKind } from "./row-popup.ts";
import { StateGlyph } from "./state-glyph.tsx";

// -mx-1 px-1: the hover fill reaches 4px past the value, while the value itself sits on the ledger's column. z-1: above
// the title's stretched link (its ::after covers the whole row or card and comes later, so it would take the click).
const cell =
  "relative z-1 -mx-1 flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-1 font-mono text-meta text-ink-3 outline-none transition-colors duration-120 hover:bg-row-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ring max-md:h-5 [&_svg]:size-3 [&_svg]:shrink-0";

/**
 * Hidden until the row or card is hovered: an empty value is not news (of 481 issues 472 had no due date and 420 no
 * assignee, 2026-11-02). The row, not the cell: on the cell alone nothing would say there is something to click.
 */
const unset = "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 max-md:hidden";

/** One handler for every cell: the kind and the issue come from the DOM, so rows create no closures. */
function onCell(e: MouseEvent<HTMLButtonElement>): void {
  e.preventDefault();
  e.stopPropagation();
  const b = e.currentTarget;
  const issueId = b.closest("[data-issue]")?.getAttribute("data-issue");
  if (issueId) rowPopup.open(b.dataset.chip as RowPopupKind, issueId, b);
}

function Cell({ kind, title, className, children }: { kind: string; title: string; className?: string; children: ReactNode }) {
  return (
    <button type="button" data-chip={kind} title={title} aria-label={title} onClick={onCell} className={cn(cell, className)}>
      {children}
    </button>
  );
}

/** In a list as many tags as its LabelRoom has room for; elsewhere the first two. */
function LabelsCell({ labels }: { labels: readonly Label[] }) {
  const room = useContext(LabelRoom);
  return (
    <Cell
      kind="labels"
      title={labels.length ? `Labels: ${labels.map((l) => l.name).join(", ")}` : "Add labels"}
      className={cn("gap-2 max-md:min-w-0 max-md:shrink max-md:overflow-hidden", room === null && "max-w-56", labels.length === 0 && unset)}
    >
      {labels.length === 0 ? (
        <TagIcon />
      ) : (
        <LabelTags labels={labels} {...(room !== null && { max: fitLabels(labels.map((l) => tagWidth(l.name)), room) })} />
      )}
    </Cell>
  );
}

/** The issue has local changes the server has not confirmed yet. */
export function PendingDot() {
  return <span title="Saving…" aria-label="Saving" className="size-1.5 shrink-0 animate-pulse rounded-full bg-rule-strong" />;
}

export function PriorityCell({ issue, className }: { issue: Issue; className?: string }) {
  return (
    <Cell kind="priority" title={priorityTitle(issue.priority)} className={cn("w-6", issue.priority === 0 && "max-md:hidden", className)}>
      <PriorityIcon priority={issue.priority} />
    </Cell>
  );
}

export const StateCell = observer(function StateCell({ issue }: { issue: Issue }) {
  const state = store.states.get(issue.stateId);
  if (!state) return null;
  return (
    // On a phone the state is the row's one live control, with a finger-sized target around the glyph.
    <Cell kind="state" title={`State: ${state.name}`} className="w-[22px] max-md:order-0 max-md:mt-px max-md:self-start max-md:before:absolute max-md:before:-inset-2.5">
      <StateGlyph state={state} />
    </Cell>
  );
});

/** Due soon: overdue or within two days, and not done. */
function dueSoon(issue: Issue): boolean {
  if (issue.dueDate === null || issue.completedAt) return false;
  const soon = new Date(`${localToday()}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 2);
  return issue.dueDate <= soon.toISOString().slice(0, 10);
}

const DateCell = observer(function DateCell({ issue, field }: { issue: Issue; field: "startDate" | "dueDate" }) {
  const day = issue[field];
  const name = field === "startDate" ? "Start date" : "Due date";
  return (
    <Cell
      kind={field}
      title={day ? `${name}: ${day}${field === "dueDate" && day < localToday() && !issue.completedAt ? " (overdue)" : ""}` : name}
      className={cn("min-w-[60px] justify-end text-ink-2 max-md:order-first max-md:min-w-0", !day && cn(unset, "text-ink-3"), field === "dueDate" && dueSoon(issue) && "text-signal-text")}
    >
      {/* A word, not a calendar icon: it says which date, and two date columns stay apart. */}
      {day ? formatDate(day) : field === "startDate" ? "Start" : "Due"}
    </Cell>
  );
});

/**
 * The cells after the title, in the ledger's order: labels, sub-issues, assignees, dates. `shown`: the view's display
 * properties; `subs`: the issue's sub-issue count, when that property is on. On a card the due date sits in its top
 * line instead (`withDue` false).
 */
export const IssueCells = observer(function IssueCells({
  issue,
  shown,
  subs = 0,
  withDue = true,
}: {
  issue: Issue;
  shown: ReadonlySet<DisplayProperty>;
  subs?: number;
  withDue?: boolean;
}) {
  const show = (p: DisplayProperty) => shown.has(p);
  const labels = show("labels") ? issue.labelIds.map((id) => store.labels.get(id)).filter((l) => l !== undefined) : [];
  const assignees = show("assignees") ? issue.assigneeIds.map((id) => faceOf(id)) : [];
  return (
    <>
      {show("labels") && <LabelsCell labels={labels} />}
      {show("cycle") && <CycleCell issue={issue} />}
      {subs > 0 && (
        <span className={cn(cell, "hover:bg-transparent hover:text-ink-3")} title={`${subs} sub-issues`}>
          <ArrowElbowDownRightIcon />
          {subs}
        </span>
      )}
      {store.isBlocked(issue) && (
        <span className={cn(cell, "text-signal-text hover:bg-transparent hover:text-signal-text")} title="Blocked by an open issue">
          <ProhibitIcon />
        </span>
      )}
      {show("startDate") && <DateCell issue={issue} field="startDate" />}
      {show("assignees") && (
        <Cell kind="assignees" title={assignees.length ? `Assignees: ${assignees.map((a) => a.name).join(", ")}` : "Assign"} className={cn("max-md:order-last max-md:ml-auto", assignees.length === 0 && unset)}>
          {assignees.length > 0 ? <UserAvatarStack people={assignees} /> : <NoAvatar />}
        </Cell>
      )}
      {withDue && show("dueDate") && <DateCell issue={issue} field="dueDate" />}
      {show("createdAt") && <span className="shrink-0 font-mono text-meta text-ink-3">{formatDate(issue.createdAt.slice(0, 10))}</span>}
      {show("updatedAt") && <span className="shrink-0 font-mono text-meta text-ink-3">{formatDate(issue.updatedAt.slice(0, 10))}</span>}
    </>
  );
});

/**
 * The issue's cycle as a chip (PLNR-63); the active cycle's icon in ink, any other's grey, a draft's dashed. Empty, it
 * shows on hover only where the project has a cycle to plan into. On a cycle's own page its chip would repeat the page
 * on every row: only the items it moved on show theirs, which says where they went.
 */
const CycleCell = observer(function CycleCell({ issue }: { issue: Issue }) {
  const c = issue.cycleId ? store.cycles.get(issue.cycleId) : undefined;
  const r = router.route;
  if (r.name === "cycle" && (!c || (c.number === r.cycle && store.projectByKey(r.projectKey)?.id === c.projectId))) return null;
  if (!c) {
    if (!store.cyclesOf(issue.projectId).some((x) => !x.completedAt)) return null;
    return (
      <Cell kind="cycle" title="Add to a cycle" className={unset}>
        <ArrowsClockwiseIcon />
      </Cell>
    );
  }
  // From the schema, not lib/cycles.ts: the rows are startup code, the cycle screens are not.
  const status = cycleStatus(c, localToday());
  return (
    <Cell kind="cycle" title={`Cycle: ${c.name}`} className="max-w-36 max-md:hidden">
      {status === "draft" ? <CircleDashedIcon /> : <ArrowsClockwiseIcon className={status === "active" ? "text-ink" : undefined} />}
      <span className="truncate">{c.name}</span>
    </Cell>
  );
});

export { DateCell };
