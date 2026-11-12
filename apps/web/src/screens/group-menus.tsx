// The sidebar's groups of projects in the lazy edit chunk (RSVA-566): the + beside Projects, a group's ⋯ menu, and the
// projects to pick for a group right after it is made (the SidebarGroupsAdd artboard).
import { FolderSimplePlusIcon, MagnifyingGlassIcon, PencilSimpleIcon, PlusIcon, SquaresFourIcon, XIcon } from "@phosphor-icons/react";
import { QUIET_CHOICES, type ProjectGroup, type QuietDays } from "@rsva/protocol";
import { Button } from "@rsva/ui/components/button";
import { CollapsibleCaret } from "@rsva/ui/components/collapsible-caret";
import { Kbd } from "@rsva/ui/components/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rsva/ui/components/dropdown-menu";
import { NativeCheckbox } from "@rsva/ui/components/native-checkbox";
import { Popover, PopoverContent } from "@rsva/ui/components/popover";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { viewerCan } from "../lib/roles.ts";
import { store } from "../store.ts";
import type { MenuOrAnchor, MenuProps } from "./lazy-menu.tsx";
import { ProjectMenu } from "./project-menu.tsx";
import { pointAnchor } from "./row-popup.ts";
import { newProject } from "./palette-state.ts";
import { setUi, uiChoice } from "../panes.ts";
import { addToGroup, createGroup, renameGroupTo, ungroup } from "./project-actions.ts";
import { ProjectIcon } from "./sidebar-parts.tsx";
import { sidebar } from "./sidebar-state.ts";

/** The + beside Projects: a new project (who may make one) or a new group, named in place. */
export function ProjectsAddMenu({ open, onOpenChange, trigger }: MenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent className="w-48" align="start">
        {viewerCan("projects.write") && (
          <DropdownMenuItem onClick={() => newProject.show()}>
            <PlusIcon />
            New project
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => sidebar.newGroup()}>
          <FolderSimplePlusIcon />
          New group
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** After how many days with no change a project folds into Quiet by itself, or never: Settings › Preferences' choice. */
const QuietChoices = observer(function QuietChoices() {
  return (
    // The label is a part of the group in Base UI: outside one it throws.
    <DropdownMenuRadioGroup value={String(uiChoice().quiet)} onValueChange={(v: string) => void setUi({ quiet: Number(v) as QuietDays })}>
      <DropdownMenuLabel>Fold into Quiet after</DropdownMenuLabel>
        {QUIET_CHOICES.map((d) => (
          <DropdownMenuRadioItem key={d} value={String(d)}>
            {d ? `${d} days still` : "Never: only when marked"}
          </DropdownMenuRadioItem>
        ))}
    </DropdownMenuRadioGroup>
  );
});

/** The Quiet line's ⋯ (or a right click on it). */
export function QuietMenu({ open, onOpenChange, trigger }: MenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent className="w-52" align="start">
        <QuietChoices />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A group's ⋯ (or a right click on its name): pick its projects, rename it, or let its projects go. */
export function GroupMenu({ open, onOpenChange, trigger, anchor, group }: MenuOrAnchor & { group: ProjectGroup }) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      {trigger && <DropdownMenuTrigger render={trigger} />}
      <DropdownMenuContent className="w-48" align="start" {...(anchor ? { anchor } : {})}>
        <DropdownMenuItem onClick={() => sidebar.pick(group.id)}>
          <SquaresFourIcon />
          Add projects…
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => sidebar.rename(group.id)}>
          <PencilSimpleIcon />
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => ungroup(group)}>
          <XIcon />
          Ungroup
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Projects for a group: only those in no group, so picking never takes one from another group (its menu's Move to group
 * does). Opens beside the group's name; skipped, the group waits empty.
 */
export const GroupPicker = observer(function GroupPicker() {
  const group = store.views.groups.groups.find((g) => g.id === sidebar.picking);
  // The group's name in the full sidebar, its caption in the strip: whichever shows (a hidden one has no box to hold to).
  const anchor = group && [...document.querySelectorAll<HTMLElement>(`[data-group-anchor="${group.id}"]`)].find((el) => el.offsetParent !== null);
  if (!group || !anchor) return null;
  return <Picker key={group.id} group={group} anchor={anchor} />;
});

function Picker({ group, anchor }: { group: ProjectGroup; anchor: Element }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const grouped = new Set(store.views.groups.groups.flatMap((g) => g.ids));
  const hidden = new Set(store.views.hiddenProjects);
  const want = filter.trim().toLowerCase();
  const free = store.projectList().filter((p) => !grouped.has(p.id) && !hidden.has(p.id) && (!want || p.name.toLowerCase().includes(want) || p.key.toLowerCase().includes(want)));
  const close = () => sidebar.pick(null);
  const add = () => {
    addToGroup(group, picked);
    close();
  };
  return (
    <Popover open onOpenChange={(open) => !open && close()}>
      <PopoverContent anchor={anchor} side="right" align="start" sideOffset={10} className="w-60 gap-0 p-1">
        <div className="flex flex-col gap-0.5 px-2 pt-2 pb-2">
          <b className="text-[13px] font-semibold text-ink">Add projects to {group.name}</b>
          <span className="text-[11.5px] text-ink-3">Only projects without a group</span>
        </div>
        <label className="mx-1 mb-1 flex h-7 items-center gap-2 rounded-md px-2 text-ink-3 ring-1 ring-rule">
          <MagnifyingGlassIcon className="size-3.5 shrink-0" />
          <input
            aria-label="Filter projects"
            placeholder="Filter projects"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && picked.length > 0 && add()}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-3 max-md:text-[16px]"
          />
        </label>
        <div className="flex max-h-72 flex-col overflow-y-auto">
          {free.map((p) => (
            <label key={p.id} className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-menu text-ink hover:bg-row-hover max-md:h-11">
              <NativeCheckbox checked={picked.includes(p.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((id) => id !== p.id))} />
              <ProjectIcon project={p}>{p.key[0]}</ProjectIcon>
              <span className="min-w-0 truncate">{p.name}</span>
            </label>
          ))}
          {!free.length && <span className="px-2 py-1.5 text-[12px] text-ink-3">{want ? "No project matches" : "Every project is in a group"}</span>}
        </div>
        <div className="flex items-center justify-between gap-2 px-2 pt-2 pb-1 text-[11px] text-ink-3">
          <span>Or drag projects onto the group later</span>
          <Button type="button" size="sm" disabled={!picked.length} onClick={add} className="shrink-0">
            Add{picked.length ? ` ${picked.length}` : ""}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A group's name typed in place: a new one under the ungrouped projects (Enter makes it and opens the projects to pick),
 * or `group` renamed where its name stands. Enter or leaving it with a name keeps it, Esc or leaving it empty drops it.
 */
export function GroupNameField({ group }: { group?: ProjectGroup }) {
  const initial = group?.name ?? "";
  const [name, setName] = useState(initial);
  const finish = (keep: boolean) => {
    const clean = name.trim();
    sidebar.stopNaming();
    if (!keep || !clean || clean === initial) return;
    if (group) renameGroupTo(group, clean);
    else createGroup(clean);
  };
  return (
    <div className="mt-2.5 flex flex-col gap-1.5 strip:hidden">
      <label className="flex h-7 items-center gap-1.5 rounded-[5px] bg-panel pr-2 pl-1.5 shadow-[inset_0_0_0_1.5px_var(--color-ink)]">
        <CollapsibleCaret open className="text-faint" />
        <input
          autoFocus
          aria-label="Group name"
          value={name}
          placeholder={group?.name ?? "Group name"}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") finish(true);
            else if (e.key === "Escape") finish(false);
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
          onBlur={() => finish(true)}
          className="min-w-0 flex-1 bg-transparent text-[12.5px] font-medium text-ink outline-none placeholder:text-faint"
        />
      </label>
      <span className="flex items-center gap-1.5 pl-2 text-[11px] text-ink-3">
        <Kbd>↵</Kbd> {group ? "rename" : "create"} <Kbd>esc</Kbd> cancel
      </span>
    </div>
  );
}

/** A project's or a group's menu at the pointer, after a right click in the strip (sidebar.menuAt). */
export const StripMenu = observer(function StripMenu() {
  const at = sidebar.menuAt;
  if (!at) return null;
  const shell = { open: true, onOpenChange: (open: boolean) => !open && sidebar.closeMenu(), anchor: pointAnchor(at.x, at.y) };
  if (at.kind === "group") {
    const group = store.views.groups.groups.find((g) => g.id === at.id);
    return group ? <GroupMenu key={`${at.x},${at.y}`} {...shell} group={group} /> : null;
  }
  const project = store.projects.get(at.id);
  return project ? <ProjectMenu key={`${at.x},${at.y}`} {...shell} project={project} /> : null;
});
