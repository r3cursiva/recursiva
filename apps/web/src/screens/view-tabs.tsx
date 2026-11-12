// Saved views on screen (PLNR-74, the "Saved views" artboards): a project's tabs under its header (All issues, then
// every view whose Project filter names the project, in their shared order; each with its count, the open tab's follows
// what is on screen), and the tools of the list: a one-line summary of its filter on the right of that row (a view's
// own header, which has no tabs, shows the count there too), then List or Board, View, which opens the panel, and
// Display, a popover of its own (ADR 0045); those three are in the project's header on a wide screen, as on the Collapsed
// A artboard. A view is saved in that panel only (owner's call, 2026-10-30): filters, its name, and Display's edits; a
// tab whose view has edits not saved yet carries a dot, and the panel saves or reverts them. List or Board here is the
// viewer's own on this device, no edit (PLNR-78).
//
// Keys: 1–9 a tab, V list or board, E (also F) the panel, ⇧V Display, / the panel's query, ⌥← ⌥→ move the tab, ⇧N a new view. Not from the
// artboards: N (it starts N I), the rename in place and the Edited pill (the panel does both), the footer of hints
// (ADR 0012 left it out).
import { DotsThreeIcon, FunnelSimpleIcon, LockSimpleIcon, PlusIcon, SlidersHorizontalIcon } from "@phosphor-icons/react";
import type { SavedView } from "@rsva/protocol";
import { formatQuery } from "@rsva/query";
import type { Project } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { keys } from "@rsva/ui/lib/keys";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useIsPhone } from "../lib/phone.ts";
import { projectTabs, viewCount, viewProjects } from "../lib/views.ts";
import { paths, router } from "../router.ts";
import { currentWs, store } from "../store.ts";
import { activeTab, queryContext, setActiveTab, viewState, type ProjectView } from "../view-state.ts";
import { activeKeys } from "./filter-model.ts";
import { shownCount } from "./issue-list.tsx";
import { HEAD_FIT, LayoutToggle, toggleLayout } from "./layout-switch.tsx";
import { LazyMenu } from "./lazy-menu.tsx";
import { ignoredKey } from "./list-view.ts";
import { normKey } from "../lib/step-keys.ts";
import { chunk, loadEditChunk } from "./load-edit-chunk.ts";
import { ViewIcon } from "./view-icon.tsx";
import { viewPanel } from "./view-panel-state.ts";

const ViewMenu = chunk("ViewMenu");
const DisplayMenu = chunk("DisplayMenu");

// A phone's tabs are the artboards' chips: the open one filled.
const tab =
  "tab-plate relative flex h-full shrink-0 items-center gap-1.5 px-1 text-ink-2 outline-none transition-colors duration-120 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring aria-selected:font-medium aria-selected:text-ink max-md:h-8 max-md:self-center max-md:rounded-full max-md:border max-md:border-control-border max-md:px-3 max-md:text-[13px] max-md:aria-selected:border-inverse max-md:aria-selected:bg-inverse max-md:aria-selected:text-inverse-ink max-md:aria-selected:**:text-inverse-ink";

const dot = <span aria-label="Edited, not saved" className="size-1.5 shrink-0 rounded-full bg-signal" />;

export const ViewTabs = observer(function ViewTabs({ project, list }: { project: Project; list: ProjectView }) {
  const views = projectTabs(project.id);
  useViewLink(project);
  useViewKeys(list, project, views);
  const active = activeTab(project.id);
  const all = !views.some((v) => v.id === active);
  const tablist = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLSpanElement>(null);
  useTabLine(tablist, line, project.id, `${all ? "" : active} ${views.map((v) => v.id).join()}`);
  const shown = shownCount(viewPanel.shown(list), project);
  const phone = useIsPhone();
  return (
    <div className="flex h-10 shrink-0 items-stretch gap-3 border-b pr-3.5 pl-6 framed:pl-2.5 max-md:h-12 max-md:gap-0 max-md:bg-panel max-md:pr-1 max-md:pl-0">
      <div ref={tablist} role="tablist" aria-label={`${project.name} views`} className="no-scrollbar relative flex min-w-0 items-stretch gap-4 framed:gap-0.5 overflow-x-auto text-label max-md:gap-2 max-md:px-4">
        <span ref={line} aria-hidden className="absolute -bottom-px left-0 h-0.5 w-px origin-left bg-ink transition-transform duration-200 ease-out max-md:hidden framed:hidden" />
        <button type="button" role="tab" aria-selected={all} title="All issues (1)" onClick={() => setActiveTab(project.id, null)} className={tab}>
          All issues
          <span className="font-mono text-meta text-ink-3 tabular-nums">{all ? shown : store.issuesOf(project.id).length}</span>
          {all && list.edited && dot}
        </button>
        {views.map((v, k) => (
          <ViewTab key={v.id} view={v} project={project} n={k + 2} on={!all && active === v.id} shown={shown} />
        ))}
        <Button
          type="button"
          variant="ghost"
          title={`Save what is on screen as a new view (${keys("shift", "N")})`}
          onClick={() => viewPanel.create(list, project)}
          onPointerEnter={loadEditChunk}
          aria-label="New view"
          className="h-6 gap-1 self-center rounded-[5px] border-0 px-1.5 font-normal text-ink-3 active:scale-100! max-md:size-8 max-md:rounded-full max-md:border max-md:border-control-border max-md:px-0"
        >
          <PlusIcon className="size-3 max-md:size-3.5" weight="bold" />
          <span className="max-md:hidden">New view</span>
        </Button>
      </div>
      <ViewTools list={list} project={project} controls={phone} />
    </div>
  );
});

const ViewTab = observer(function ViewTab({ view, project, n, on, shown }: { view: SavedView; project: Project; n: number; on: boolean; shown: number }) {
  return (
    <span className="group/tab flex shrink-0 items-stretch">
      <button
        type="button"
        role="tab"
        aria-selected={on}
        title={`${n <= 9 ? `${n} · ` : ""}${view.query || "every issue"}`}
        onClick={() => setActiveTab(project.id, view.id)}
        className={tab}
      >
        <ViewIcon name={view.icon} />
        <span className="max-w-48 truncate">{view.name}</span>
        {!view.shared && <LockSimpleIcon aria-label="Only you" className="size-3 text-ink-3" />}
        <span className="font-mono text-meta text-ink-3 tabular-nums">{on ? shown : viewCount(view.id, project.id)}</span>
        {viewState(view.id).edited && dot}
      </button>
      <LazyMenu
        menu={ViewMenu}
        props={{ saved: view, project }}
        button={(props) => (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`${view.name} view options`}
            onPointerEnter={loadEditChunk}
            className={cn(
              "ml-0.5 h-auto w-5 self-center rounded-[4px] border-0 text-ink-3 opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 active:scale-100! aria-expanded:bg-transparent aria-expanded:text-ink-3 data-popup-open:opacity-100 max-md:size-8 max-md:rounded-[4px]",
              on ? "opacity-100" : "max-md:hidden",
            )}
            {...props}
          >
            <DotsThreeIcon className="size-4" weight="bold" />
          </Button>
        )}
      />
    </span>
  );
});

/**
 * The list's tools at the right of the tab row and of a view's own header: the filter in one line, List or Board,
 * View and Display. The count only in the header (no project): on the tab row the open tab has it. `controls`: the last
 * three are here, not in the project's header.
 */
export const ViewTools = observer(function ViewTools({ list: base, project, controls = true }: { list: ProjectView; project: Project | null; controls?: boolean }) {
  const list = viewPanel.shown(base);
  const summary = formatQuery(list.filter, queryContext(list.scope));
  const n = project ? null : shownCount(list, project);
  return (
    <div className="ml-auto flex min-w-0 shrink items-center gap-2.5 max-md:shrink-0 max-md:gap-0">
      {summary && (
        <button
          type="button"
          title={summary}
          data-view-panel-opener
          onClick={() => openPanel(base, project, true)}
          className="min-w-0 truncate font-mono text-meta text-ink-3 outline-none hover:text-ink focus-visible:underline max-lg:hidden"
        >
          {summary}
        </button>
      )}
      {n !== null && (
        <span className="shrink-0 font-mono text-meta text-ink-3 tabular-nums max-sm:hidden">
          {n} {n === 1 ? "issue" : "issues"}
        </span>
      )}
      {controls && <ViewControls list={base} project={project} />}
    </div>
  );
});

/**
 * List or Board, View and Display. `labels` names the layouts beside their icons, where the row has the room. On a phone
 * List or Board is in Display's popover (PLNR-400): the row keeps its width for the tabs, and V still switches.
 * `data-view-tools`: a press here keeps the docked View panel open, which follows each change (RSVA-385).
 */
export const ViewControls = observer(function ViewControls({ list: base, project, labels = false }: { list: ProjectView; project: Project | null; labels?: boolean }) {
  const list = viewPanel.shown(base);
  const filters = activeKeys(list.filter).length + (list.filter.text?.trim() ? 1 : 0);
  return (
    <div data-view-tools className="flex shrink-0 items-center gap-2.5 max-md:gap-0">
      <LayoutToggle list={list} project={project} labels={labels} className="max-md:hidden" />
      <Button
        type="button"
        variant="ghost"
        aria-expanded={viewPanel.open}
        title={base.saved ? "Edit the view: filters, name, where it shows (E)" : "Filter, for now (E)"}
        onPointerEnter={loadEditChunk}
        onClick={() => (viewPanel.open ? viewPanel.close() : openPanel(base, project))}
        aria-label="View"
        className={TOOL}
      >
        <FunnelSimpleIcon className="size-3.5 max-md:size-5" />
        {/* One word on both (owner's call, 2026-10-31); its funnel, as Display has the sliders (ADR 0045). */}
        <span className={cn("max-md:hidden", HEAD_FIT.layout)}>View</span>
        {filters > 0 && <span className="rounded-full bg-ground px-1.5 font-mono text-meta text-ink-2">{filters}</span>}
      </Button>
      <DisplayTool list={list} project={project} />
    </div>
  );
});

// On a phone a 44px target with the icon in its middle: 12px each side, so the row's 4px end puts the last icon 16px from the edge.
const TOOL = "gap-1.5 rounded-[5px] border-0 px-2 text-[13px]/[1.4] font-normal text-ink active:scale-100! max-md:h-11 max-md:min-w-11 max-md:px-3";

/**
 * Display's button (ADR 0045): in the list's tools, and in the View panel's footer, as the panel covers the tab row;
 * there `iconOnly`, so the footer keeps room for its status.
 */
export function DisplayTool({ list, project, iconOnly = false }: { list: ProjectView; project: Project | null; iconOnly?: boolean }) {
  return (
    <LazyMenu
      menu={DisplayMenu}
      props={{ list, project }}
      button={(props, open) => (
        <Button type="button" variant="ghost" title={`Group, order and properties (${keys("shift", "V")})`} onPointerEnter={loadEditChunk} className={TOOL} {...props} data-display-tool aria-label="Display" aria-haspopup="dialog" aria-expanded={open}>
          <SlidersHorizontalIcon className="size-3.5 max-md:size-5" />
          {!iconOnly && <span className={cn("max-md:hidden", HEAD_FIT.layout)}>Display</span>}
        </Button>
      )}
    />
  );
}

/** ⇧V and the palette press Display's button, the View panel's first: the popover's state and its chunk stay with it. */
export function toggleDisplay(): void {
  (document.querySelector<HTMLElement>("[data-slot=view-panel]:not([data-leaving]) [data-display-tool]") ?? document.querySelector<HTMLElement>("[data-display-tool]"))?.click();
}

function openPanel(list: ProjectView, project: Project | null, focusQuery = false): void {
  void loadEditChunk();
  viewPanel.edit(list, project, focusQuery);
}

/**
 * One underline for the tablist, moved by transform to the open tab and stretched to its width (Segmented's thumb is
 * anchored to its option by CSS instead, PLNR-235). Compared: the open tab's own ::after (what it was; it can only jump) and a view transition
 * of the tab row (blocks clicks while it plays and needs page snapshots, for a tab switch that should feel instant).
 * Another project's tabs place it without motion. Only the observer measures: it reports each tab once on `observe` and
 * again when one changes width (a count, a rename), after layout and before paint, so this forces no layout. The tabs
 * re-render on every change to the project's issues: `tabs` (the open tab and the tab order) keeps that from starting over.
 */
function useTabLine(list: RefObject<HTMLElement | null>, line: RefObject<HTMLElement | null>, projectId: string, tabs: string): void {
  const placed = useRef<string | null>(null);
  useLayoutEffect(() => {
    const box = list.current;
    const bar = line.current;
    if (!box || !bar) return;
    const place = () => {
      const tab = box.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!tab) return;
      bar.style.transition = placed.current === projectId ? "" : "none";
      bar.style.transform = `translateX(${tab.offsetLeft}px) scaleX(${tab.offsetWidth})`;
      placed.current = projectId;
    };
    const ro = new ResizeObserver(place);
    for (const tab of box.querySelectorAll('[role="tab"]')) ro.observe(tab);
    return () => ro.disconnect();
  }, [list, line, projectId, tabs]);
}

/** A link to a view's tab (?view=<id>: the menu's Copy link) opens it here, or on its own page if it is no tab here. */
function useViewLink(project: Project): void {
  const ready = store.views.status === "ready";
  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams(location.search);
    const id = params.get("view");
    if (id === null) return;
    params.delete("view");
    const search = params.toString();
    history.replaceState(history.state, "", location.pathname + (search ? `?${search}` : "") + location.hash);
    const view = store.views.get(id);
    if (view && view.tab && viewProjects(view).includes(project.id)) setActiveTab(project.id, id);
    else if (view) router.replace(paths.view(currentWs(), id));
  }, [ready, project, router.path]);
}

/**
 * ⇧V, with the panel open too: Display's button is in its footer. The panel is a dialog, which the list's keys leave
 * alone (ignoredKey): in it only a field keeps the key.
 */
function displayKey(e: KeyboardEvent): boolean {
  if (!e.shiftKey || e.key.toLowerCase() !== "v") return false;
  const t = e.target instanceof Element ? e.target : null;
  if (!t?.closest("[data-slot=view-panel]")) return !ignoredKey(e);
  return !(e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, [contenteditable=''], [contenteditable=true]"));
}

/** The keys of a list with views; `tabs` only on a project's page (null on a view's own page). */
export function useViewKeys(list: ProjectView, project: Project | null, tabs: readonly SavedView[] | null): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (displayKey(e)) {
        e.preventDefault();
        return toggleDisplay();
      }
      if (viewPanel.open) return;
      const saved = list.saved;
      if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && saved && project) {
        e.preventDefault();
        void loadEditChunk().then((m) => m.moveTab(saved, project.id, e.key === "ArrowLeft" ? -1 : 1));
        return;
      }
      if (ignoredKey(e)) return;
      const key = normKey(e);
      if (key === "v") toggleLayout(list, project);
      else if (key === "e" || key === "f") openPanel(list, project);
      else if (key === "/") openPanel(list, project, true);
      else if (key === "n" && e.shiftKey) viewPanel.create(list, project);
      else if (!e.shiftKey && tabs && /^[1-9]$/.test(key) && router.route.name === "issues" && project) {
        const k = Number(key);
        if (k === 1) setActiveTab(project.id, null);
        else if (tabs[k - 2]) setActiveTab(project.id, tabs[k - 2]!.id);
        else return;
      } else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [list, project, tabs]);
}
