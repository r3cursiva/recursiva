// The View panel's filters (PLNR-74; one line each since PLNR-291): a line per field with "is" / "is not" and what it is,
// its values in a menu, each with how many issues it would show given the other filters. Counting is local, over the
// issues the list runs on, so it costs no request, and only while that menu is open. Labels and states show with their
// color or glyph, as the lists show them (PLNR-48). Across projects one name stands for every project's state or label of it.
import {
  ArrowsClockwiseIcon,
  CalendarBlankIcon,
  CaretDownIcon,
  CellSignalHighIcon,
  CircleHalfIcon,
  CopyIcon,
  HourglassMediumIcon,
  LinkSimpleIcon,
  MinusIcon,
  PlusIcon,
  ProhibitIcon,
  RobotIcon,
  SquaresFourIcon,
  TagIcon,
  TreeStructureIcon,
  UserCircleDashedIcon,
  UserIcon,
  UserPlusIcon,
  XIcon,
  type Icon,
} from "@phosphor-icons/react";
import { compileFilter, DISPLAY_PROPERTY_OPTIONS, localToday, PRIORITY_ORDER, resolveDateExpr, runQueryRows, sortedCycles, sortedStates, type Filter } from "@rsva/query";
import type { Project } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { ColorDot } from "@rsva/ui/components/color-chip";
import { PriorityIcon } from "@rsva/ui/components/priority-icon";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { Hint } from "@rsva/ui/components/tooltip";
import { UserAvatar, type Face } from "@rsva/ui/components/user-avatar";
import { face } from "../lib/face.ts";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useState, type ReactNode } from "react";
import { store } from "../store.ts";
import { listIssues, queryContext, WS_SCOPE, type ProjectView } from "../view-state.ts";
import { DATE_MENU, valueName } from "./filter-model.ts";
import { ProjectIcon } from "./sidebar-parts.tsx";
import { IssueStateGlyph, StateGlyph } from "./state-glyph.tsx";

type ListField = "project" | "state" | "priority" | "assignee" | "delegate" | "label" | "cycle" | "parent" | "is" | "has" | "createdBy";
type Field = ListField | "dueDate";

const FIELD_LABEL: Record<Field, string> = {
  project: "Project",
  state: "Status",
  priority: "Priority",
  assignee: "Assignee",
  delegate: "Agent",
  label: "Label",
  cycle: "Cycle",
  parent: "Parent",
  is: "Relation",
  has: "Links",
  createdBy: "Created by",
  dueDate: "Due",
};

const FIELD_NOUN: Record<Field, string> = {
  project: "projects",
  state: "statuses",
  priority: "priorities",
  assignee: "people",
  delegate: "agents",
  label: "labels",
  cycle: "cycles",
  parent: "parents",
  is: "relations",
  has: "links",
  createdBy: "people",
  dueDate: "dates",
};

const FIELD_ICON: Record<Field, Icon> = {
  project: SquaresFourIcon,
  state: CircleHalfIcon,
  priority: CellSignalHighIcon,
  assignee: UserIcon,
  delegate: RobotIcon,
  label: TagIcon,
  cycle: ArrowsClockwiseIcon,
  parent: TreeStructureIcon,
  is: ProhibitIcon,
  has: LinkSimpleIcon,
  createdBy: UserPlusIcon,
  dueDate: CalendarBlankIcon,
};

interface Option {
  id: string;
  label: string;
  icon: ReactNode;
  /** The filter values the pill stands for: several when one name is every project's state or label. */
  values: (string | number)[];
}

const people = () => [...store.users.values()].filter((u) => u.role !== null).sort((a, b) => a.name.localeCompare(b.name));

/** One pill per name: across projects, every project's state or label of that name. */
function byName<T extends { id: string; name: string }>(items: readonly T[], icon: (t: T) => ReactNode): Option[] {
  const out = new Map<string, Option>();
  for (const t of items) {
    const k = t.name.toLowerCase();
    const o = out.get(k);
    if (o) o.values.push(t.id);
    else out.set(k, { id: t.id, label: t.name, icon: icon(t), values: [t.id] });
  }
  return [...out.values()];
}

function options(field: Field, view: ProjectView): Option[] {
  const project = view.scope === WS_SCOPE ? null : view.scope;
  const ctx = queryContext(view.scope);
  const person = (id: string, who: Face, icon?: ReactNode): Option => ({ id, label: who.name, icon: icon ?? <UserAvatar {...who} className="size-4" />, values: [id] });
  const nobody = <UserCircleDashedIcon className="size-4 text-ink-3" />;
  switch (field) {
    case "project":
      return store.projectList().map((p) => ({ id: p.id, label: p.name, icon: <ProjectIcon project={p} />, values: [p.id] }));
    case "state":
      return byName(project ? store.statesOf(project) : sortedStates(store.states.values()), (s) => <StateGlyph state={s} />);
    case "priority":
      return PRIORITY_ORDER.map((p) => ({ id: String(p), label: valueName("priority", p, ctx), icon: <PriorityIcon priority={p} />, values: [p] }));
    case "assignee":
    case "createdBy":
      return [
        ...(store.me ? [person("me", { ...face(store.me), name: "You" })] : []),
        ...people().map((u) => person(u.id, face(u))),
        ...(field === "assignee" ? [person("none", { name: "Nobody" }, nobody)] : []),
      ];
    case "delegate":
      return [
        person("any", { name: "Any agent" }, <RobotIcon className="size-4 text-ink-3" />),
        ...people()
          .filter((u) => u.kind === "agent")
          .map((u) => person(u.id, face(u))),
        person("none", { name: "No agent" }, nobody),
      ];
    case "label":
      return byName(project ? store.labelsOf(project) : [...store.labels.values()].sort((a, b) => a.position - b.position), (l) => <ColorDot color={l.color} />);
    // Active and Next follow the calendar (a saved view of the active cycle moves on by itself), then each cycle by name.
    case "cycle": {
      const icon = <ArrowsClockwiseIcon className="size-4 text-ink-3" />;
      return [
        { id: "active", label: "Active cycle", icon, values: ["active"] },
        { id: "next", label: "Next cycle", icon, values: ["next"] },
        ...byName(sortedCycles(project ? store.cyclesOf(project) : store.cycles.values()), () => icon),
        { id: "none", label: "No cycle", icon: <MinusIcon className="size-4 text-ink-3" />, values: ["none"] },
      ];
    }
    // Any and None, then each parent the list's issues have: a project holds far more issues than it has parents.
    case "parent": {
      const icon = <TreeStructureIcon className="size-4 text-ink-3" />;
      const word = (v: string, glyph: ReactNode = icon): Option => ({ id: v, label: valueName("parent", v, ctx), icon: glyph, values: [v] });
      const parents = [...new Set(listIssues(project).flatMap((i) => i.parentId ?? []))].flatMap((id) => ctx.issues?.get(id) ?? []);
      return [
        word("any"),
        ...parents.sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1)).map((p) => word(p.id, <IssueStateGlyph issue={p} />)),
        word("none", <MinusIcon className="size-4 text-ink-3" />),
      ];
    }
    case "is":
      return [
        { id: "blocked", label: valueName("is", "blocked", ctx), icon: <ProhibitIcon className="size-4 text-ink-3" />, values: ["blocked"] },
        { id: "blocking", label: valueName("is", "blocking", ctx), icon: <HourglassMediumIcon className="size-4 text-ink-3" />, values: ["blocking"] },
        { id: "duplicate", label: valueName("is", "duplicate", ctx), icon: <CopyIcon className="size-4 text-ink-3" />, values: ["duplicate"] },
      ];
    case "has":
      return [{ id: "link", label: valueName("has", "link", ctx), icon: <LinkSimpleIcon className="size-4 text-ink-3" />, values: ["link"] }];
    case "dueDate": {
      const today = localToday();
      return DATE_MENU.dueDate.flatMap((p) => {
        const r = resolveDateExpr(p, today);
        return "range" in r ? [{ id: p, label: describe(p), icon: null, values: [p] }] : [];
      });
    }
  }
}

const describe = (preset: string) => ({ "<today": "Overdue", today: "Today", "next-7-days": "Within 7 days", "next-2-weeks": "Within 2 weeks", "next-30-days": "Within 30 days", "this-month": "This month", none: "No due date" })[preset] ?? preset;

/** The filter without one field, both ways: what that field's counts are taken against. */
function without(f: Filter, field: Field): Filter {
  const out: Filter = { ...f };
  delete out[field];
  if (f.not && field !== "dueDate") {
    const not = { ...f.not };
    delete not[field];
    out.not = not;
  }
  return out;
}

const valuesIn = (f: Filter | undefined, field: ListField) => (f?.[field] ?? []) as (string | number)[];

export const FilterLines = observer(function FilterLines({ view, project }: { view: ProjectView; project: Project | null }) {
  const [added, setAdded] = useState<Field[]>([]);
  // The field just added from the menu: its line opens its values at once.
  const [opening, setOpening] = useState<Field | null>(null);
  const f = view.filter;
  const fields: Field[] = (view.scope === WS_SCOPE ? (["project"] as Field[]) : []).concat(["state", "priority", "assignee", "delegate", "label", "cycle", "parent", "is", "has", "createdBy", "dueDate"]);
  const active = fields.filter((k) => (k === "dueDate" ? !!f.dueDate : valuesIn(f, k).length + valuesIn(f.not, k).length > 0) || added.includes(k));
  const idle = fields.filter((k) => !active.includes(k));
  return (
    <div className="flex flex-col gap-1.5 max-md:gap-2">
      {active.map((field) => (
        <FilterLine
          key={field}
          field={field}
          view={view}
          project={project}
          autoOpen={opening === field}
          onRemove={() => {
            setAdded((a) => a.filter((k) => k !== field));
            view.setFilter(without(f, field));
          }}
        />
      ))}
      {idle.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" className="w-fit gap-1.5 px-1.5 font-normal text-ink-2 hover:text-ink transition-none active:scale-100! max-md:px-2.5">
                <PlusIcon />
                Add filter
              </Button>
            }
          />
          <DropdownMenuContent className="w-48" align="start">
            {idle.map((k) => {
              const I = FIELD_ICON[k];
              return (
                <DropdownMenuItem
                  key={k}
                  onClick={() => {
                    setAdded((a) => [...a, k]);
                    setOpening(k);
                  }}
                >
                  <I className="text-ink-3" />
                  {FIELD_LABEL[k]}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
});

/** One filter on one line: the field, "is" or "is not" (a press flips it), what it is (a menu of values with counts), ×. */
const FilterLine = observer(function FilterLine({ field, view, project, autoOpen, onRemove }: { field: Field; view: ProjectView; project: Project | null; autoOpen: boolean; onRemove: () => void }) {
  const f = view.filter;
  const today = localToday();
  const negated = field !== "dueDate" && valuesIn(f.not, field).length > 0;
  const current = field === "dueDate" ? [f.dueDate?.none ? "none" : (f.dueDate?.preset ?? "")] : valuesIn(negated ? f.not : f, field);
  const opts = options(field, view);
  const isOn = (o: Option) => o.values.every((v) => current.includes(v));
  const chosen = opts.filter(isOn);
  const toggle = (o: Option) => {
    if (field === "dueDate") {
      const r = resolveDateExpr(String(o.values[0]), today);
      const next = { ...f };
      if (current[0] === o.values[0] || !("range" in r)) delete next.dueDate;
      else next.dueDate = r.range;
      return view.setFilter(next);
    }
    const values = isOn(o) ? current.filter((v) => !o.values.includes(v)) : [...current, ...o.values.filter((v) => !current.includes(v))];
    view.setFilter(put(f, field, negated, values));
  };
  const I = FIELD_ICON[field];
  const seg = "flex items-center border-l border-control-border outline-none transition-colors duration-120 hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
  return (
    <div role="group" aria-label={`${FIELD_LABEL[field]} filter`} className="flex h-7 min-w-0 items-stretch overflow-hidden rounded-md border border-control-border bg-ground text-[12.5px] max-md:h-11 max-md:rounded-lg max-md:text-[14px]">
      {/* One width for every field's name, so the "is" and the values line up down the lines. */}
      <span className="flex w-26 shrink-0 items-center gap-1.5 px-2 text-ink-2 max-md:w-31 max-md:px-3">
        <I className="size-3.5 text-ink-3 max-md:size-4" />
        {FIELD_LABEL[field]}
      </span>
      {field !== "dueDate" && (
        <Hint label={negated ? "Switch to is" : "Switch to is not"}>
          <button
            type="button"
            aria-label={`${FIELD_LABEL[field]}: ${negated ? "is not" : "is"}, switch`}
            onClick={() => view.setFilter(put(put(f, field, negated, []), field, !negated, current))}
            className={cn(seg, "shrink-0 px-2 text-ink-3 hover:text-ink max-md:px-3", negated && "text-signal-text hover:text-signal-text")}
          >
            {negated ? "is not" : "is"}
          </button>
        </Hint>
      )}
      <DropdownMenu defaultOpen={autoOpen}>
        <DropdownMenuTrigger
          aria-label={`${FIELD_LABEL[field]} values`}
          render={<button type="button" className={cn(seg, "min-w-0 flex-1 gap-1.5 px-2 text-left text-ink max-md:px-3")} />}
        >
          {chosen.length === 0 ? (
            <span className="truncate text-ink-3">pick at least one</span>
          ) : (
            <>
              {chosen.some((o) => o.icon) && (
                <span className="flex shrink-0 items-center -space-x-1 [&_[data-slot=avatar]]:size-4 [&>span]:grid [&>span]:place-items-center">
                  {chosen.slice(0, 3).map((o) => o.icon && <span key={o.id}>{o.icon}</span>)}
                </span>
              )}
              <span className="truncate">{chosen.length <= 2 ? chosen.map((o) => o.label).join(", ") : `${chosen.length} ${FIELD_NOUN[field]}`}</span>
            </>
          )}
          <CaretDownIcon className="ml-auto size-3 shrink-0 text-ink-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64" align="start">
          <ValueItems field={field} view={view} project={project} opts={opts} isOn={isOn} toggle={toggle} />
        </DropdownMenuContent>
      </DropdownMenu>
      <Hint label={`Remove ${FIELD_LABEL[field]} filter`}>
        <button type="button" aria-label={`Remove ${FIELD_LABEL[field]} filter`} onClick={onRemove} className={cn(seg, "shrink-0 justify-center px-1.5 text-ink-3 hover:text-ink max-md:w-11")}>
          <XIcon className="size-3 max-md:size-4" />
        </button>
      </Hint>
    </div>
  );
});

/** A field's values with how many issues each would show given the other filters: counted only while the menu is open. */
const ValueItems = observer(function ValueItems({
  field,
  view,
  project,
  opts,
  isOn,
  toggle,
}: {
  field: Field;
  view: ProjectView;
  project: Project | null;
  opts: Option[];
  isOn: (o: Option) => boolean;
  toggle: (o: Option) => void;
}) {
  const ctx = queryContext(project?.id ?? view.scope);
  const today = localToday();
  const display = { ...view.display, properties: DISPLAY_PROPERTY_OPTIONS.map((o) => o.value) };
  const base = runQueryRows(listIssues(project?.id ?? null), without(view.filter, field), display, ctx);
  const count = (o: Option) => {
    const c = compileFilter(field === "dueDate" ? { dueDate: (resolveDateExpr(String(o.values[0]), today) as { range: Filter["dueDate"] }).range! } : { [field]: o.values }, ctx, today);
    return c ? base.filter(c).length : base.length;
  };
  return opts.map((o) => (
    <DropdownMenuCheckboxItem key={o.id} checked={isOn(o)} onCheckedChange={() => toggle(o)}>
      {o.icon && <span className="grid size-4 shrink-0 place-items-center [&_[data-slot=avatar]]:size-4">{o.icon}</span>}
      <span className="min-w-0 truncate">{o.label}</span>
      <span className="ml-auto pl-2 font-mono text-[11px] text-ink-3 tabular-nums">{count(o)}</span>
    </DropdownMenuCheckboxItem>
  ));
});

/** The filter with one field's values put on its "is" or its "is not" side; an empty list removes it there. */
function put(f: Filter, field: ListField, not: boolean, values: (string | number)[]): Filter {
  if (!not) {
    const out = { ...f } as Record<string, unknown>;
    if (values.length) out[field] = values;
    else delete out[field];
    return out as Filter;
  }
  const neg = { ...(f.not ?? {}) } as Record<string, unknown>;
  if (values.length) neg[field] = values;
  else delete neg[field];
  const { not: _, ...rest } = f;
  return Object.keys(neg).length ? { ...rest, not: neg as NonNullable<Filter["not"]> } : rest;
}
