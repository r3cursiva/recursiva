// "Closed, 12 months" on a project's home (RSVA-576, the Quire artboards FramedProjectHomeYear and …YearDay): a cell
// a day, lit by how many issues were closed on it. From the pool, with no request. A cell is a way in, not a dead end:
// it lists the day's issues under the grid, and the list opens as the project's list by the query it shows.
import { clockTime } from "@rsva/display/time";
import { localToday } from "@rsva/query";
import { plural } from "@rsva/schema/util";
import type { Issue, Project } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Segmented } from "@rsva/ui/components/segmented";
import { cn } from "@rsva/ui/lib/utils";
import { XIcon } from "@phosphor-icons/react";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { account } from "../account.ts";
import { closedYear, YEAR_WEEKS, YEAR_WHO, yearBegan, yearDays, yearStep, type YearCell, type YearWho } from "../lib/closed-year.ts";
import { openAsList, runWidget } from "../lib/home.ts";
import { closed } from "../lib/my-work-home.ts";
import { useNow } from "../lib/time.ts";
import { store } from "../store.ts";
import { IssueRow, meta, MoreAsList, shown } from "./home-widgets.tsx";

const utc = (day: string) => new Date(`${day}T00:00:00Z`);
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...o, timeZone: "UTC" });
const MONTH = fmt({ month: "short" });
const SHORT = fmt({ month: "short", day: "numeric" });
const DAY = fmt({ weekday: "short", month: "short", day: "numeric" });
const LONG = fmt({ weekday: "short", month: "short", day: "numeric", year: "numeric" });
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const WHO_NAMES: Record<YearWho, string> = { all: "All", people: "People", agents: "Agents" };
/** What narrows the day's query to whose closes are shown. */
const WHO_QUERY: Record<YearWho, string> = { all: "", people: " agent:none", agents: " agent:any" };

/** The cell's light: the done colour over the widget's ground, by level. */
const LEVELS: Record<YearCell["level"], string> = {
  0: "bg-[color-mix(in_srgb,var(--color-rule)_70%,var(--color-panel))]",
  1: "bg-[color-mix(in_srgb,var(--color-status-done)_26%,var(--color-panel))]",
  2: "bg-[color-mix(in_srgb,var(--color-status-done)_48%,var(--color-panel))]",
  3: "bg-[color-mix(in_srgb,var(--color-status-done)_74%,var(--color-panel))]",
  4: "bg-status-done",
};
const CELL = "block aspect-square w-full min-w-0 rounded-[2.5px]";
/** A gutter for the weekdays, then the weeks. Narrower than the weeks need, the grid scrolls, the latest in view. */
const COLUMNS = { gridTemplateColumns: `26px repeat(${YEAR_WEEKS}, minmax(0, 1fr))` };

/** How many of a day's issues are listed before "N more". */
const DAY_ROWS = 6;

/** The cell an event came from, by its place in the year. */
const cellOf = (target: EventTarget, fallback: number): number => Number((target as HTMLElement).dataset["cell"] ?? fallback);

const dayQuery = (day: string, who: YearWho) => `group:completed closed:${day}${WHO_QUERY[who]}`;

/** Who closed it, as far as an issue says: its agent, or the first it is assigned to. */
const closer = (i: Issue): string => store.users.get(i.delegateId ?? i.assigneeIds[0] ?? "")?.name ?? "";

export const YearBody = observer(function YearBody({ ws, project }: { ws: string; project: Project }) {
  const now = useNow();
  const [picked, setWho] = useState<YearWho>("all");
  const [day, setDay] = useState<string | null>(null);
  const weekStart = account.settings.weekStart;
  const source = { issues: { values: () => store.issuesOf(project.id) }, states: store.states };
  const began = yearBegan(project.createdAt, store.issuesOf(project.id).map((i) => i.completedAt));
  const days = closed([[ws, source]], () => true, now, null, yearDays(localToday(), weekStart)).days;
  // The switch means something only when both kinds of closer are there; otherwise "All" is the only view worth showing.
  const mixed = days.some((d) => d.people > 0) && days.some((d) => d.agents > 0);
  const who = mixed ? picked : "all";
  const year = closedYear(days, who, began);
  const last = year.cells.length - 1;
  const first = year.cells.findIndex((c) => !c.before);
  // One Tab stop for the grid: the cell the arrows last reached, today's at first.
  const [at, setAt] = useState(-1);
  const stop = at < first || at > last ? last : at;
  const grid = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth;
  }, []);
  const share = year.total ? Math.round((100 * year.agents) / year.total) : 0;
  return (
    <div className="px-2 pb-1">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className={cn(meta, "whitespace-nowrap")}>{who === "all" ? `${year.total} closed${year.agents ? ` · ${share}% by agents` : ""}` : `${year.total} closed by ${who}`}</span>
        <span className="flex-1" />
        {mixed && <Segmented label="Closed by" variant="quiet" value={who} onChange={setWho} options={YEAR_WHO.map((v) => ({ value: v, label: WHO_NAMES[v] }))} />}
      </div>
      <div ref={scroll} className="overflow-x-auto pb-1">
        <div className="flex min-w-[560px] flex-col gap-1.5 p-[3px] max-md:min-w-[760px]">
          <div aria-hidden className="grid h-3 gap-x-[2.5px] font-mono text-[10.5px] leading-none whitespace-nowrap text-ink-3" style={COLUMNS}>
            {year.months.map((m) => (
              <span key={m.day} style={{ gridColumn: m.week + 2 }}>
                {MONTH.format(utc(m.day))}
              </span>
            ))}
          </div>
          <div
            ref={grid}
            className="grid grid-flow-col grid-rows-7 gap-[2.5px]"
            style={COLUMNS}
            // The arrows start from the cell that has the focus, clicked or reached by them; it stays the grid's Tab stop.
            onFocus={(e) => setAt(cellOf(e.target, stop))}
            onKeyDown={(e) => {
              const to = yearStep(cellOf(e.target, stop), year.cells.length, e.key, first);
              if (to < 0) return;
              e.preventDefault();
              setAt(to);
              grid.current?.querySelector<HTMLElement>(`[data-cell="${to}"]`)?.focus();
            }}
          >
            {WEEKDAYS.map((_, row) => {
              const weekday = (weekStart + row) % 7;
              return (
                <span key={row} aria-hidden className="flex items-center font-mono text-[9.5px] leading-none text-ink-3">
                  {weekday % 2 === 1 && WEEKDAYS[weekday]}
                </span>
              );
            })}
            {year.cells.map((c, k) => {
              // No day of the project's: a place kept in the grid, with nothing to read or to open.
              if (c.before) return <i key={c.day} aria-hidden className={cn(CELL, "shadow-[inset_0_0_0_1px_var(--color-rule-soft)]")} />;
              const label = `${DAY.format(utc(c.day))} · ${c.n} closed`;
              return (
                <button
                  key={c.day}
                  type="button"
                  data-cell={k}
                  tabIndex={k === stop ? 0 : -1}
                  title={label}
                  aria-label={label}
                  aria-pressed={c.day === day}
                  onClick={() => setDay(c.day === day ? null : c.day)}
                  className={cn(
                    CELL,
                    LEVELS[c.level],
                    "outline-none hover:shadow-[0_0_0_1.5px_var(--color-panel),0_0_0_3px_var(--color-ink-3)] focus-visible:shadow-[0_0_0_1.5px_var(--color-panel),0_0_0_3px_var(--color-ring)] aria-pressed:shadow-[0_0_0_1.5px_var(--color-panel),0_0_0_3px_var(--color-ink)]",
                  )}
                />
              );
            })}
          </div>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[29px] text-[12px] text-ink-3">
        <span>
          {!year.total && "Nothing closed in these twelve months."}
          {year.since && `Since ${SHORT.format(utc(year.since))}`}
          {year.since && (year.pause || year.busiest) && " · "}
          {year.pause && `Longest pause ${plural(year.pause.days, "day")}, ${SHORT.format(utc(year.pause.from))} – ${SHORT.format(utc(year.pause.to))}`}
          {year.pause && year.busiest && " · "}
          {year.busiest && `${year.pause || year.since ? "busiest" : "Busiest"} week ${SHORT.format(utc(year.busiest.from))}, ${year.busiest.n} closed`}
        </span>
        <span aria-hidden className="ml-auto inline-flex items-center gap-[3px] text-[11.5px] whitespace-nowrap">
          <span className="mr-[5px]">Less</span>
          {([0, 1, 2, 3, 4] as const).map((l) => (
            <i key={l} className={cn(CELL, LEVELS[l], "w-2.5")} />
          ))}
          <span className="ml-[5px]">More</span>
        </span>
      </div>
      {day && <DayIssues ws={ws} project={project} day={day} who={who} onClose={() => setDay(null)} />}
    </div>
  );
});

/** The issues closed on a day, in the order they were closed, and the query that opens them as the project's list. */
const DayIssues = observer(function DayIssues({ ws, project, day, who, onClose }: { ws: string; project: Project; day: string; who: YearWho; onClose: () => void }) {
  const query = dayQuery(day, who);
  const rows = runWidget(project.id, query).rows.toSorted((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));
  const list = shown(rows, DAY_ROWS);
  const open = () => openAsList(ws, project, query);
  return (
    <div className="mt-2.5 rounded-[9px] bg-sidebar pt-2 pr-1.5 pb-1.5 pl-3">
      <div className="mb-1 flex min-h-7 flex-wrap items-center gap-x-2.5 text-[13px]">
        <b className="font-semibold">{LONG.format(utc(day))}</b>
        <span className="text-[12.5px] text-ink-3">{rows.length} closed</span>
        <span className="flex-1" />
        <code className="font-mono text-[11.5px] text-ink-2 max-md:hidden">{query}</code>
        {/* On a phone the button takes a line of its own, under the day and the cross. */}
        <Button type="button" variant="outline" size="sm" disabled={!rows.length} onClick={open} className="max-md:order-last max-md:mt-1">
          Open as a list
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close the day" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      {!rows.length && <p className="pb-2 text-[12.5px] text-ink-3">Nothing was closed on this day.</p>}
      {list.map((i) => (
        <IssueRow key={i.id} ws={ws} issue={i} className="-ml-2 grid-cols-[16px_max-content_minmax(0,1fr)_auto_auto]">
          <span className="max-w-[140px] truncate text-[12px] text-ink-3 max-md:hidden">{closer(i)}</span>
          <time dateTime={i.completedAt ?? undefined} className={meta}>
            {i.completedAt && clockTime(i.completedAt)}
          </time>
        </IssueRow>
      ))}
      <MoreAsList n={rows.length - list.length} open={open} />
    </div>
  );
});
