// Property pickers shared by the issue pane, the create modal and the inline editors of list rows and board cards. They take
// a value and report a new one, so the same picker edits a stored issue or a draft. Like Plane, every picker has a
// search field; priority too, so typing "hi" + Enter picks High.
//
// Each picker is either attached to its own trigger (the issue pane, the modal) or, without one, placed at `anchor` (rows and
// cards share one lazily loaded popup instead of mounting a picker per cell, see row-popup.ts).
import { ArrowsClockwiseIcon, CircleDashedIcon, MinusIcon } from "@phosphor-icons/react";
import { sortedCycles } from "@rsva/query";
import { ColorDot } from "@rsva/ui/components/color-chip";
import { PriorityIcon } from "@rsva/ui/components/priority-icon";
import { SearchSelect, type PopupAnchor, type SearchSelectOption } from "@rsva/ui/components/search-select";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { face } from "../lib/face.ts";
import { observer } from "mobx-react-lite";
import { assignable, PRIORITIES, type Issue } from "@rsva/schema/models";
import { useState, type ReactElement } from "react";
import { cycleRange, daysLeft, statusOf } from "../lib/cycles.ts";
import { store } from "../store.ts";
import { StateGlyph } from "./state-glyph.tsx";

/** Where and when the popup shows: with a trigger of its own, or controlled and placed at an anchor. */
export interface PickerShell {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactElement;
  anchor?: PopupAnchor;
  /** Values only some of the marked issues have (the bulk bar, RSVA-303): a dash instead of the check. */
  mixed?: ReadonlySet<string>;
}

/** Drops undefined props: SearchSelect's optional props do not take an explicit undefined. */
function shell({ open, onOpenChange, trigger, anchor, mixed }: PickerShell) {
  return {
    ...(mixed?.size ? { mixed } : {}),
    ...(open === undefined ? {} : { open }),
    ...(onOpenChange ? { onOpenChange } : {}),
    ...(trigger ? { trigger } : {}),
    ...(anchor ? { anchor } : {}),
  };
}

export const StatePicker = observer(function StatePicker({
  projectId,
  value,
  onChange,
  ...rest
}: PickerShell & { projectId: string; value: string | null; onChange: (stateId: string) => void }) {
  return (
    <SearchSelect
      {...shell(rest)}
      placeholder="Change state…"
      options={store.statesOf(projectId).map((s) => ({ value: s.id, label: s.name, icon: <StateGlyph state={s} /> }))}
      value={value}
      onChange={onChange}
    />
  );
});

const PRIORITY_OPTIONS = PRIORITIES.map((p) => ({ value: String(p.code), label: p.name, icon: <PriorityIcon priority={p.code} /> }));

export function PriorityPicker({ value, onChange, ...rest }: PickerShell & { value: number; onChange: (priority: number) => void }) {
  return (
    <SearchSelect
      {...shell(rest)}
      className="w-44"
      placeholder="Change priority…"
      options={PRIORITY_OPTIONS}
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
    />
  );
}

export const AssigneesPicker = observer(function AssigneesPicker({
  value,
  onChange,
  ...rest
}: PickerShell & { value: readonly string[]; onChange: (assigneeIds: string[]) => void }) {
  const users = assignable(store.users.values());
  return (
    <SearchSelect
      {...shell(rest)}
      multiple
      placeholder="Assign to…"
      options={users.map((u) => ({ value: u.id, label: u.name, icon: <UserAvatar {...face(u)} className="size-4" /> }))}
      value={value}
      onChange={onChange}
    />
  );
});

export const LabelsPicker = observer(function LabelsPicker({
  projectId,
  value,
  onChange,
  ...rest
}: PickerShell & { projectId: string; value: readonly string[]; onChange: (labelIds: string[]) => void }) {
  return (
    <SearchSelect
      {...shell(rest)}
      multiple
      placeholder="Add labels…"
      options={store.labelsOf(projectId).map((l) => ({ value: l.id, label: l.name, icon: <ColorDot color={l.color} /> }))}
      value={value}
      onChange={onChange}
    />
  );
});

/** The value of "No cycle" (and "No lead", "No parent") among the options. */
const NO_CYCLE = "";

/** One member or nobody: a cycle's lead (PLNR-63). */
export const LeadPicker = observer(function LeadPicker({ value, onChange, ...rest }: PickerShell & { value: string | null; onChange: (userId: string | null) => void }) {
  const users = [...store.users.values()].filter((u) => u.role !== null && u.kind !== "agent").sort((a, b) => a.name.localeCompare(b.name));
  return (
    <SearchSelect
      {...shell(rest)}
      placeholder="Lead…"
      options={[...users.map((u) => ({ value: u.id, label: u.name, icon: <UserAvatar {...face(u)} className="size-4" /> })), { value: NO_CYCLE, label: "No lead", icon: <MinusIcon /> }]}
      value={value ?? NO_CYCLE}
      onChange={(v) => onChange(v === NO_CYCLE ? null : v)}
    />
  );
});

/**
 * A cycle of the project (PLNR-63): the active one, upcoming ones, drafts, or none. Completed cycles take no new issues,
 * so they are not offered; the issue's own completed cycle still shows as the current value.
 */
export const CyclePicker = observer(function CyclePicker({
  projectId,
  value,
  onChange,
  ...rest
}: PickerShell & { projectId: string; value: string | null; onChange: (cycleId: string | null) => void }) {
  const GROUP = { active: "Active", ended: "Active", upcoming: "Upcoming", draft: "Drafts", completed: "Completed" } as const;
  const cycles = sortedCycles(store.cyclesOf(projectId)).map((c): SearchSelectOption => {
    const status = statusOf(c);
    const meta = status === "draft" ? "no dates" : status === "active" ? `${cycleRange(c)} · ${daysLeft(c)}` : cycleRange(c);
    return { value: c.id, label: `${c.name} · ${meta}`, group: GROUP[status], icon: status === "draft" ? <CircleDashedIcon /> : <ArrowsClockwiseIcon /> };
  });
  return (
    <SearchSelect
      {...shell(rest)}
      className="w-80"
      placeholder="Move to cycle…"
      empty="No cycles"
      options={[...cycles, { value: NO_CYCLE, label: "No cycle", icon: <MinusIcon />, group: "" }]}
      value={value ?? NO_CYCLE}
      onChange={(v) => onChange(v === NO_CYCLE ? null : v)}
      footer={<p className="px-2 py-1.5 text-caption text-ink-3">Completed cycles are read-only, so they aren’t offered.</p>}
    />
  );
});

/**
 * An issue searched by key and title: of the project (the parent of an issue, or an existing issue to make its sub-issue),
 * or of the whole workspace with `projectId` null (a relation). `exclude` leaves out what would make a loop
 * (lib/issue-tree.ts). It sits in every issue panel and the create modal, so the options (one per issue) and `exclude`
 * are built only while it is open.
 */
export const IssuePicker = observer(function IssuePicker({
  projectId,
  exclude,
  value,
  onChange,
  placeholder,
  clear,
  open: openProp,
  onOpenChange,
  ...rest
}: PickerShell & {
  projectId: string | null;
  exclude: () => ReadonlySet<string>;
  value: string | null;
  onChange: (issueId: string) => void;
  placeholder: string;
  /** The label of a last option that picks none, reported as "" (the bulk bar's "No parent"). */
  clear?: string;
}) {
  const [own, setOwn] = useState(false);
  const open = openProp ?? own;
  const option = (i: Issue) => {
    const s = store.states.get(i.stateId);
    return { value: i.id, label: `${store.issueKey(i)} ${i.title}`, icon: s && <StateGlyph state={s} /> };
  };
  let options: SearchSelectOption[] = [];
  if (open) {
    const out = exclude();
    const issues = projectId ? store.issuesOf(projectId) : store.projectList().flatMap((p) => store.issuesOf(p.id));
    options = issues.filter((i) => !out.has(i.id) && i.number > 0).map(option);
    if (clear) options.push({ value: NO_CYCLE, label: clear, icon: <MinusIcon /> });
  } else {
    const current = value ? store.issues.get(value) : undefined;
    if (current) options = [option(current)];
  }
  return (
    <SearchSelect
      {...shell(rest)}
      open={open}
      onOpenChange={(o) => {
        setOwn(o);
        onOpenChange?.(o);
      }}
      className="w-80"
      placeholder={placeholder}
      empty="No issues"
      options={options}
      value={value}
      onChange={onChange}
    />
  );
});
