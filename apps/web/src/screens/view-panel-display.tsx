// Display (PLNR-74; rows since PLNR-291), a popover at its button apart from the View panel (PLNR-109, ADR 0045):
// grouping, sub-grouping on the board and order as selects, sub-issues and empty groups as switches, then the
// visible properties as chips, and Reset. List or Board is the viewer's own, in the tab row (V); on a phone it heads
// this popover instead (PLNR-400), so the row has room for the tabs and both buttons.
import { DISPLAY_PROPERTY_OPTIONS, GROUP_BY_OPTIONS, ORDER_BY_OPTIONS, type GroupBy } from "@rsva/query";
import type { Project } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@rsva/ui/components/popover";
import { Select } from "@rsva/ui/components/select";
import { Switch } from "@rsva/ui/components/switch";
import { observer } from "mobx-react-lite";
import type { ProjectView } from "../view-state.ts";
import { LayoutToggle } from "./layout-switch.tsx";
import type { MenuProps } from "./lazy-menu.tsx";
import { FieldRow, ToggleChips } from "./menu-parts.tsx";
import { resetDisplay } from "./view-actions.ts";

const SUB_GROUP_OPTIONS: readonly { value: GroupBy; label: string }[] = [
  ...GROUP_BY_OPTIONS.filter((o) => o.value !== "none" && o.value !== "project"),
  { value: "none", label: "None" },
];

const SELECT = "w-40 max-md:w-48";

/** No `project`: grouping by project is offered (a view's own page); in a project it would be one group. */
const DisplayControls = observer(function DisplayControls({ view, project }: { view: ProjectView; project: Project | null }) {
  const d = view.display;
  const groups = !project ? GROUP_BY_OPTIONS : GROUP_BY_OPTIONS.filter((o) => o.value !== "project");
  const shown = new Set(d.properties);
  return (
    <div className="flex flex-col">
      <div className="md:hidden">
        <FieldRow label="Layout" group>
          <LayoutToggle list={view} project={project} labels />
        </FieldRow>
      </div>
      <FieldRow label="Group by">
        <Select size="sm" aria-label="Group by" options={groups} value={d.groupBy} onChange={(groupBy) => view.setDisplay({ groupBy })} className={SELECT} />
      </FieldRow>
      {view.layout === "board" && (
        <FieldRow label="Sub-group by">
          <Select
            size="sm"
            aria-label="Sub-group by"
            options={SUB_GROUP_OPTIONS}
            value={d.subGroupBy ?? "none"}
            onChange={(v) => view.setDisplay({ subGroupBy: v === "none" ? null : v })}
            className={SELECT}
          />
        </FieldRow>
      )}
      <FieldRow label="Order by">
        <Select size="sm" aria-label="Order by" options={ORDER_BY_OPTIONS} value={d.orderBy} onChange={(orderBy) => view.setDisplay({ orderBy })} className={SELECT} />
      </FieldRow>
      <FieldRow label="Sub-issues">
        <Switch size="sm" checked={d.showSubIssues} onCheckedChange={(showSubIssues) => view.setDisplay({ showSubIssues })} />
      </FieldRow>
      <FieldRow label="Empty groups">
        <Switch size="sm" checked={d.showEmptyGroups} onCheckedChange={(showEmptyGroups) => view.setDisplay({ showEmptyGroups })} />
      </FieldRow>
      <div className="flex flex-col gap-1.5 pt-2">
        <span className="text-label text-ink-2">Properties</span>
        <ToggleChips
          label="Properties"
          options={DISPLAY_PROPERTY_OPTIONS.map((p) => ({
            label: p.label,
            on: shown.has(p.value),
            toggle: () =>
              view.setDisplay({
                properties: shown.has(p.value) ? d.properties.filter((x) => x !== p.value) : DISPLAY_PROPERTY_OPTIONS.map((o) => o.value).filter((v) => v === p.value || shown.has(v)),
              }),
          }))}
        />
      </div>
    </div>
  );
});

/**
 * Its edits count as the panel's did: at once on the list, marked on a view's tab, saved or reverted in the View panel.
 * Reset takes back Display's alone: to the saved view's, or All issues' default, with Undo in the toast.
 */
export const DisplayMenu = observer(function DisplayMenu({ open, onOpenChange, trigger, list, project }: MenuProps & { list: ProjectView; project: Project | null }) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent aria-label="Display" align="end" className="max-h-(--available-height) w-[min(22rem,calc(100vw-2rem))] gap-2 overflow-y-auto p-3">
        <DisplayControls view={list} project={project} />
        <Button variant="ghost" className="self-end" disabled={!list.displayEdited} onClick={() => resetDisplay(list)}>
          Reset
        </Button>
      </PopoverContent>
    </Popover>
  );
});
