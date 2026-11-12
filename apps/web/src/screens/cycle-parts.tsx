// Pieces the cycle screens share (PLNR-63, the Cycles artboards): the progress bar and its breakdown by state, the
// burn-up with its scale and the readout of the day under the pointer, and a row per assignee. The Cycles page's card
// and the cycle page's panel draw the same pieces at two widths.
import type { Issue, StartedStage } from "@rsva/schema/models";
import { StateIcon } from "@rsva/ui/components/state-icon";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { face } from "../lib/face.ts";
import { cn } from "@rsva/ui/lib/utils";
import { RobotIcon } from "@phosphor-icons/react";
import { observer } from "mobx-react-lite";
import { useState, type ReactNode } from "react";
import { formatDate } from "@rsva/display/time";
import { dayOf, idealAt, paceEnd, percentDone, pointAt, type BurnSeries, type CycleCounts } from "../lib/cycles.ts";
import { store } from "../store.ts";

/**
 * A cycle's issues by state, in workflow order from done: the bar's segments, with the colors of their glyphs, and the
 * rows that name them.
 */
export const GROUPS: { key: keyof CycleCounts; name: string; group: string; stage?: StartedStage; color: string; hatch?: boolean }[] = [
  { key: "completed", name: "Done", group: "completed", color: "bg-status-done" },
  { key: "approved", name: "Approved", group: "started", stage: "approved", color: "bg-status-approved" },
  { key: "review", name: "In review", group: "started", stage: "review", color: "bg-status-review" },
  { key: "progress", name: "In progress", group: "started", stage: "progress", color: "bg-status-progress" },
  { key: "unstarted", name: "Todo", group: "unstarted", color: "bg-status-todo/45" },
  { key: "backlog", name: "Backlog", group: "backlog", color: "bg-status-backlog/25" },
  { key: "cancelled", name: "Canceled", group: "cancelled", color: "bg-status-canceled/25", hatch: true },
];

/** The cycle's issues as one bar, a segment per state; empty, a grey track. */
export function ProgressBar({ counts, className }: { counts: CycleCounts; className?: string }) {
  return (
    <span className={cn("flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-rule-soft", className)} aria-hidden>
      {counts.total > 0 &&
        GROUPS.map((s) =>
          counts[s.key] ? (
            <span
              key={s.key}
              className={cn("h-full", s.color, s.hatch && "bg-[repeating-linear-gradient(135deg,transparent_0_2px,var(--color-rule-strong)_2px_3px)]")}
              style={{ width: `${(counts[s.key] / counts.total) * 100}%` }}
            />
          ) : null,
        )}
    </span>
  );
}

function Row({ icon, name, sub, n }: { icon: ReactNode; name: string; sub?: string; n: number }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="mt-[3px] flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 text-label">
        {name}
        {sub && <span className="ml-1.5 text-caption text-ink-3">{sub}</span>}
      </span>
      <span className="font-mono text-meta text-ink-2 tabular-nums">{n}</span>
    </div>
  );
}

/** "30% · 6 of 20 done", the bar, and a line per state group; the started ones say how many are in each stage. */
export function ProgressBlock({ counts, frozen = false }: { counts: CycleCounts; frozen?: boolean }) {
  const icon = (group: string, stage?: StartedStage) => <StateIcon group={group} {...(stage ? { stage } : {})} />;
  const stages = [counts.progress && `${counts.progress} in progress`, counts.review && `${counts.review} in review`, counts.approved && `${counts.approved} approved`].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-baseline gap-2">
        <span className="font-mono text-[26px] leading-none font-medium tabular-nums">{percentDone(counts)}%</span>
        <span className="text-label text-ink-2">
          {counts.completed} of {counts.total - counts.cancelled} done
        </span>
      </p>
      <ProgressBar counts={counts} className="h-2.5 rounded-[3px]" />
      <div>
        <Row icon={icon("completed")} name="Completed" n={counts.completed} />
        <Row icon={icon("started", "progress")} name="Started" {...(stages && !frozen ? { sub: stages } : {})} n={counts.started} />
        <Row icon={icon("unstarted")} name="Unstarted" n={counts.unstarted} />
        <Row icon={icon("backlog")} name="Backlog" n={counts.backlog} />
        <Row icon={icon("cancelled")} name="Canceled" n={counts.cancelled} />
      </div>
    </div>
  );
}

/** Up to four gridlines on round values (1, 2, 5, 10…). */
function ticks(max: number): number[] {
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => max / s <= 4) ?? 1000;
  const out: number[] = [];
  for (let v = step; v <= max; v += step) out.push(v);
  return out;
}

const W = 300;
const H = 120;

/**
 * The burn-up: issues in the cycle (line), done (line over an area), the started ones not done yet as a band above it,
 * and the straight line to the scope; a red line at now. Point k sits k days from the start (RSVA-528). The scale is on
 * the left; the pointer over the chart reads out the point under it.
 */
export const BurnUp = observer(function BurnUp({ series, height = 132 }: { series: BurnSeries; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.scope) * 1.12;
  const x = (k: number) => ((pointAt(series, k) / series.days) * W).toFixed(1);
  const y = (v: number) => (H - (v / max) * H).toFixed(1);
  const path = (vs: number[]) => vs.map((v, k) => `${x(k)} ${y(v)}`);
  const line = (vs: number[]) => `M${path(vs).join(" L")}`;
  const last = series.scope.length - 1;
  const pct = (k: number) => `${(pointAt(series, k) / series.days) * 100}%`;
  const share = hover === null ? 0 : pointAt(series, hover) / series.days;
  const shift = share < 0.2 ? "0" : share > 0.8 ? "-100%" : "-50%";
  const at = (vs: number[]) => vs.at(-1) ?? 0;
  const scope = at(series.scope);
  const working = (k: number) => (series.started[k] ?? 0) - (series.done[k] ?? 0);
  const where = series.now === null ? null : series.now / series.days;
  const near = where === null ? null : where < 0.15 ? "start" : where > 0.85 ? "end" : null;
  const idealNow = last >= 0 ? idealAt(series, pointAt(series, last)) : 0;
  const pace = paceEnd(series);
  return (
    <figure className="m-0">
      <div className="relative pl-5">
        <div className="pointer-events-none absolute top-0 left-0 w-3.5" style={{ height }} aria-hidden>
          {ticks(max).map((v) => (
            <span key={v} className="absolute right-0 -translate-y-1/2 font-mono text-[9.5px] leading-none text-ink-3" style={{ top: `${(Number(y(v)) / H) * 100}%` }}>
              {v}
            </span>
          ))}
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full overflow-visible" style={{ height }} role="img" aria-label={`Burn-up: scope ${scope}, in progress ${working(last)}, done ${at(series.done)}`}>
          {ticks(max).map((v) => (
            <line key={v} x1={0} x2={W} y1={y(v)} y2={y(v)} className="stroke-rule-soft" vectorEffect="non-scaling-stroke" />
          ))}
          <line x1={0} x2={W} y1={H} y2={H} className="stroke-rule-strong" vectorEffect="non-scaling-stroke" />
          {last >= 0 && (
            <>
              <path d={`${line(series.done)} L${x(last)} ${H} L${x(0)} ${H} Z`} className="fill-status-done/10" />
              <path d={`${line(series.started)} L${path(series.done).reverse().join(" L")} Z`} className="fill-status-progress/30" />
              <path d={`M0 ${H} L${W} ${y(scope)}`} className="fill-none stroke-ink-3" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
              <path d={line(series.scope)} className="fill-none stroke-ink" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
              <path d={line(series.done)} className="fill-none stroke-status-done" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              {/* Where the done line ends at this pace (RSVA-570): a warning when it ends short of the scope. */}
              {pace !== null && (
                <path
                  d={`M${x(last)} ${y(at(series.done))} L${W} ${y(pace)}`}
                  className={cn("fill-none", pace < scope ? "stroke-warning" : "stroke-status-done")}
                  strokeWidth={1.4}
                  strokeDasharray="5 4"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </>
          )}
          {series.today !== null && <line x1={x(series.today)} x2={x(series.today)} y1={0} y2={H} className="stroke-signal" vectorEffect="non-scaling-stroke" />}
        </svg>
        {last >= 0 && (
          <div
            className="absolute top-0 right-0 left-5 cursor-crosshair"
            style={{ height }}
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const days = ((e.clientX - r.left) / r.width) * series.days;
              // The nearest point; today's sits at now, between two whole days.
              let k = Math.max(0, Math.min(last, Math.round(days)));
              if (series.today !== null && Math.abs(days - pointAt(series, series.today)) < Math.abs(days - pointAt(series, k))) k = series.today;
              if (k !== hover) setHover(k);
            }}
            onMouseLeave={() => setHover(null)}
          >
            {hover !== null && (
              <>
                <span className="pointer-events-none absolute inset-y-0 w-px bg-ink-3" style={{ left: pct(hover) }} />
                <span
                  className="pointer-events-none absolute top-0.5 z-10 flex flex-col gap-1 rounded-[5px] bg-inverse px-2.5 py-2 text-[11px] whitespace-nowrap text-inverse-ink shadow-md"
                  style={{ left: pct(hover), transform: `translateX(${shift})` }}
                >
                  <span className="font-mono text-[10.5px] opacity-70">
                    {hover === 0 ? `${formatDate(series.start)} · start` : hover === series.today ? `${formatDate(dayOf(series, hover - 1))} · now` : `${formatDate(dayOf(series, hover - 1))} · end of day ${hover}`}
                  </span>
                  <span className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
                    <span>Scope</span>
                    <b className="text-right font-mono font-normal">{series.scope[hover]}</b>
                    <span>In progress</span>
                    <b className="text-right font-mono font-normal">{working(hover)}</b>
                    <span>Done</span>
                    <b className="text-right font-mono font-normal">{series.done[hover]}</b>
                    <span>Ideal</span>
                    <b className="text-right font-mono font-normal">{idealAt(series, pointAt(series, hover))}</b>
                  </span>
                </span>
              </>
            )}
          </div>
        )}
      </div>
      <div className="relative mt-1 ml-5 h-3.5 font-mono text-[10px] text-ink-3">
        {/* "Today" takes the place of the first or last date when it is near it, so the labels never overlap. */}
        {!(near === "start") && <span className="absolute left-0">{formatDate(series.start)}</span>}
        {where !== null && (
          <span className={cn("absolute text-signal-text", near === "start" ? "" : near === "end" ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: `${where * 100}%` }}>
            Today
          </span>
        )}
        {!(near === "end") && <span className="absolute right-0">{formatDate(dayOf(series, series.days - 1))}</span>}
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-caption text-ink-2">
        <Legend swatch="border-t-2 border-ink" name="Scope" n={scope} />
        <Legend swatch="h-2 rounded-[1px] bg-status-progress/30" name="In progress" n={last >= 0 ? working(last) : 0} />
        <Legend swatch="border-t-2 border-status-done" name="Done" n={at(series.done)} />
        <Legend swatch="border-t-2 border-dashed border-ink-3" name="Ideal" n={idealNow} />
      </figcaption>
    </figure>
  );
});

function Legend({ swatch, name, n }: { swatch: string; name: string; n: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className={cn("block w-3.5", swatch)} />
      {name}
      <b className="font-mono font-normal text-ink">{n}</b>
    </span>
  );
}

/** Done of all, per assignee: the agents the work is delegated to first, then people, then nobody. */
export const AssigneeRows = observer(function AssigneeRows({ issues, counts }: { issues: readonly Issue[]; counts: (list: Issue[]) => CycleCounts }) {
  const byKey = new Map<string, Issue[]>();
  const add = (k: string, i: Issue) => {
    const list = byKey.get(k);
    if (list) list.push(i);
    else byKey.set(k, [i]);
  };
  for (const i of issues) {
    if (i.delegateId) add(`a:${i.delegateId}`, i);
    else if (i.assigneeIds.length) for (const id of i.assigneeIds) add(`u:${id}`, i);
    else add("none", i);
  }
  const rows = [...byKey].sort(([a], [b]) => (a[0] === b[0] ? 0 : a.startsWith("a:") ? -1 : b.startsWith("a:") ? 1 : a === "none" ? 1 : b === "none" ? -1 : 0));
  return (
    <div className="flex flex-col gap-1">
      {rows.map(([k, list]) => {
        const n = counts(list);
        const user = k === "none" ? null : store.users.get(k.slice(2));
        const name = user?.name ?? (k === "none" ? "Unassigned" : "Unknown");
        return (
          <div key={k} className="grid h-7 grid-cols-[minmax(0,1fr)_88px_44px] items-center gap-2.5 text-label">
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              {k.startsWith("a:") ? <RobotIcon className="size-3.5 shrink-0" /> : <UserAvatar {...face(user, name)} className="size-4" />}
              <span className="truncate">{name}</span>
            </span>
            <ProgressBar counts={n} />
            <span className="text-right font-mono text-meta whitespace-nowrap text-ink-3">
              {n.completed} / {list.length}
            </span>
          </div>
        );
      })}
    </div>
  );
});
