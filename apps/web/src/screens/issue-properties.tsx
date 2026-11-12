// Property rows of the issue pane: the shared pickers (pickers.tsx) on the stored issue. Each one is controlled by
// listView.picker, so the s/p/a/l shortcuts can open it. `className` restyles the trigger, e.g. as a bordered chip.
// Beside its list an issue has no room for the panel: PropertyChips lays the same rows out under the title. `compact` is for
// such a chip: no row names it, so a hint does.
import { ArrowsClockwiseIcon, CalendarBlankIcon, PencilSimpleIcon, PlusIcon, RobotIcon, XIcon } from "@phosphor-icons/react";
import { priorityName, type Issue } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { LabelTag } from "@rsva/ui/components/color-chip";
import { KeyHint } from "@rsva/ui/components/kbd";
import { PriorityIcon } from "@rsva/ui/components/priority-icon";
import { Hint } from "@rsva/ui/components/tooltip";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { face } from "../lib/face.ts";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useState, type ReactElement, type ReactNode } from "react";
import { localToday } from "@rsva/query";
import { useIsPhone } from "../lib/phone.ts";
import { store } from "../store.ts";
import { issuePath, liveParent } from "./issue-actions.ts";
import { listView, type Picker } from "./list-view.ts";
import { subtree } from "../lib/issue-tree.ts";
import { cycleRange, daysLeft, statusOf } from "../lib/cycles.ts";
import { DateChip, type DateChipForm } from "./date-chip.tsx";
import { AssigneesPicker, CyclePicker, IssuePicker, LabelsPicker, PriorityPicker, StatePicker } from "./pickers.tsx";
import { StateGlyph } from "./state-glyph.tsx";
import { Link } from "../link.tsx";

// On a phone: the artboard's chips, in one line that scrolls sideways.
const triggerClass =
  "-ml-2 h-6 w-fit max-w-full justify-start gap-2 px-2 text-[13px] font-normal text-ink max-md:ml-0 max-md:h-[34px] max-md:max-w-60 max-md:gap-[7px] max-md:rounded-[9px] max-md:border-control-border max-md:bg-panel max-md:px-[11px]";
const placeholderClass = "text-ink-3";
// A trigger with several values: they wrap in the property pane and stay on one line among a phone's chips.
const multiClass = "h-auto min-h-6 flex-wrap py-0.5 max-md:h-[34px] max-md:flex-nowrap";
// A trigger whose text wraps in the property pane, its first line level with the other rows; one line among a phone's chips.
const wrapClass = "h-auto min-h-6 items-start py-[3px] text-left md:whitespace-normal max-md:h-[34px] max-md:items-center";

// The IssuePropsChips artboard's chip; the first part is for what only shows a value, the second for what opens a picker.
const chipShape = "inline-flex h-7 items-center gap-[7px] rounded-md border border-control-border bg-panel px-2.5 text-[12.5px] whitespace-nowrap";
const chipClass = `${chipShape} ml-0 flex-nowrap py-0 md:whitespace-nowrap hover:border-rule-strong hover:bg-row-hover aria-expanded:border-rule-strong aria-expanded:bg-nav-current`;

interface PropertyForm {
  issue: Issue;
  className?: string;
  compact?: boolean;
}

/** The chip's name on hover. A row of the panel has its name beside it. */
function named(compact: boolean | undefined, label: ReactNode, trigger: ReactElement<Record<string, unknown>>) {
  return compact ? <Hint label={label}>{trigger}</Hint> : trigger;
}

/** A picker that does not follow listView.picker: as a chip, + Property opens it. */
interface Controlled {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function pickerProps(p: Picker) {
  return {
    open: listView.picker === p,
    onOpenChange: (open: boolean) => listView.setPicker(open ? p : null),
  };
}

export const StateProperty = observer(function StateProperty({ issue, className, compact }: PropertyForm) {
  const current = store.states.get(issue.stateId);
  return (
    <StatePicker
      {...pickerProps("state")}
      projectId={issue.projectId}
      value={issue.stateId}
      onChange={(stateId) => store.updateIssue(issue.id, { stateId })}
      trigger={named(
        compact,
        <KeyHint label="State" keys="S" />,
        <Button variant="ghost" className={cn(triggerClass, className)}>
          {current && <StateGlyph state={current} />}
          {current?.name ?? "State"}
        </Button>,
      )}
    />
  );
});

export const PriorityProperty = observer(function PriorityProperty({ issue, className, compact }: PropertyForm) {
  return (
    <PriorityPicker
      {...pickerProps("priority")}
      value={issue.priority}
      onChange={(priority) => store.updateIssue(issue.id, { priority })}
      trigger={named(
        compact,
        <KeyHint label="Priority" keys="P" />,
        <Button variant="ghost" className={cn(triggerClass, className)}>
          <PriorityIcon priority={issue.priority} />
          <span className={issue.priority === 0 ? placeholderClass : undefined}>{priorityName(issue.priority)}</span>
        </Button>,
      )}
    />
  );
});

export const AssigneesProperty = observer(function AssigneesProperty({ issue, className, compact }: PropertyForm) {
  const chosen = issue.assigneeIds.map((id) => store.users.get(id)).filter((u) => u !== undefined);
  return (
    <AssigneesPicker
      {...pickerProps("assignees")}
      value={issue.assigneeIds}
      onChange={(assigneeIds) => store.updateIssue(issue.id, { assigneeIds })}
      trigger={named(
        compact,
        <KeyHint label="Assignees" keys="A" />,
        <Button variant="ghost" className={cn(triggerClass, multiClass, "gap-y-1", className)}>
          {chosen.length === 0 && <span className={placeholderClass}>No assignees</span>}
          {chosen.map((u) => (
            <span key={u.id} className="flex min-w-0 items-center gap-1.5">
              <UserAvatar {...face(u)} />
              <span className="truncate">{u.name}</span>
            </span>
          ))}
        </Button>,
      )}
    />
  );
});

export const LabelsProperty = observer(function LabelsProperty({ issue, className, compact }: PropertyForm) {
  const chosen = issue.labelIds.map((id) => store.labels.get(id)).filter((l) => l !== undefined);
  return (
    <LabelsPicker
      {...pickerProps("labels")}
      projectId={issue.projectId}
      value={issue.labelIds}
      onChange={(labelIds) => store.updateIssue(issue.id, { labelIds })}
      trigger={named(
        compact,
        <KeyHint label="Labels" keys="L" />,
        <Button variant="ghost" className={cn(triggerClass, multiClass, "gap-1", className)}>
          {chosen.length === 0 && <span className={placeholderClass}>No labels</span>}
          {chosen.map((l) => (
            <LabelTag key={l.id} color={l.color}>
              {l.name}
            </LabelTag>
          ))}
        </Button>,
      )}
    />
  );
});

/** The issue's cycle (PLNR-63): its name and dates, "10d left" while it runs. */
export const CycleProperty = observer(function CycleProperty({ issue, className, compact, ...controlled }: PropertyForm & Controlled) {
  const c = issue.cycleId ? store.cycles.get(issue.cycleId) : undefined;
  const left = c && statusOf(c) === "active" ? daysLeft(c) : null;
  return (
    <CyclePicker
      {...controlled}
      projectId={issue.projectId}
      value={issue.cycleId}
      onChange={(cycleId) => store.updateIssue(issue.id, { cycleId })}
      trigger={named(
        compact,
        "Cycle",
        <Button variant="ghost" className={cn(triggerClass, wrapClass, "min-w-0", className)}>
          <ArrowsClockwiseIcon className={cn("md:mt-px", c ? "text-ink" : placeholderClass)} />
          {c ? (
            <span className="flex min-w-0 flex-col max-md:contents">
              <span className="wrap-anywhere max-md:shrink-0">{c.name}</span>
              {!compact && <span className="font-mono text-caption text-ink-3 max-md:hidden">{left ?? cycleRange(c)}</span>}
            </span>
          ) : (
            <span className={placeholderClass}>No cycle</span>
          )}
        </Button>,
      )}
    />
  );
});

export const DateProperty = observer(function DateProperty({ issue, field, ...form }: { issue: Issue; field: "startDate" | "dueDate" } & DateChipForm) {
  const day = issue[field];
  return (
    <DateChip
      {...form}
      key={issue.id}
      name={field === "startDate" ? "Start date" : "Due date"}
      value={day}
      overdue={field === "dueDate" && !!day && day < localToday() && !issue.completedAt}
      presets={field === "dueDate" ? { projectId: issue.projectId, cycleId: issue.cycleId } : undefined}
      onChange={(value) => store.updateIssue(issue.id, { [field]: value })}
    />
  );
});

/** The agent working on the issue, on a phone's line of chips: read here, set from the issue list's menu or by the agent. */
export const DelegateChip = observer(function DelegateChip({ issue, className, compact }: PropertyForm) {
  const u = issue.delegateId ? store.users.get(issue.delegateId) : undefined;
  if (!u) return null;
  return named(
    compact,
    "Delegate",
    <span className={cn("flex h-[34px] shrink-0 items-center gap-[7px] rounded-[9px] border border-control-border bg-panel px-[11px] font-mono text-[12.5px] whitespace-nowrap", className)}>
      <span className="grid size-5 place-items-center rounded-md border border-rule bg-sidebar text-ink-2">
        <RobotIcon className="size-3" />
      </span>
      {u.name}
    </span>,
  );
});

/**
 * The parent: an issue of the same project (Plane), never one of the issue's own sub-issues. Once set it is a link to
 * that issue, up to three lines, changed and removed by the buttons its hover lays over the first line, so the title
 * keeps the width. As a chip, and on a phone, it only opens the picker: there the way to the parent is the header's
 * breadcrumb and the line over the title. There it says "Parent": a key beside a title could be any link between issues.
 */
export const ParentProperty = observer(function ParentProperty({ issue, className, compact, ...controlled }: PropertyForm & Controlled) {
  const phone = useIsPhone();
  const live = liveParent(issue);
  const picker = (trigger: ReactElement) => (
    <IssuePicker
      {...controlled}
      projectId={issue.projectId}
      exclude={() => subtree(issue.id, (id) => store.subIssuesOf(id, true))}
      value={live?.id ?? null}
      onChange={(parentId) => store.updateIssue(issue.id, { parentId })}
      placeholder="Set parent…"
      trigger={trigger}
    />
  );
  const key = live && <span className="font-mono text-caption text-ink-3">{store.issueKey(live)}</span>;
  if (!live || phone || compact) {
    return picker(
      named(
        compact,
        live ? `Parent: ${live.title}` : "Parent",
        <Button variant="ghost" className={cn(triggerClass, "min-w-0", className)}>
          {live ? (
            <>
              {(phone || compact) && <span className={placeholderClass}>Parent</span>}
              {key}
              <span className="truncate">{live.title}</span>
            </>
          ) : (
            <span className={placeholderClass}>No parent</span>
          )}
        </Button>,
      ),
    );
  }
  const href = issuePath(live);
  return (
    <span className="group/parent relative -ml-2 min-w-0 flex-1 rounded-md py-[3px] pr-1 pl-2 transition-colors duration-120 hover:bg-row-hover has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring">
      <Link href={href} title={live.title} className="line-clamp-3 text-[13px]/[18px] wrap-anywhere text-ink outline-none">
        {key} {live.title}
      </Link>
      <span className="absolute top-0 right-0 flex h-6 items-center gap-0.5 rounded-md bg-panel pl-1 opacity-0 group-hover/parent:bg-row-hover group-hover/parent:opacity-100 focus-within:opacity-100 has-aria-expanded:opacity-100 pointer-coarse:opacity-100">
        {picker(
          <Button variant="ghost" size="icon-xs" aria-label="Change the parent" title="Change the parent">
            <PencilSimpleIcon />
          </Button>,
        )}
        <Hint label="Remove the parent">
          <Button variant="ghost" size="icon-xs" aria-label="Remove the parent" onClick={() => store.updateIssue(issue.id, { parentId: null })}>
            <XIcon />
          </Button>
        </Hint>
      </span>
    </span>
  );
});

/** Set by + Property, as these pickers have no shortcut of their own; S, P, A and L go through listView.picker. */
type Asked = "cycle" | "startDate" | "dueDate" | "parent";

/**
 * The properties as chips under the title, for an issue beside its list (the IssuePropsChips artboard): the page gets the
 * pane's width, and a chip opens the picker the panel does. What is empty waits behind + Property, and shows as a chip
 * for as long as its picker is open, so that the picker has something to stand on.
 */
export const PropertyChips = observer(function PropertyChips({ issue }: { issue: Issue }) {
  const [asked, setAsked] = useState<Asked | null>(null);
  const picking = listView.picker;
  const control = (what: Asked) => ({ open: asked === what, onOpenChange: (open: boolean) => setAsked(open ? what : null) });
  const has = {
    priority: issue.priority !== 0 || picking === "priority",
    assignees: issue.assigneeIds.length > 0 || picking === "assignees",
    labels: issue.labelIds.length > 0 || picking === "labels",
    cycle: !!issue.cycleId || asked === "cycle",
    start: !!issue.startDate || asked === "startDate",
    due: !!issue.dueDate || asked === "dueDate",
    parent: !!liveParent(issue) || asked === "parent",
  };
  const rows: { label: string; shortcut?: string; shown: boolean; open: () => void }[] = [
    { label: "Priority", shortcut: "P", shown: has.priority, open: () => listView.setPicker("priority") },
    { label: "Assignees", shortcut: "A", shown: has.assignees, open: () => listView.setPicker("assignees") },
    { label: "Labels", shortcut: "L", shown: has.labels, open: () => listView.setPicker("labels") },
    { label: "Cycle", shown: has.cycle, open: () => setAsked("cycle") },
    { label: "Start date", shown: has.start, open: () => setAsked("startDate") },
    { label: "Due date", shown: has.due, open: () => setAsked("dueDate") },
    { label: "Parent", shown: has.parent, open: () => setAsked("parent") },
  ];
  const empty = rows.filter((r) => !r.shown);
  const date = (field: "startDate" | "dueDate") => <DateProperty issue={issue} field={field} compact startOpen={asked === field} onClosed={() => setAsked(null)} />;
  return (
    <div role="toolbar" aria-label="Properties" data-roving="row" data-region-entry className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <StateProperty issue={issue} className={chipClass} compact />
      {has.priority && <PriorityProperty issue={issue} className={chipClass} compact />}
      {has.assignees && <AssigneesProperty issue={issue} className={chipClass} compact />}
      {issue.delegateId && <DelegateChip issue={issue} className={cn(chipShape, "gap-[5px] font-mono text-[11px]")} compact />}
      {has.labels && <LabelsProperty issue={issue} className={cn(chipClass, "gap-2.5 [&_[data-slot=label-tag]]:h-auto [&_[data-slot=label-tag]]:border-0 [&_[data-slot=label-tag]]:px-0")} compact />}
      {has.cycle && <CycleProperty issue={issue} className={chipClass} compact {...control("cycle")} />}
      {(has.start || has.due) && (
        <span className={cn(chipShape, "gap-1 pl-2")}>
          <CalendarBlankIcon className="size-3.5 text-ink-3" />
          {has.start && date("startDate")}
          {has.start && has.due && <span className="text-faint">→</span>}
          {has.due && date("dueDate")}
        </span>
      )}
      {has.parent && <ParentProperty issue={issue} className={cn(chipClass, "max-w-80")} compact {...control("parent")} />}
      {empty.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" className={cn(triggerClass, chipClass, "border-dashed bg-transparent text-ink-3 hover:bg-transparent hover:text-ink")} />}>
            <PlusIcon />
            Property
          </DropdownMenuTrigger>
          {/* The focus goes on to the picker that opens: back on this button, it would close it. */}
          <DropdownMenuContent className="w-44" finalFocus={false}>
            {empty.map((e) => (
              <DropdownMenuItem key={e.label} onClick={e.open}>
                {e.label}
                {e.shortcut && <DropdownMenuShortcut>{e.shortcut}</DropdownMenuShortcut>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
});
