// The sidebar's projects (RSVA-566, the SidebarGroups artboards): the ungrouped ones on top, then the viewer's groups,
// each folding on a click on its name, then one Quiet line for the projects nothing happens in. Collapsed to the strip,
// a group is a three-letter caption over its tiles, or the caption alone on a plate while folded; Quiet is +N. A click
// folds or opens either, as in the full sidebar. The groups are the viewer's own and follow them to their other devices
// (lib/project-groups.ts).
//
// Considered for the strip (owner 2026-11-09): the artboard's stack of tiles for a folded group (the caption alone, as it
// looks on hover, reads lighter) and its projects listed beside a folded group or +N on hover (with a click that unfolds,
// the full sidebar has no such list, and neither has the strip now).
import { DotsThreeIcon, EyeSlashIcon, PlusIcon } from "@phosphor-icons/react";
import type { ProjectGroup } from "@rsva/protocol";
import { localToday } from "@rsva/query";
import { cycleStatus, type Project } from "@rsva/schema/models";
import { capCount } from "@rsva/schema/util";
import { Button } from "@rsva/ui/components/button";
import { CollapsibleCaret } from "@rsva/ui/components/collapsible-caret";
import { cn } from "@rsva/ui/lib/utils";
import { computed } from "mobx";
import { observer } from "mobx-react-lite";
import type { ComponentType, MouseEvent } from "react";
import { Link } from "../link.tsx";
import { caption, isQuiet, layOut, toggleFold, type ProjectSignals, type QuietRow } from "../lib/project-groups.ts";
import { viewerCan } from "../lib/roles.ts";
import { projectPath, uiChoice } from "../panes.ts";
import { markNavStart } from "../perf.ts";
import { paths, router } from "../router.ts";
import { myAsks } from "../lib/my-asks.ts";
import { store } from "../store.ts";
import { LazyMenu, type MenuProps } from "./lazy-menu.tsx";
import { chunk, chunkWhen, loadEditChunk } from "./load-edit-chunk.ts";
import { attachProjects, Divider, DragArea, dropCell, heading, itemLabel, navItem, ProjectIcon, rowButton } from "./sidebar-parts.tsx";
import { sidebar } from "./sidebar-state.ts";
import { Tip, TipNote } from "./sidebar-tip.tsx";

const ProjectMenu = chunk("ProjectMenu");
const GroupMenu = chunk("GroupMenu");
const QuietMenu = chunk("QuietMenu");
const ProjectsAddMenu = chunk("ProjectsAddMenu");
const GroupPicker = chunkWhen("GroupPicker", () => sidebar.picking);
const StripMenu = chunkWhen("StripMenu", () => sidebar.menuAt);
// The name field of a new group or one being renamed: drawn only while one is typed.
const GroupNameField = chunkWhen("GroupNameField", () => sidebar.naming || sidebar.renaming);

/** Projects where something waits on the viewer, by the one rule (lib/my-asks.ts): a review, a reply, a mention; not a proposal. */
const waiting = computed(() => new Set(myAsks.get().map((x) => x.issue.projectId)));

const signals: ProjectSignals = {
  lastChange: (id) => store.lastChange(id),
  waits: (id) => waiting.get().has(id),
  overdue: (id) => store.hasOverdue(id, localToday()),
  inCycle: (id) => store.cyclesOf(id).some((c) => cycleStatus(c, localToday()) === "active"),
};

const toggleGroup = (id: string) => store.views.setGroups(toggleFold(store.views.groups, id));

/** Whether the project is in Quiet now: for its menu's Mark as quiet. */
export const quietNow = (id: string): boolean => isQuiet(id, store.views.groups, signals, Date.now(), uiChoice().quiet);

/** A group's name, its count and the Quiet line: quiet text over a row of their own. */
const groupHead =
  "flex h-6 w-full items-center gap-1.5 rounded-[5px] pr-2 pl-1.5 text-left text-[12px] font-medium text-ink-3 outline-none transition-colors duration-120 hover:bg-row-hover hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-ring";
/** The group a dragged project is over: its name lights up, as the drop joins it. */
const dropOver = "in-data-drop-over:bg-row-selected in-data-drop-over:text-ink in-data-drop-over:shadow-[inset_0_0_0_1.5px_var(--color-ink)]";
const dot = "size-1.5 shrink-0 rounded-full bg-signal";

/**
 * The heading opens All projects, where the archived ones are too (they left the sidebar, PLNR-58); its + a new project
 * (admins, PLNR-59) or a new group. Below it the projects in the viewer's own order: a row dragged here moves in All
 * projects too (ADR 0020), and onto a group it joins that group. The ones they hid stay in All projects, behind one
 * line; the open one shows even when hidden or quiet, so the page has its place.
 */
export const ProjectsSection = observer(function ProjectsSection({ ws, activeKey }: { ws: string; activeKey: string | null }) {
  const hidden = new Set(store.views.hiddenProjects);
  const all = store.projectList();
  const shown = hidden.size ? all.filter((p) => !hidden.has(p.id) || p.key === activeKey) : all;
  const away = all.length - shown.length;
  const groups = store.views.groups;
  const now = Date.now();
  const activeId = shown.find((p) => p.key === activeKey)?.id ?? null;
  const days = uiChoice().quiet;
  const lay = layOut(shown, groups, (id) => isQuiet(id, groups, signals, now, days), activeId);
  const href = paths.projects(ws);
  return (
    <>
      <div className="group/head flex items-center strip:hidden">
        <Link href={href} title="All projects (G P)" aria-current={router.route.name === "projects" ? "page" : undefined} data-roving-item className={heading}>
          Projects
        </Link>
        <LazyMenu
          menu={ProjectsAddMenu}
          button={(props) => (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={viewerCan("projects.write") ? "New project or group" : "New group"}
              onPointerEnter={loadEditChunk}
              {...props}
              className="mt-3 mb-1 ml-auto text-ink-3 opacity-0 transition-opacity duration-120 group-hover/head:opacity-100 hover:text-ink focus-visible:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100"
            >
              <PlusIcon />
            </Button>
          )}
        />
      </div>
      <Divider />
      <DragArea attach={attachProjects} className="flex flex-col strip:items-center strip:self-stretch">
        <div data-cell data-group="" className={dropCell}>
          {lay.top.map((p) => (
            <ProjectLink key={p.id} ws={ws} project={p} active={p.id === activeId} />
          ))}
        </div>
        {sidebar.naming && <GroupNameField />}
        {/* The groups are cards of their own cell too: a group's name or caption drags the whole group (RSVA-567). */}
        <div data-group-cell data-group="groups" className="relative flex flex-col strip:items-center strip:self-stretch">
          {lay.groups.map(({ group, projects }) => (
            <Group key={group.id} ws={ws} group={group} projects={projects} activeId={activeId} />
          ))}
        </div>
      </DragArea>
      {lay.quiet.length > 0 && <Quiet ws={ws} rows={lay.quiet} />}
      {away > 0 && (
        <Link href={href} title="Hidden from your sidebar: show them from a project's ⋯ in All projects" data-roving-item className={cn(navItem, "text-ink-3 strip:hidden")}>
          <EyeSlashIcon className="size-4 shrink-0" />
          <span className={itemLabel}>{away} hidden</span>
        </Link>
      )}
      <GroupPicker />
      <StripMenu />
    </>
  );
});

/** A group: its name and count, its projects while open; in the strip a caption over its tiles, or the caption alone while folded. */
const Group = observer(function Group({ ws, group, projects, activeId }: { ws: string; group: ProjectGroup; projects: Project[]; activeId: string | null }) {
  const open = !group.folded;
  const waits = projects.some((p) => signals.waits(p.id));
  return (
    <div data-cell data-group={group.id} data-group-card={group.id} className={cn(dropCell, "mt-2.5 data-dragging:opacity-40 strip:mt-0 strip:pt-2.5")}>
      {sidebar.renaming === group.id ? (
        <GroupNameField group={group} />
      ) : (
        <div data-group-head={group.id} data-group-anchor={group.id} className="group/gh relative strip:hidden">
          <button
            type="button"
            data-roving-item
            aria-expanded={open}
            onClick={() => toggleGroup(group.id)}
            onContextMenu={menuOn("group", group.id)}
            data-group-handle
            className={cn(groupHead, dropOver)}
          >
            <CollapsibleCaret open={open} className="text-faint" />
            <span className="min-w-0 truncate">{group.name}</span>
            {!open && waits && <span aria-label="something waits on you" className={cn(dot, "ml-0.5")} />}
            <span className={cn(headNote, "font-mono tabular-nums")}>{projects.length}</span>
          </button>
          <HeadDots name={group.name} menu={GroupMenu} props={{ group }} />
          {/* Over what follows, taking no room: a line pushing the rows below would move them under the pointer mid-drag
              and the drop would land in the wrong group. Invisible to the pointer, so the drop finds what is under it. */}
          <span aria-hidden className="pointer-events-none absolute top-full left-0 z-10 hidden rounded-[5px] bg-sidebar px-2 py-0.5 text-[11px] text-ink-3 shadow-pop in-data-drop-over:block">
            Drop to move into {group.name}
          </span>
        </div>
      )}
      {/* The strip's caption: a click folds the group to this one line, or opens it. Always on a plate with a caret, down
          while open and right while folded, as the name in the full sidebar; a dot when something folded inside waits. */}
      <button
          type="button"
          data-roving-item
          aria-expanded={open}
          aria-label={`${group.name}, ${projects.length} projects${!open && waits ? ", something waits on you" : ""}: ${open ? "fold" : "unfold"}`}
          title={open ? group.name : undefined}
          onClick={() => toggleGroup(group.id)}
          onContextMenu={menuOn("group", group.id)}
          data-group-anchor={group.id}
          data-group-handle
          className={cn(
            "relative mb-1 hidden h-4 items-center gap-0.5 rounded-[4px] bg-row-hover px-1 font-mono text-[8.5px] leading-none font-medium tracking-[0.06em] text-ink-2 outline-none hover:bg-row-selected hover:text-ink focus-visible:ring-2 focus-visible:ring-ring strip:flex",
          )}
        >
          {caption(group.name)}
          <CollapsibleCaret open={open} className="size-2" />
          {!open && waits && <span aria-hidden className={cn(dot, "absolute -top-1 -right-1 ring-2 ring-sidebar")} />}
        </button>
      {open && !projects.length && <span className="px-2 pt-0.5 pb-1 text-[11px] text-ink-3 strip:hidden">Empty. Pick projects or drag them here.</span>}
      {open && projects.map((p) => <ProjectLink key={p.id} ws={ws} project={p} active={p.id === activeId} />)}
    </div>
  );
});

/** The ⋯ of a group's name or the Quiet line: shown on hover or focus, in place of the count. */
function HeadDots<P extends object>({ name, menu, props }: { name: string; menu: ComponentType<MenuProps & P>; props?: P }) {
  return (
    <LazyMenu
      menu={menu}
      {...(props ? { props } : {})}
      button={(b) => (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`${name} options`}
          onPointerEnter={loadEditChunk}
          className={cn(rowButton, "top-px size-[22px] opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100 data-popup-open:opacity-100")}
          {...b}
        >
          <DotsThreeIcon className="size-4" weight="bold" />
        </Button>
      )}
    />
  );
}

/** The count or note at a head's right end, giving way to its ⋯ on hover or focus. */
const headNote = "ml-auto truncate text-[11px] font-normal text-faint transition-opacity duration-120 group-hover/gh:opacity-0 group-focus-within/gh:opacity-0 group-has-data-popup-open/gh:opacity-0";

/**
 * A right click opens the row's ⋯ menu, as the artboards say: under its ⋯ in the full sidebar, at the pointer in the
 * strip, where a tile or a caption has no ⋯ to hold it (StripMenu in the lazy chunk).
 */
const menuOn = (kind: "project" | "group" | "quiet", id: string) => (e: MouseEvent<HTMLElement>) => {
  const button = e.currentTarget.closest("[data-card], [data-project], [data-group-head]")?.querySelector<HTMLButtonElement>("button[aria-label$=' options']");
  if (button && button.offsetParent !== null) {
    e.preventDefault();
    button.click();
  } else if (kind !== "quiet") {
    e.preventDefault();
    sidebar.openMenuAt({ kind, id, x: e.clientX, y: e.clientY });
  }
};

/** One line under the groups for the projects nothing happens in; open, each with the group it came from. */
const Quiet = observer(function Quiet({ ws, rows }: { ws: string; rows: QuietRow[] }) {
  const open = sidebar.quietOpen;
  const head = `${rows.length} quiet`;
  const days = uiChoice().quiet;
  const why = days ? `no changes for ${days} days` : "marked quiet";
  return (
    <div className="mt-3 flex flex-col gap-px strip:mt-2.5 strip:items-center">
      {/* Its ⋯ (or a right click) chooses after how many days projects come here, as Settings › Preferences does. */}
      <div data-group-head="quiet" className="group/gh relative strip:hidden">
        <button type="button" data-roving-item aria-expanded={open} onClick={() => sidebar.toggleQuiet()} onContextMenu={menuOn("quiet", "")} className={cn(groupHead, "font-normal")}>
          <CollapsibleCaret open={open} className="text-faint" />
          <span className="min-w-0 truncate">{head}</span>
          {open && <span className={headNote}>{why}</span>}
        </button>
        <HeadDots name="Quiet" menu={QuietMenu} />
      </div>
      {/* In the strip +N shows or hides the quiet tiles under it, as the line does in the full sidebar. */}
      <button
        type="button"
        data-roving-item
        aria-expanded={open}
        aria-label={`${head}: ${rows.map((r) => r.project.name).join(", ")}`}
        onClick={() => sidebar.toggleQuiet()}
        className={cn(
          "mt-0.5 mb-0.5 hidden h-6 w-[34px] place-items-center rounded-[7px] font-mono text-[11px] font-medium text-ink-3 shadow-[inset_0_0_0_1px_var(--color-rule)] outline-none hover:text-ink hover:shadow-[inset_0_0_0_1px_var(--color-ink-3)] focus-visible:text-ink focus-visible:shadow-[inset_0_0_0_1px_var(--color-ink-3)] strip:grid",
          open && "bg-row-hover text-ink-2",
        )}
      >
        +{rows.length}
      </button>
      {open && rows.map((r) => <ProjectLink key={r.project.id} ws={ws} project={r.project} active={false} quiet={r.from ?? ""} />)}
    </div>
  );
});

/**
 * One project. The active count takes the key's place (the key is in every issue ID; here it moves to the tooltip), a dot
 * before it says something waits on the viewer; an idle project shows nothing. On hover or focus the count gives way to the
 * project's "⋯" menu, which a right click opens too. In Quiet the group it came from stands where the count would. Collapsed,
 * the tile becomes a tag as wide as the whole key (Collapsed A artboard); a dot marks an urgent issue or one waiting on the
 * viewer, the tooltip has the rest. Its own observer: a rename or a new count redraws only this row.
 */
const ProjectLink = observer(function ProjectLink({ ws, project, active, quiet }: { ws: string; project: Project; active: boolean; quiet?: string }) {
  const href = projectPath(ws, project.key);
  const n = store.activeCount(project.id);
  const waits = signals.waits(project.id);
  const urgent = sidebar.strip && store.hasUrgent(project.id);
  const still = quiet !== undefined;
  const note = [n ? `${n} active` : "nothing active", waits && "waits on you", urgent && "urgent"].filter(Boolean).join(" · ");
  return (
    <div
      {...(still ? {} : { "data-card": project.id })}
      data-project={project.id}
      onContextMenu={menuOn("project", project.id)}
      className="group/project relative select-none data-dragging:opacity-40 strip:flex strip:flex-col strip:items-center"
    >
      <Link
        href={href}
        draggable={false}
        aria-current={active ? "page" : undefined}
        aria-label={`${project.name}, ${project.key}, ${note}`}
        title={sidebar.strip ? undefined : `${n ? `${n} active` : "Nothing active"} · ${project.key}`}
        {...(active ? {} : { before: markNavStart })}
        data-roving-item
        className={cn(navItem, "pr-8 group-has-data-popup-open/project:bg-row-hover strip:h-[30px] strip:w-[52px] strip:pr-0", still && "text-ink-3")}
      >
        {/* Idle projects step back: the strip has no count to tell them apart. */}
        <ProjectIcon
          project={project}
          className={cn(
            "strip:h-5 strip:w-auto strip:max-w-[46px] strip:min-w-[30px] strip:overflow-hidden strip:rounded-[5px] strip:px-1 strip:font-mono strip:text-[9.5px] strip:font-medium strip:tracking-[-0.03em]",
            !n && !active && !still && "opacity-50",
            still && "opacity-80 saturate-[.35]",
          )}
        >
          <span className="strip:hidden">{project.key[0]}</span>
          <span className="hidden strip:inline">{project.key}</span>
        </ProjectIcon>
        <span className={itemLabel}>{project.name}</span>
        {(urgent || (sidebar.strip && waits)) && <span aria-hidden className={cn(dot, "absolute top-1 right-1 ring-2 ring-sidebar")} />}
        <Tip>
          {project.name}
          <TipNote>{note}</TipNote>
        </Tip>
      </Link>
      {(n > 0 || waits || still) && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 right-2 flex h-7 max-w-24 min-w-[18px] items-center justify-end gap-1 font-mono text-meta text-ink-3 tabular-nums transition-opacity duration-120 group-hover/project:opacity-0 group-focus-within/project:opacity-0 group-has-data-popup-open/project:opacity-0 strip:hidden"
        >
          {still ? (
            <span className="truncate font-sans text-[11px] text-faint">{quiet}</span>
          ) : (
            <>
              {waits && <span className={dot} />}
              {n > 0 && capCount(n)}
            </>
          )}
        </span>
      )}
      <LazyMenu
        menu={ProjectMenu}
        props={{ project }}
        button={(props) => (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`${project.name} options`}
            onPointerEnter={loadEditChunk}
            className={cn(rowButton, "opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 aria-expanded:bg-transparent aria-expanded:text-ink-2 data-popup-open:opacity-100")}
            {...props}
          >
            <DotsThreeIcon className="size-4" weight="bold" />
          </Button>
        )}
      />
    </div>
  );
});

