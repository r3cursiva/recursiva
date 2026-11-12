// Project settings › Workflow: the states, in Plane's five groups. Rename in place, drag (or Alt+↑↓ on the handle) to
// reorder or into another group, move the default, add, delete with the issues moved to another state.
//
// Grouped rather than one flat list (the artboard draws one): lists and boards order states by group, then position,
// so a flat drag could put "Done" above "Todo" here and nowhere else. Dropping into another group is the group change.
import { ArrowDownIcon, ArrowUpIcon, PlusIcon } from "@phosphor-icons/react";
import { mayManage } from "@rsva/policy";
import { NAME_MAX, STATE_GROUPS, cleanName, type Project, type StateGroup, type WorkflowState } from "@rsva/schema/models";
import { positionAt } from "@rsva/schema/settings";
import { Badge } from "@rsva/ui/components/badge";
import { Button } from "@rsva/ui/components/button";
import { Label } from "@rsva/ui/components/label";
import { Select } from "@rsva/ui/components/select";
import { SettingsSection } from "@rsva/ui/components/settings";
import { StateIcon } from "@rsva/ui/components/state-icon";
import { Hint } from "@rsva/ui/components/tooltip";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { store } from "../store.ts";
import { attachDragDrop } from "./drag-drop.ts";
import { STATE_GROUP_LABELS } from "./filter-model.ts";
import { CommitInput, ConfirmBar, DeleteButton, OnlyPeopleButton } from "./settings-fields.tsx";
import { StateGlyph } from "./state-glyph.tsx";

/** Issues per state, archived ones too: a state is deleted only once none is left in it. */
function countByState(projectId: string): Map<string, number> {
  const n = new Map<string, number>();
  for (const i of store.issues.values()) if (i.projectId === projectId) n.set(i.stateId, (n.get(i.stateId) ?? 0) + 1);
  return n;
}

/** Moves a state to `index` among its group's states (without it), into `group`. */
function place(state: WorkflowState, group: StateGroup, index: number): void {
  const others = store.statesOf(state.projectId).filter((s) => s.group === group && s.id !== state.id);
  const position = positionAt(others.map((s) => s.position), index);
  store.updateState(state.id, group === state.group ? { position } : { group, position });
}

export const WorkflowSection = observer(function WorkflowSection({ project, scroller }: { project: Project; scroller: () => HTMLElement | null }) {
  const states = store.statesOf(project.id);
  const counts = countByState(project.id);
  const root = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState<StateGroup | null>(null);

  useEffect(() => {
    const el = root.current!;
    return attachDragDrop(el, {
      scroller: scroller() ?? el,
      vertical: true,
      onDrop: (id, from, to) => {
        const s = store.states.get(id);
        if (!s || (from.groupKey === to.groupKey && from.index === to.index)) return;
        place(s, to.groupKey as StateGroup, to.index);
      },
    });
  }, [scroller]);

  return (
    <SettingsSection id="workflow" title="Workflow" description={
        <>
          States an issue moves through. <span className="pointer-coarse:hidden">Drag to reorder, or into another group.</span>
          <span className="hidden pointer-coarse:inline">The arrows reorder them, past the ends into the next group.</span>
        </>
      }>
      <div ref={root} className="mt-2.5 flex flex-col gap-4">
        {STATE_GROUPS.map((g) => {
          const inGroup = states.filter((s) => s.group === g);
          return (
            <div key={g} className="flex flex-col gap-1.5">
              <div className="flex h-6 items-center gap-2 px-0.5">
                <StateIcon group={g} />
                <h3 className="m-0 eyebrow">{STATE_GROUP_LABELS[g]}</h3>
                <Hint label="Add a state">
                  <Button variant="ghost" size="icon-sm" className="ml-auto text-ink-3" aria-label={`Add a ${STATE_GROUP_LABELS[g]} state`} onClick={() => setAdding(g)}>
                    <PlusIcon />
                  </Button>
                </Hint>
              </div>
              <div data-cell data-group={g} className="relative flex min-h-11 flex-col gap-1.5">
                {inGroup.map((s) => (
                  <StateRow key={s.id} state={s} count={counts.get(s.id) ?? 0} only={states.length === 1} />
                ))}
                {inGroup.length === 0 && adding !== g && (
                  <div className="flex h-11 items-center rounded-[7px] border border-dashed border-control-border px-3 text-label text-ink-3">No states</div>
                )}
                {adding === g && <NewState project={project} group={g} onDone={() => setAdding(null)} />}
              </div>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
});

const StateRow = observer(function StateRow({ state, count, only }: { state: WorkflowState; count: number; only: boolean }) {
  const [deleting, setDeleting] = useState(false);
  const others = store.statesOf(state.projectId).filter((s) => s.id !== state.id);
  // Where the issues go: the same group first, then the default, as a person would pick.
  const [moveTo, setMoveTo] = useState(() => (others.find((s) => s.group === state.group) ?? others.find((s) => s.isDefault) ?? others[0])?.id ?? "");
  const pending = store.isPending(state.id);

  /** Alt+↑↓ on the handle: one place up or down in the group, past its edge into the next group. */
  const nudge = (by: -1 | 1) => {
    const group = store.statesOf(state.projectId).filter((s) => s.group === state.group);
    const at = group.findIndex((s) => s.id === state.id);
    const next = at + by;
    if (next >= 0 && next < group.length) return place(state, state.group as StateGroup, next);
    const g = STATE_GROUPS[STATE_GROUPS.indexOf(state.group as StateGroup) + by];
    if (g) place(state, g, by < 0 ? store.statesOf(state.projectId).filter((s) => s.group === g).length : 0);
  };

  return (
    <div
      data-card={state.id}
      className="group/row flex cursor-grab flex-col gap-2.5 rounded-[7px] border bg-panel px-3 py-1.5 select-none transition-[opacity,border-color] duration-200 data-dragging:opacity-40"
    >
      {/* A phone has no drag or Alt+↑↓: arrows move the state, and the row's second line holds them with Make default. */}
      <div className="grid min-h-8 grid-cols-[18px_16px_minmax(0,1fr)_auto_auto_104px_auto] items-center gap-x-3 max-md:grid-cols-[16px_minmax(0,1fr)_auto_auto_auto] max-md:gap-x-1.5">
        <span
          role="button"
          tabIndex={0}
          aria-label={`Move ${state.name}: Alt+Up or Alt+Down`}
          title="Drag, or Alt+↑↓"
          onKeyDown={(e) => {
            if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
            e.preventDefault();
            nudge(e.key === "ArrowUp" ? -1 : 1);
            // The row moved, into another group it is a new element: keep the keyboard on its handle.
            requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-card="${state.id}"] [role=button]`)?.focus());
          }}
          className="grid grid-cols-[3px_3px] gap-0.5 justify-self-center rounded-xs p-0.5 text-ink-3 outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:hidden"
        >
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="size-[3px] rounded-full bg-current" />
          ))}
        </span>
        <StateGlyph state={state} />
        <CommitInput inline value={state.name} aria-label={`Name of ${state.name}`} onCommit={(name) => store.updateState(state.id, { name })} />
        <span className="font-mono text-meta text-ink-3 tabular-nums" title={`${count} issues`}>
          {count}
          {pending && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-signal align-middle" title="Saving" />}
        </span>
        {/* On a phone the switches take the row's second line: the first keeps room for the name. */}
        <span className="contents max-md:order-last max-md:col-span-full max-md:flex max-md:items-center max-md:gap-1.5">
          <OnlyPeopleButton
            name={state.name}
            on={state.onlyPeople}
            editable={!!store.role && mayManage(store.role)}
            hint="Only people move issues here"
            onChange={(onlyPeople) => store.updateState(state.id, { onlyPeople })}
          />
          {state.isDefault ? (
            <Badge className="justify-self-end rounded-sm border-control-border px-1.5 font-mono text-[11px] leading-[1.4] text-ink-2 max-md:text-[11.5px]" title="New issues start here">
              Default
            </Badge>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="justify-self-end text-ink-3 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 max-md:px-1 pointer-coarse:opacity-100"
              onClick={() => store.updateState(state.id, { isDefault: true })}
            >
              Make default
            </Button>
          )}
        </span>
        <span className="flex md:hidden">
          <Button variant="ghost" size="icon-xs" aria-label={`Move ${state.name} up`} className="text-ink-3" onClick={() => nudge(-1)}>
            <ArrowUpIcon />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label={`Move ${state.name} down`} className="text-ink-3" onClick={() => nudge(1)}>
            <ArrowDownIcon />
          </Button>
        </span>
        <DeleteButton name={state.name} open={deleting} onToggle={() => setDeleting(!deleting)} disabled={only} hint={only ? "A project needs a state" : "Delete"} />
      </div>
      {deleting && (
        <ConfirmBar
          action={`Delete ${state.name}`}
          onCancel={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            store.deleteState(state.id, moveTo);
          }}
        >
          {count > 0 || state.isDefault ? (
            <Label className="inline-flex flex-wrap text-[length:inherit] leading-[inherit] font-normal">
              {count > 0 ? `Move its ${count} ${count === 1 ? "issue" : "issues"} to` : "New issues will start in"}
              <Select size="sm" options={others.map((s) => ({ value: s.id, label: s.name }))} value={moveTo} onChange={setMoveTo} />
              {state.isDefault && count > 0 && <span className="text-ink-3">· it becomes the default</span>}
            </Label>
          ) : (
            "No issues are in this state."
          )}
        </ConfirmBar>
      )}
    </div>
  );
});

function NewState({ project, group, onDone }: { project: Project; group: StateGroup; onDone: () => void }) {
  const [name, setName] = useState("");
  const add = () => {
    const v = cleanName(name);
    if (v) store.createState(project.id, v, group);
    onDone();
  };
  return (
    <div className="flex h-11 items-center gap-3 rounded-[7px] border border-ink-3 bg-panel px-3">
      <StateIcon group={group} />
      <input
        autoFocus
        value={name}
        maxLength={NAME_MAX}
        aria-label={`New ${STATE_GROUP_LABELS[group]} state`}
        placeholder={`New ${STATE_GROUP_LABELS[group]!.toLowerCase()} state`}
        onChange={(e) => setName(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
          if (e.key === "Escape") {
            e.stopPropagation();
            onDone();
          }
        }}
        className="h-7 min-w-0 flex-1 bg-transparent font-medium outline-none placeholder:font-normal placeholder:text-ink-3"
      />
      <span className="font-mono text-meta text-ink-3">↵</span>
    </div>
  );
}
