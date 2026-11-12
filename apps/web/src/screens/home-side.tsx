// Customize's side panel on a project's home (RSVA-514…516), after the FramedHomeEdit and FramedHomeConfig artboards:
// the library (who sees the home, a template to start from, the widgets to add) and one widget's settings (title, query,
// how it shows, width, rows, a tab of its own). Every change goes to the draft (lib/home.ts); Done writes it.
import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
  ChartBarIcon,
  ClockCounterClockwiseIcon,
  DotsNineIcon,
  GitPullRequestIcon,
  HashIcon,
  HourglassMediumIcon,
  ListBulletsIcon,
  SquaresFourIcon,
  TreeStructureIcon,
  XIcon,
} from "@phosphor-icons/react";
import { uuidv7 } from "@rsva/protocol";
import {
  CHART_BY,
  HOME_PRESETS,
  HOME_ROWS,
  HOME_TEMPLATES,
  HOME_WIDGETS_MAX,
  HOME_WIDTHS,
  isQueryKind,
  KIND_NAMES,
  TEMPLATE_NAMES,
  templateWidgets,
  widgetTitle,
  type HomeKind,
  type HomeWidget,
  type HomeWidth,
  type QueryKind,
} from "@rsva/protocol/home";
import { DEFAULT_DISPLAY } from "@rsva/query";
import type { Project } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Input } from "@rsva/ui/components/input";
import { Segmented } from "@rsva/ui/components/segmented";
import { observer } from "mobx-react-lite";
import type { ReactNode } from "react";
import { homeEditor, mayEditHome, queryErrors, queryReach, runWidget, savedHome } from "../lib/home.ts";
import { store } from "../store.ts";
import { setActiveTab } from "../view-state.ts";
import { deleteView } from "./view-actions.ts";
import { notice } from "./notice.ts";
import { QueryLine } from "./query-input.tsx";

export const WIDTH_NAMES: Record<HomeWidth, string> = { 3: "¼", 4: "⅓", 6: "½", 8: "⅔", 12: "Full" };
const ROW_NAMES = { 5: "5", 10: "10", 25: "25", 0: "All" } as const;
const BY_NAMES = { state: "Status", priority: "Priority", assignee: "Assignee" } as const;

const label = "block px-1.5 pb-2 font-mono text-[10.5px] font-medium tracking-[0.06em] text-ink-3 uppercase";
const note = "mx-1.5 mb-2.5 text-[12px] leading-normal text-ink-3";

/** A titled part of a Customize panel; My work's panel (my-work-customize.tsx) is built from these too. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-[18px] first:mt-0">
      <span className={label}>{title}</span>
      {children}
    </section>
  );
}

/** The panel's frame: a header, what scrolls, and a footer. */
function Side({ head, foot, label = "Customize home", children }: { head: ReactNode; foot?: ReactNode; label?: string; children: ReactNode }) {
  return (
    <aside aria-label={label} className="flex min-h-0 w-[340px] shrink-0 flex-col border-l border-rule-soft bg-panel max-md:w-full max-md:border-t max-md:border-l-0">
      <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-rule-soft pr-2 pl-4">{head}</div>
      <div className="min-h-0 flex-1 overflow-auto px-2.5 pt-3 pb-[18px]">{children}</div>
      {foot && <div className="flex gap-2 border-t border-rule-soft px-4 py-3">{foot}</div>}
    </aside>
  );
}

const Close = () => (
  <Button type="button" variant="ghost" size="icon" aria-label="Close the widget's settings" title="Back to the widgets (Esc)" onClick={() => homeEditor.select(null)} className="ml-auto">
    <XIcon />
  </Button>
);

const GLYPH: Record<HomeKind, ReactNode> = {
  list: <ListBulletsIcon />,
  count: <HashIcon />,
  chart: <ChartBarIcon />,
  cycle: <ArrowsClockwiseIcon />,
  wait: <HourglassMediumIcon />,
  activity: <ClockCounterClockwiseIcon />,
  figures: <SquaresFourIcon />,
  structure: <TreeStructureIcon />,
  pulls: <GitPullRequestIcon />,
  year: <DotsNineIcon />,
};
const LINES: Record<HomeKind, string> = {
  list: "Issues that match, with status, priority and due date",
  count: "One number: how many issues match",
  chart: "Issues by status, priority or assignee",
  cycle: "Burn-up and progress of the cycle in progress",
  wait: "Reviews, proposals and questions for you, answered from the row",
  activity: "The last things that happened",
  figures: "What waits on you, yours, with agents, in review, blocked and parked",
  structure: "The project by parent issue or by label: what is live, done and left in each",
  pulls: "Open pull requests of the project's issues, with their reviews and checks",
  year: "A year by day: when issues were closed, by people and by agents; a day lists its issues",
};
const GROUPS: { title: string; note?: string; kinds: HomeKind[] }[] = [
  { title: "From a query", note: "One line of query, shown the way you need it.", kinds: ["list", "count", "chart"] },
  { title: "The project", kinds: ["figures", "structure", "cycle", "wait", "pulls", "year", "activity"] },
];

/**
 * Save as default (RSVA-577): the draft becomes the default home of every project without a home of its own, and this
 * project follows it again. Apart from Save on purpose, so an edit in one project never changes the others by the way.
 */
export const SaveAsDefault = observer(function SaveAsDefault({ project, className }: { project: Project; className?: string }) {
  if (!mayEditHome(project.id, "all")) return null;
  return (
    <Button type="button" variant="outline" className={className} title="Every project without a home of its own shows it" onClick={() => homeEditor.save(project, "all")}>
      Save as default
    </Button>
  );
});

/** The library: where the home on screen comes from and the way back to the default, a template, the widgets to add. */
export const HomeLibrary = observer(function HomeLibrary({ project }: { project: Project }) {
  const e = homeEditor;
  const full = e.widgets.length >= HOME_WIDGETS_MAX;
  const own = savedHome(project.id, "project");
  const def = savedHome(project.id, "all");
  return (
    <Side
      head={
        <>
          <h2 className="text-[14px] font-semibold">Customize home</h2>
          <span className="font-mono text-[11px] text-ink-3">{e.widgets.length} widgets</span>
        </>
      }
    >
      <Section title={project.key}>
        <p className={note}>
          {own
            ? `${project.key} has a home of its own. Save changes only ${project.key}; Save as default makes it every project’s.`
            : e.from === "all"
              ? `${project.key} shows the default home. Save gives ${project.key} a home of its own; Save as default changes it for every project.`
              : `Save gives ${project.key} a home of its own; Save as default makes it every project’s.`}
        </p>
        {own && mayEditHome(project.id, "project") && (
          <Button
            type="button"
            variant="outline"
            className="mx-1.5 w-[calc(100%-12px)]"
            onClick={() => {
              e.cancel();
              deleteView(own);
            }}
          >
            {def ? "Reset to default" : "Reset to the built-in home"}
          </Button>
        )}
        <SaveAsDefault project={project} className="mx-1.5 mt-1.5 w-[calc(100%-12px)] md:hidden" />
      </Section>
      <Section title="Start from">
        <div className="mx-1.5 grid grid-cols-3 gap-1.5">
          {HOME_TEMPLATES.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={e.template === t}
              onClick={() => e.useTemplate(t)}
              className="flex flex-col gap-2 rounded-lg bg-panel p-2 text-left text-[12px] leading-[1.2] font-medium shadow-[inset_0_0_0_1px_var(--color-rule-soft)] outline-none hover:shadow-[inset_0_0_0_1px_var(--color-rule-strong)] focus-visible:ring-2 focus-visible:ring-ring aria-pressed:shadow-[inset_0_0_0_1.5px_var(--color-ink)]"
            >
              <span aria-hidden className="grid h-[30px] grid-cols-12 gap-0.5">
                {templateWidgets(t).map((w) => (
                  <i key={w.id} className="rounded-[2px] bg-rule" style={{ gridColumn: `span ${w.width}` }} />
                ))}
              </span>
              {TEMPLATE_NAMES[t]}
            </button>
          ))}
        </div>
      </Section>
      <ReadyQueries project={project} full={full} />
      {GROUPS.map((g) => (
        <Section key={g.title} title={g.title}>
          {g.note && <p className={note}>{g.note}</p>}
          {g.kinds.map((k) => {
            const on = !isQueryKind(k) && e.widgets.some((w) => w.kind === k);
            return (
              <LibraryRow key={k} glyph={GLYPH[k]} name={k === "list" ? "List" : KIND_NAMES[k]} line={LINES[k]} disabled={full || on} add={on ? "on home" : full ? "full" : "+ add"} onClick={() => e.add(k)} />
            );
          })}
        </Section>
      ))}
    </Side>
  );
});

function LibraryRow({ glyph, name, line, disabled, add, onClick }: { glyph: ReactNode; name: string; line: ReactNode; disabled: boolean; add: string; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="group/li grid w-full grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-1.5 py-[7px] text-left outline-none enabled:hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
    >
      <span className="grid size-[30px] place-items-center rounded-lg bg-sidebar font-mono text-[12px] font-semibold text-ink-2 [&_svg]:size-4">{glyph}</span>
      <span>
        <span className="block text-[13px] font-semibold">{name}</span>
        <span className="mt-0.5 block text-[12px] leading-[1.35] text-ink-3">{line}</span>
      </span>
      <span className="font-mono text-[11px] text-ink-3 group-enabled/li:group-hover/li:text-ink">{add}</span>
    </button>
  );
}

/**
 * Ready queries (RSVA-523): a widget with its query written, each with how many issues it finds here now. One this project
 * cannot run (a label it lacks) is left out, so nothing added from here shows an error.
 */
const ReadyQueries = observer(function ReadyQueries({ project, full }: { project: Project; full: boolean }) {
  const e = homeEditor;
  const ready = HOME_PRESETS.map((p) => ({ p, run: runWidget(project.id, p.query) })).filter((x) => !x.run.errors.length);
  if (!ready.length) return null;
  return (
    <Section title="Ready queries">
      <p className={note}>Added with their query written; change it in the widget’s settings.</p>
      {ready.map(({ p, run }) => {
        const on = e.widgets.some((w) => w.query === p.query && w.kind === p.kind);
        return (
          <LibraryRow
            key={p.id}
            glyph={GLYPH[p.kind]}
            name={p.name}
            line={
              <>
                {p.line} · <span className="font-mono text-[11px]">{run.rows.length} now</span>
              </>
            }
            disabled={full || on}
            add={on ? "on home" : full ? "full" : "+ add"}
            onClick={() => e.addPreset(p)}
          />
        );
      })}
    </Section>
  );
});

/** One widget's settings. */
export const WidgetSettings = observer(function WidgetSettings({ project, w }: { project: Project; w: HomeWidget }) {
  const e = homeEditor;
  const set = (s: Partial<HomeWidget>) => e.update(w.id, s);
  const query = isQueryKind(w.kind);
  const result = query ? runWidget(project.id, w.query) : null;
  const listish = w.kind === "list" || w.kind === "wait" || w.kind === "pulls" || w.kind === "activity";
  return (
    <Side
      head={
        <>
          <Button type="button" variant="ghost" onClick={() => e.select(null)}>
            <ArrowLeftIcon />
            Widgets
          </Button>
          <Close />
        </>
      }
      foot={
        <Button type="button" variant="outline" onClick={() => e.remove(w.id)}>
          Remove from home
        </Button>
      }
    >
      <div className="mx-1.5 mb-4 flex flex-col gap-1.5">
        <label htmlFor="home-title" className="text-[12px] font-medium text-ink-2">
          Title
        </label>
        <Input id="home-title" value={w.title} placeholder={widgetTitle({ ...w, title: "" })} maxLength={80} onChange={(ev) => set({ title: ev.target.value })} />
      </div>
      {query && result && (
        <div className="mx-1.5 mb-4 flex flex-col gap-1.5">
          <label htmlFor="home-query" className="text-[12px] font-medium text-ink-2">
            Query
          </label>
          {/* The View panel's query line: completions for a word being typed, a mistake with what was meant. */}
          <QueryLine
            id="home-query"
            text={w.query}
            autoFocus={!w.query}
            apply={(query) => {
              set({ query });
              return queryErrors(project.id, query);
            }}
          />
          {!result.errors.length && (
            <span className="text-[12px] leading-[1.45] text-ink-3">
              {result.rows.length === 1 ? "1 issue matches" : `${result.rows.length} issues match`} in {project.key} · the same line works in rsva, the API and Telegram
            </span>
          )}
          {!result.errors.length && <Reach query={w.query} />}
        </div>
      )}
      {query && (
        <Field label="Show as">
          <Segmented<QueryKind>
            label="Show as"
            variant="quiet"
            fill
            value={w.kind as QueryKind}
            onChange={(kind) => set({ kind, ...(kind === "count" ? { width: 3 } : w.width === 3 ? { width: 6 } : {}) })}
            options={[
              { value: "list", label: "List", icon: <ListBulletsIcon /> },
              { value: "count", label: "Count", icon: <HashIcon /> },
              { value: "chart", label: "Chart", icon: <ChartBarIcon /> },
            ]}
          />
        </Field>
      )}
      {w.kind === "chart" && (
        <Field label="By">
          <Segmented label="Chart by" variant="quiet" fill value={w.by} onChange={(by) => set({ by })} options={CHART_BY.map((b) => ({ value: b, label: BY_NAMES[b] }))} />
        </Field>
      )}
      <Field label="Width">
        <Segmented
          label="Width"
          variant="quiet"
          fill
          value={String(w.width)}
          onChange={(v) => set({ width: Number(v) as HomeWidth })}
          options={HOME_WIDTHS.map((n) => ({ value: String(n), label: WIDTH_NAMES[n] }))}
        />
      </Field>
      {listish && (
        <Field label="Rows">
          <Segmented label="Rows" variant="quiet" fill value={String(w.rows)} onChange={(v) => set({ rows: Number(v) as HomeWidget["rows"] })} options={HOME_ROWS.map((n) => ({ value: String(n), label: ROW_NAMES[n] }))} />
        </Field>
      )}
      {query && <AsTab project={project} w={w} />}
    </Side>
  );
});

/** Under a query that reads here: the other projects it does not read in, where a default home's widget would show the mistake instead of issues. */
const Reach = observer(function Reach({ query }: { query: string }) {
  const { failing, of } = queryReach(query);
  if (!failing.length) return null;
  const keys = failing.map((p) => p.key);
  return (
    <span className="text-[12px] leading-[1.45] text-signal-text" title={keys.join(", ")}>
      Not read in {failing.length} of {of} projects ({keys.slice(0, 4).join(", ")}
      {keys.length > 4 ? ` and ${keys.length - 4} more` : ""}): a label or a status by name is each project’s own; <span className="font-mono text-[11px]">group:</span> and the workspace’s labels read everywhere.
    </span>
  );
});

function Field({ label: name, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mx-1.5 mb-4 flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-ink-2">{name}</span>
      {children}
    </div>
  );
}

/** A tab of the project with the widget's query: a saved view, made now, with Undo. */
const AsTab = observer(function AsTab({ project, w }: { project: Project; w: HomeWidget }) {
  const name = widgetTitle(w);
  const make = () => {
    const id = uuidv7();
    const position = Math.max(0, ...store.views.list.map((v) => v.position)) + 1;
    const display = { ...DEFAULT_DISPLAY, orderBy: "updatedAt" };
    store.views.save(id, { name, icon: "stack", query: `project:${project.key} ${w.query}`.trim(), display, layout: "list", shared: true, tab: true, position });
    setActiveTab(project.id, id);
    notice.show(`${name} added as a tab`, () => {
      const v = store.views.get(id);
      if (v) deleteView(v, true);
    });
  };
  return (
    <button type="button" onClick={make} className="flex w-full flex-col gap-0.5 rounded-lg px-1.5 py-2 text-left outline-none hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring">
      <span className="text-[13px] font-semibold">Also open it as a tab</span>
      <span className="text-[12px] leading-[1.35] text-ink-3">
        A tab in {project.key}’s issues with the same query, for everyone. It stays when the widget goes.
      </span>
    </button>
  );
});
