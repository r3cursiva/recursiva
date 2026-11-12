// All projects, after the navigation artboards (PLNR-58): /:ws/projects lists the live ones in the sidebar's order with
// what is moving in each, /:ws/projects/archived the archived ones with Restore. Archived projects live here, not in
// the sidebar. 1 and 2 switch the two, / finds, J K or ↑↓ move, Enter opens, `,` opens the settings, E archives or
// restores, a drag or ⌥↑↓ reorders the viewer's own order (ADR 0020; not in a filtered list, where a place among the
// rows shown is no place among all of them). Everything is counted from the pool on this device: the page opens without
// a request. New project (admins, PLNR-59) is the header's button, N P (the artboard's N alone starts N I), and on a
// phone the corner button.
//
// The artboard's Delete waits for the function behind it.
import { ArchiveIcon, ArrowCounterClockwiseIcon, EyeIcon, EyeSlashIcon, GearSixIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { localToday } from "@rsva/query";
import { isClosedGroup, type Project } from "@rsva/schema/models";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList } from "@rsva/ui/components/breadcrumb";
import { Button, buttonVariants } from "@rsva/ui/components/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@rsva/ui/components/input-group";
import { Kbd } from "@rsva/ui/components/kbd";
import { Segmented } from "@rsva/ui/components/segmented";
import { keys } from "@rsva/ui/lib/keys";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { exactTime, timeAgo, useNow } from "../lib/time.ts";
import { collect } from "../lib/my-work.ts";
import { PARKED, parkedTotal, pulses } from "../lib/my-work-projects.ts";
import { ParkedBar } from "./pulse-parts.tsx";
import { viewerCan } from "../lib/roles.ts";
import { projectPath } from "../panes.ts";
import { paths, router } from "../router.ts";
import { store } from "../store.ts";
import { ignoredKey } from "./list-view.ts";
import { normKey, stepIn, stepKey } from "../lib/step-keys.ts";
import { useWindowKeys } from "./list-keys.ts";
import { archiveProject, attachProjectDrag, hideProject, restoreProject } from "./project-actions.ts";
import { AddButton } from "./layout-switch.tsx";
import { newProject } from "./palette-state.ts";
import { WorkspaceCrumb } from "./project-header.tsx";
import { ProjectIcon } from "./sidebar-parts.tsx";
import { PinnedSection, ViewsItem } from "./sidebar.tsx";
import { Link } from "../link.tsx";

/** What the Active table shows of a project: its open work, how much of it agents hold, and when anything last moved. */
function stats(project: Project): { active: number; agents: number; last: string | null } {
  let active = 0;
  let agents = 0;
  let last: string | null = null;
  for (const i of store.issuesOf(project.id)) {
    if (!last || i.updatedAt > last) last = i.updatedAt;
    if (isClosedGroup(store.states.get(i.stateId)?.group)) continue;
    active++;
    if (i.delegateId) agents++;
  }
  return { active, agents, last };
}

const matches = (p: Project, q: string) => !q || p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q);

const th = "h-[30px] border-b px-2 text-left font-mono text-overline font-normal tracking-[0.06em] text-ink-3 uppercase first:pl-6";
const td = "h-[calc(36px+2*var(--air))] border-b border-rule-soft px-2 first:pl-6 last:pr-4 max-md:block max-md:h-auto max-md:border-0 max-md:p-0 max-md:first:pl-0 max-md:last:pr-0";

export const AllProjects = observer(function AllProjects({ ws, archived }: { ws: string; archived: boolean }) {
  const now = useNow();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const find = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLTableSectionElement>(null);
  const admin = viewerCan("projects.write");
  const live = store.projectList();
  const shelved = store.archivedProjects();
  const needle = q.trim().toLowerCase();
  const rows = (archived ? shelved : live).filter((p) => matches(p, needle));
  const current = rows.find((p) => p.id === selected) ?? null;
  const sortable = !archived && !needle;
  // What the table adds to Active: past due, in review and the parked bar, as My work's Home had them (owner 2026-11-11),
  // counted from the pool of this workspace by the same rule (lib/my-work-projects.ts).
  const pulse = archived ? null : new Map(pulses(ws, store, collect(ws, store, now), localToday(), now).map((p) => [p.project.id, p]));
  const scale = Math.max(1, ...[...(pulse?.values() ?? [])].map((p) => parkedTotal(p.parked)));

  useEffect(() => attachProjectDrag(list.current!, list.current!.closest<HTMLElement>("[data-scroller]")!, "bg-panel opacity-75"), []);
  useWindowKeys((e) => {
    if (e.defaultPrevented || e.shiftKey || ignoredKey(e, true)) return;
    const key = normKey(e);
    const at = current ? rows.indexOf(current) : -1;
    const by = stepKey(key);
    if (e.altKey) {
      if (!sortable || !current || (key !== "ArrowUp" && key !== "ArrowDown")) return;
      store.moveProject(current.id, at + by);
    } else if (by) {
      const next = stepIn(rows, at, by);
      if (next) setSelected(next.id);
    } else if (key === "1" || key === "2") {
      router.push(paths.projects(ws, key === "2"));
    } else if (key === "/") {
      find.current?.focus();
    } else if (key === "Enter" && current && !(e.target as Element).closest("a, button")) {
      router.push(projectPath(ws, current.key));
    } else if (key === "," && current) {
      router.push(paths.settings(ws, current.key));
    } else if (key === "e" && current && admin) {
      (archived ? restoreProject : archiveProject)(current);
    } else return;
    e.preventDefault();
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-(--topbar) shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-panel py-1.5 pr-3.5 pl-5 max-md:gap-y-2.5 max-md:pt-2.5 max-md:pb-3 max-md:pr-4 max-md:pl-4">
        <Breadcrumb className="max-md:w-full">
          <BreadcrumbList className="text-ink">
            <WorkspaceCrumb ws={ws} className="max-md:hidden" />
            <BreadcrumbItem className="shrink-0">
              <h1 className="text-[14px] font-semibold max-md:text-[24px] max-md:leading-[1.25] max-md:tracking-[-0.02em]">
                <span className="max-md:hidden">All projects</span>
                <span className="md:hidden">Projects</span>
              </h1>
            </BreadcrumbItem>
            <BreadcrumbItem className="md:hidden">
              <span className="truncate pt-1.5 font-mono text-id text-ink-3">{store.workspace?.name ?? ws}</span>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        {/* Two states of one table, as the Views page's All, Shared and Only me: a switch with a thumb, not tabs (those are
            a project's pages). 1 and 2 switch too. */}
        <Segmented<"active" | "archived">
          label="Active or archived"
          variant="quiet"
          options={[
            { value: "active", label: "Active", count: live.length, title: "Active projects (1)" },
            { value: "archived", label: "Archived", icon: <ArchiveIcon />, count: shelved.length, title: "Archived projects (2)" },
          ]}
          value={archived ? "archived" : "active"}
          onChange={(v) => router.push(paths.projects(ws, v === "archived"))}
        />
        <InputGroup className="ml-auto w-[220px] border-control-border bg-field transition-none has-[[data-slot=input-group-control]:focus-visible]:border-ink-3 has-[[data-slot=input-group-control]:focus-visible]:ring-0 max-md:ml-0 max-md:h-10 max-md:w-full max-md:rounded-[10px] dark:bg-field">
          <InputGroupAddon className="pr-[3px] pl-[9px] max-md:pl-[11px]">
            <MagnifyingGlassIcon aria-hidden className="size-3.5 text-ink-3 max-md:size-4" />
          </InputGroupAddon>
          <InputGroupInput
            ref={find}
            aria-label="Find a project"
            value={q}
            placeholder="Find a project"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQ("");
                e.currentTarget.blur();
              } else if (e.key === "Enter" && rows[0]) router.push(projectPath(ws, rows[0].key));
            }}
            className="h-full pr-2.5 text-[12.5px] placeholder:text-ink-3 md:text-[12.5px] max-md:h-full max-md:pr-2.5 max-md:text-base"
          />
          <Kbd className="pointer-events-none absolute right-[7px] max-sm:hidden">/</Kbd>
        </InputGroup>
        {admin && <AddButton label="New project" kbd="N P" onClick={() => newProject.show()} />}
      </header>
      <div data-scroller className="min-h-0 flex-1 overflow-y-auto">
        {/* Framed, the table is a card on the pane, as a list's group is (globals.css). */}
        <div className={cn(rows.length > 0 && "list-group", "max-md:contents")}>
        <table className="w-full border-collapse max-md:block">
          <thead className={rows.length ? "max-md:hidden" : "sr-only"}>
            <tr>
              <th className={th}>Project</th>
              <th className={cn(th, "w-[90px]")}>Key</th>
              {archived ? (
                <>
                  <th className={cn(th, "w-[100px] text-right")}>Issues</th>
                  <th className={cn(th, "w-[160px]")}>Archived</th>
                </>
              ) : (
                <>
                  <th className={cn(th, "w-[110px] text-right")}>Active</th>
                  <th className={cn(th, "w-[110px] text-right max-md:hidden")}>With agents</th>
                  <th className={cn(th, "w-[90px] text-right max-md:hidden")}>Overdue</th>
                  <th className={cn(th, "w-[90px] text-right max-md:hidden")}>In review</th>
                  <th className={cn(th, "w-[190px] max-md:hidden")}>Parked</th>
                  <th className={cn(th, "w-[130px] text-right max-md:hidden")}>Last activity</th>
                </>
              )}
              <th className={cn(th, "w-[190px]")}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody ref={list} data-cell data-group="projects" className="relative max-md:block">
            {rows.map((p) => {
              const href = projectPath(ws, p.key);
              const settings = paths.settings(ws, p.key);
              const s = archived ? null : stats(p);
              const u = pulse?.get(p.id);
              const hidden = !archived && store.views.hiddenProjects.includes(p.id);
              return (
                <tr
                  key={p.id}
                  data-card={sortable ? p.id : undefined}
                  data-selected={p.id === current?.id || undefined}
                  onPointerDown={() => setSelected(p.id)}
                  className="group/row select-none transition-colors duration-120 hover:bg-row-hover data-dragging:opacity-40 data-selected:bg-row-selected max-md:relative max-md:flex max-md:min-h-[60px] max-md:items-center max-md:gap-3 max-md:border-b max-md:border-rule-soft max-md:px-4 max-md:data-selected:bg-transparent max-md:active:bg-row-hover"
                >
                  <td className={cn(td, "max-md:min-w-0 max-md:flex-1")}>
                    <Link href={href} draggable={false} onFocus={() => setSelected(p.id)} className="flex min-w-0 items-center gap-2.5 outline-none focus-visible:underline max-md:gap-3 max-md:after:absolute max-md:after:inset-0">
                      <ProjectIcon project={p} className="max-md:size-8 max-md:rounded-[9px] max-md:text-[13px]" />
                      <span className="flex min-w-0 flex-col">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate max-md:text-[15px] max-md:font-medium">{p.name}</span>
                          {hidden && <EyeSlashIcon aria-label="Hidden from your sidebar" className="size-3.5 shrink-0 text-ink-3 max-md:hidden" />}
                        </span>
                        <span className="font-mono text-id text-ink-3 md:hidden">{p.key}</span>
                      </span>
                    </Link>
                  </td>
                  <td className={cn(td, "font-mono text-meta text-ink-3 max-md:hidden")}>{p.key}</td>
                  {s ? (
                    <>
                      <td className={cn(td, "text-right font-mono text-meta tabular-nums max-md:text-ink-2")}>
                        {s.active || "—"}
                        <span className="text-ink-3 md:hidden"> active</span>
                      </td>
                      <td className={cn(td, "text-right font-mono text-meta text-ink-3 tabular-nums max-md:hidden")}>{s.agents || "—"}</td>
                      <td className={cn(td, "text-right font-mono text-meta tabular-nums max-md:hidden", u?.overdue ? "text-error" : "text-ink-3")}>{u?.overdue || "—"}</td>
                      <td className={cn(td, "text-right font-mono text-meta text-ink-3 tabular-nums max-md:hidden")}>{u?.review || "—"}</td>
                      <td className={cn(td, "max-md:hidden")} title={u ? PARKED.map((k) => `${k} ${u.parked[k]}`).join(" · ") : undefined}>
                        {u && parkedTotal(u.parked) > 0 && <ParkedBar parked={u.parked} of={scale} />}
                      </td>
                      <td className={cn(td, "text-right text-caption text-ink-3 max-md:hidden")}>
                        {s.last ? (
                          <time dateTime={s.last} title={exactTime(s.last)}>
                            {timeAgo(s.last, now)}
                          </time>
                        ) : (
                          "—"
                        )}
                      </td>
                    </>
                  ) : (
                    <>
                      <td className={cn(td, "text-right font-mono text-meta text-ink-3 tabular-nums max-md:hidden")}>{store.issuesOf(p.id).length}</td>
                      <td className={cn(td, "text-caption text-ink-3 max-md:hidden")}>
                        {p.archivedAt && (
                          <time dateTime={p.archivedAt} title={exactTime(p.archivedAt)}>
                            {timeAgo(p.archivedAt, now)}
                          </time>
                        )}
                      </td>
                    </>
                  )}
                  <td data-no-drag className={cn(td, !archived && "max-md:hidden")}>
                    <span className="relative z-1 flex items-center justify-end gap-1 opacity-0 transition-opacity duration-120 group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-data-selected/row:opacity-100 pointer-coarse:opacity-100">
                      {!archived && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={hidden ? `Show ${p.name} in your sidebar` : `Hide ${p.name} from your sidebar`}
                          title={hidden ? "Show in sidebar" : "Hide from sidebar"}
                          onClick={() => hideProject(p, !hidden)}
                        >
                          {hidden ? <EyeIcon /> : <EyeSlashIcon />}
                        </Button>
                      )}
                      {!archived && (
                        <Link href={settings} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                          <GearSixIcon />
                          Settings
                        </Link>
                      )}
                      {admin && (
                        <Button variant="outline" size="sm" onClick={() => (archived ? restoreProject : archiveProject)(p)}>
                          {archived ? <ArrowCounterClockwiseIcon /> : <ArchiveIcon />}
                          {archived ? "Restore" : "Archive"}
                        </Button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        <div className="flex flex-col px-2 md:hidden">
          <PinnedSection ws={ws} />
          <ViewsItem ws={ws} />
        </div>
        <p className="px-6 py-4 text-caption text-ink-3 max-md:px-4">
          {rows.length === 0 && needle
            ? `No ${archived ? "archived " : ""}projects match “${q.trim()}”.`
            : archived
              ? shelved.length
                ? "Archived projects are out of the sidebar. Their issues stay readable and reachable by key and link."
                : "No archived projects. Archive one from its ⋯ menu in the sidebar, its settings, or the Active tab."
              : <span className="max-md:hidden">{needle ? "Clear the search to reorder." : "Projects appear in the sidebar in this order, yours alone. Drag a row here or in the sidebar to move it."}</span>}
        </p>
      </div>
      <footer className="flex shrink-0 flex-wrap gap-x-4 border-t px-6 py-2 font-mono text-meta text-ink-3 max-md:hidden">
        <span>J K move</span>
        <span>↵ open</span>
        <span>1 Active · 2 Archived</span>
        <span>/ find</span>
        <span>, settings</span>
        {sortable && <span>{keys("alt", "↑↓")} reorder</span>}
        {admin && <span>E {archived ? "restore" : "archive"}</span>}
        {admin && <span>N P new project</span>}
      </footer>
    </div>
  );
});
