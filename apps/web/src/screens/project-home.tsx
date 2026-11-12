// A project's home (RSVA-508…517, ADR 0053), after the Quire FramedHome artboards: the project's first page, a grid of
// widgets in twelfths. What it holds is the project's home, else the default of every project (RSVA-577), else the
// built-in template (lib/home.ts). E opens Customize: the library or a widget's settings beside the grid, each widget with a grip to drag,
// its width, settings and remove; Cancel drops the draft, Save writes the project’s home and Save as default the default of every project. On a phone the grid is one column (two for
// counts) and the panel goes under it.
import { ArrowSquareOutIcon, CaretLeftIcon, CaretRightIcon, PlusIcon, SlidersHorizontalIcon, XIcon } from "@phosphor-icons/react";
import { HOME_WIDTHS, HOME_WIDGETS_MAX, widgetTitle, type HomeWidget } from "@rsva/protocol/home";
import type { Project } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Kbd } from "@rsva/ui/components/kbd";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { homeEditor, homeWidgetsShown, mayEditHome, openAsList, shownHome } from "../lib/home.ts";
import { normKey } from "../lib/step-keys.ts";
import { navCommitted } from "../perf.ts";
import { typing } from "../lib/typing.ts";
import { ActivityBody, ChartBody, CountBody, CycleBody, ListBody, WaitBody, widgetCount } from "./home-widgets.tsx";
import { FiguresBody, PullsBody, StructureBody } from "./home-pulse.tsx";
import { YearBody } from "./home-year.tsx";
import { HomeLibrary, SaveAsDefault, WidgetSettings, WIDTH_NAMES } from "./home-side.tsx";
import { AddIssueButton, SettingsLink } from "./layout-switch.tsx";
import { useWindowKeys } from "./list-keys.ts";
import { PICKER_KEYS } from "./list-view.ts";
import { rowPopup } from "./row-popup.ts";
import { walkRows } from "./row-walk.ts";
import { ProjectHeader } from "./project-header.tsx";

/** A widget's span: its twelfths on a wide grid; narrower, the small ones go to half and the rest to the whole row. */
const SPAN: Record<HomeWidget["width"], string> = {
  3: "col-span-6 @3xl/home:col-span-3",
  4: "col-span-12 @xl/home:col-span-6 @3xl/home:col-span-4",
  6: "col-span-12 @xl/home:col-span-6",
  8: "col-span-12 @3xl/home:col-span-8",
  12: "col-span-12",
};

const WIDTH_BAR: Record<HomeWidget["width"], string> = { 3: "w-1", 4: "w-[5.5px]", 6: "w-2", 8: "w-[11px]", 12: "w-4" };

export const ProjectHome = observer(function ProjectHome({ ws, project }: { ws: string; project: Project }) {
  const e = homeEditor;
  const editing = e.editing(project.id);
  const widgets = homeWidgetsShown(project.id);
  const at = shownHome(project.id).at;
  // Someone who may write neither the project's home nor the default has nothing to save.
  const mayCustomize = mayEditHome(project.id, "project") || mayEditHome(project.id, "all");
  const selected = editing ? widgets.find((w) => w.id === e.selected) : undefined;
  const [drag, setDrag] = useState<{ id: string; over: string | null; after: boolean } | null>(null);
  const rowKeys = useRowKeys();

  // A project link in the sidebar opens this page: the end of the project switch perf:net times.
  useLayoutEffect(navCommitted, []);
  // Leaving the page or the project drops an unfinished draft, as Cancel does.
  useEffect(() => () => homeEditor.cancel(), [project.id]);

  useWindowKeys((ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) {
      if (editing && (ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        e.save(project);
        ev.preventDefault();
      }
      return;
    }
    if (typing(ev.target) || rowPopup.current) return;
    if (!editing && rowKeys(ev)) return ev.preventDefault();
    if (!editing && mayCustomize && ev.key.toLowerCase() === "e" && !ev.shiftKey) e.start(project.id);
    else if (editing && ev.key === "Escape") {
      if (e.selected) e.select(null);
      else e.cancel();
    } else return;
    ev.preventDefault();
  });

  const onDragOver = (ev: DragEvent<HTMLElement>, id: string) => {
    if (!drag || drag.id === id) return;
    ev.preventDefault();
    const r = ev.currentTarget.getBoundingClientRect();
    const after = ev.clientX > r.left + r.width / 2;
    if (drag.over !== id || drag.after !== after) setDrag({ ...drag, over: id, after });
  };
  const onDrop = (ev: DragEvent<HTMLElement>) => {
    ev.preventDefault();
    if (!drag?.over) return setDrag(null);
    const rest = widgets.filter((w) => w.id !== drag.id);
    const at = rest.findIndex((w) => w.id === drag.over);
    e.move(drag.id, rest[drag.after ? at + 1 : at]?.id);
    setDrag(null);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-ground">
      <ProjectHeader ws={ws} project={project}>
        {editing ? (
          <>
            <span className="font-mono text-[11.5px] whitespace-nowrap text-ink-3 max-md:hidden">
              Editing <b className="font-medium text-ink-2">{project.key}’s home</b> · {widgets.length} widgets
            </span>
            <Button type="button" variant="ghost" onClick={() => e.cancel()}>
              Cancel
            </Button>
            <SaveAsDefault project={project} className="max-md:hidden" />
            <Button type="button" title={`Save for ${project.key} only (⌘↵)`} onClick={() => e.save(project)}>
              Save
            </Button>
          </>
        ) : (
          <>
            <span className="font-mono text-[11.5px] whitespace-nowrap text-ink-3 max-md:hidden">
              {!at ? "Built-in home" : at.scope === "all" ? "Default home" : `${project.key}’s own home`}
            </span>
            {mayCustomize && (
              <Button type="button" variant="outline" onClick={() => e.start(project.id)}>
                Customize
                <Kbd>E</Kbd>
              </Button>
            )}
            <SettingsLink ws={ws} project={project} />
            <AddIssueButton />
          </>
        )}
      </ProjectHeader>
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <main aria-label="Home" className="@container/home min-h-0 flex-1 overflow-auto p-2.5 pb-4 max-md:pb-24">
          <div className="grid grid-flow-dense grid-cols-12 items-stretch gap-2" onDragOver={(ev) => drag && ev.preventDefault()} onDrop={onDrop}>
            {widgets.map((w, i) => (
              <Widget
                key={w.id}
                ws={ws}
                project={project}
                w={w}
                editing={editing}
                first={i === 0}
                last={i === widgets.length - 1}
                drop={drag?.over === w.id ? (drag.after ? "after" : "before") : null}
                dragging={drag?.id === w.id}
                onDragStart={() => setDrag({ id: w.id, over: null, after: false })}
                onDragEnd={() => setDrag(null)}
                onDragOver={(ev) => onDragOver(ev, w.id)}
              />
            ))}
            {editing && widgets.length < HOME_WIDGETS_MAX && (
              <button
                type="button"
                onClick={() => e.add("list")}
                className="col-span-12 flex min-h-[120px] flex-col items-center justify-center gap-1.5 rounded-[10px] border-[1.5px] border-dashed border-rule text-[13px] font-medium text-ink-3 outline-none hover:border-ink-3 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring @xl/home:col-span-6 @3xl/home:col-span-4"
              >
                <PlusIcon className="size-4" />
                Add a widget
                <span className="font-mono text-[11.5px] font-normal">or pick one on the right</span>
              </button>
            )}
            {!editing && widgets.length === 0 && (
              <p className="col-span-12 px-2 py-6 text-[13px] text-ink-3">This home has no widgets. Press E to add some.</p>
            )}
          </div>
        </main>
        {editing && (selected ? <WidgetSettings key={selected.id} project={project} w={selected} /> : <HomeLibrary project={project} />)}
      </div>
    </div>
  );
});

/**
 * RSVA-524. J, K and the arrows step through the rows of every widget in reading order, ↵ opens the selected row's issue, S, P, A
 * and L open that property's picker at the row (the list's popup, row-popup.ts), Esc lets the row go. The mark is an
 * attribute, as in History: a step redraws nothing.
 */
function useRowKeys(): (e: KeyboardEvent) => boolean {
  const selected = useRef<HTMLElement | null>(null);
  return (e) => {
    const key = normKey(e);
    if (walkRows([...document.querySelectorAll<HTMLElement>("main[aria-label=Home] [data-home-row]")], selected, key)) return true;
    const row = selected.current;
    const picker = row && !e.shiftKey && PICKER_KEYS[key];
    if (!picker) return false;
    // At the row's glyph, as the list's picker sits at its chip: anchored to the whole row it would take the row's width.
    rowPopup.open(picker, row.dataset.homeRow!, row.firstElementChild ?? row);
    return true;
  };
}

interface WidgetProps {
  ws: string;
  project: Project;
  w: HomeWidget;
  editing: boolean;
  first: boolean;
  last: boolean;
  drop: "before" | "after" | null;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (ev: DragEvent<HTMLElement>) => void;
}

const iconButton = "pointer-coarse:size-11";

const Widget = observer(function Widget({ ws, project, w, editing, first, last, drop, dragging, onDragStart, onDragEnd, onDragOver }: WidgetProps) {
  const e = homeEditor;
  const [armed, setArmed] = useState(false);
  const selected = editing && e.selected === w.id;
  const count = widgetCount(ws, project, w);
  const title = widgetTitle(w);
  const query = w.kind === "list" || w.kind === "count" || w.kind === "chart";
  const more = () => openAsList(ws, project, w.query);
  return (
    <section
      aria-label={title}
      draggable={editing && armed}
      onDragStart={(ev) => {
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", w.id);
        onDragStart();
      }}
      onDragEnd={() => {
        setArmed(false);
        onDragEnd();
      }}
      onDragOver={onDragOver}
      className={cn(
        "group/w @container/w relative flex min-w-0 flex-col rounded-[10px] border border-rule-soft bg-panel transition-[box-shadow,border-color,opacity] duration-150",
        SPAN[w.width],
        editing && "border-[1.5px] border-dashed border-rule-strong bg-ground hover:border-ink-3",
        selected && "border-solid border-ink bg-panel shadow-lg",
        dragging && "opacity-40",
        e.fresh === w.id && "animate-in fade-in zoom-in-95 duration-300",
      )}
    >
      {drop && <span aria-hidden className={cn("absolute inset-y-2 z-10 w-0.5 rounded-full bg-primary", drop === "before" ? "-left-[5px]" : "-right-[5px]")} />}
      <header className={cn("flex min-h-[38px] items-center gap-2 pt-1 pr-1.5", editing ? "pl-2" : "pl-3.5")}>
        {editing && (
          <span
            aria-hidden
            title="Drag to move"
            onPointerDown={() => setArmed(true)}
            onPointerUp={() => setArmed(false)}
            className="h-3.5 w-2 shrink-0 cursor-grab bg-[radial-gradient(circle,var(--color-ink-3)_1.2px,transparent_1.4px)] bg-size-[4px_4.7px] pointer-coarse:hidden"
          />
        )}
        <h2 className="flex min-w-0 items-baseline gap-2 text-[13px] font-semibold whitespace-nowrap">
          <span className="truncate">{title}</span>
          {count && <span className={cn("font-mono text-[11px] font-normal", count.signal ? "font-medium text-signal-text" : "text-ink-3")}>{count.n}</span>}
        </h2>
        <span className="flex-1" />
        {/* On a phone, out of Customize, the title keeps the room: the count opens its list, Customize the settings. */}
        <span className={cn("flex", !editing && "opacity-0 transition-opacity duration-120 group-hover/w:opacity-100 focus-within:opacity-100 max-md:hidden pointer-coarse:opacity-100")}>
          <Button type="button" variant="ghost" size="icon" className={iconButton} aria-label="Widget settings" title="Widget settings" onClick={() => (editing ? e.select(w.id) : e.start(project.id, w.id))}>
            <SlidersHorizontalIcon />
          </Button>
          {editing ? (
            <Button type="button" variant="ghost" size="icon" className={iconButton} aria-label="Remove from home" title="Remove from home" onClick={() => e.remove(w.id)}>
              <XIcon />
            </Button>
          ) : (
            query && (
              <Button type="button" variant="ghost" size="icon" className={iconButton} aria-label="Open as a list" title="Open as a list" onClick={more}>
                <ArrowSquareOutIcon />
              </Button>
            )
          )}
        </span>
      </header>
      {query && w.query && <p className="-mt-0.5 mx-3.5 mb-1.5 truncate font-mono text-[11px] leading-[1.4] text-ink-3">{w.query}</p>}
      <div className="flex min-h-0 flex-1 flex-col px-1.5 pb-2">
        {w.kind === "list" && <ListBody ws={ws} project={project} w={w} more={more} />}
        {w.kind === "count" && <CountBody project={project} w={w} open={more} />}
        {w.kind === "chart" && <ChartBody project={project} w={w} />}
        {w.kind === "figures" && <FiguresBody ws={ws} project={project} />}
        {w.kind === "structure" && <StructureBody ws={ws} project={project} />}
        {w.kind === "pulls" && <PullsBody project={project} w={w} />}
        {w.kind === "year" && <YearBody ws={ws} project={project} />}
        {w.kind === "cycle" && <CycleBody ws={ws} project={project} />}
        {w.kind === "wait" && <WaitBody ws={ws} project={project} w={w} />}
        {w.kind === "activity" && <ActivityBody ws={ws} project={project} w={w} />}
      </div>
      {editing && (
        // A narrow widget keeps its toolbar inside it: no label, slimmer width buttons, the bar across the bottom.
        <div className="absolute right-2 bottom-2 z-[3] flex items-center gap-2 rounded-[9px] bg-panel py-1 pr-1 pl-2.5 @max-[280px]/w:left-2 @max-[280px]/w:justify-between @max-[280px]/w:pl-1 opacity-0 shadow-[0_0_0_1px_var(--color-rule),0_8px_24px_rgb(0_0_0/0.12)] transition-opacity duration-150 group-hover/w:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
          <span className="font-mono text-[10.5px] font-medium tracking-[0.06em] text-ink-3 uppercase @max-[280px]/w:hidden">Width</span>
          <span role="group" aria-label="Width" className="flex gap-0.5 rounded-[7px] bg-sidebar p-0.5">
            {HOME_WIDTHS.map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`Width ${WIDTH_NAMES[n]}`}
                title={`Width ${WIDTH_NAMES[n]}`}
                aria-pressed={w.width === n}
                onClick={() => e.update(w.id, { width: n })}
                className="group/z flex h-5 w-[22px] items-center rounded-[5px] px-[3px] @max-[280px]/w:w-5 outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-panel aria-pressed:shadow-[0_1px_2px_rgb(0_0_0/0.08)] pointer-coarse:h-8 pointer-coarse:w-8"
              >
                <i className={cn("block h-1.5 rounded-[2px] bg-faint group-hover/z:bg-ink-3 group-aria-pressed/z:bg-ink", WIDTH_BAR[n])} />
              </button>
            ))}
          </span>
          <span className="flex">
            <Button type="button" variant="ghost" size="icon-sm" disabled={first} aria-label="Move earlier" title="Move earlier" onClick={() => e.step(w.id, -1)}>
              <CaretLeftIcon />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" disabled={last} aria-label="Move later" title="Move later" onClick={() => e.step(w.id, 1)}>
              <CaretRightIcon />
            </Button>
          </span>
        </div>
      )}
    </section>
  );
});
