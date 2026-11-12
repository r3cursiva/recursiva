// The Timeline at Milestones detail (PLNR-120, the HistoryMilestones artboard): the project's cycles on the rail. A start
// is a ring, an end a filled square with its completion bar and numbers, a date still ahead dashed, today in the signal
// color. An end opens into who did what.
import { ArrowRightIcon, ArrowsClockwiseIcon, FlagCheckeredIcon } from "@phosphor-icons/react";
import { clockTime } from "@rsva/display/time";
import type { Cycle, Issue, Project } from "@rsva/schema/models";
import { buttonVariants } from "@rsva/ui/components/button";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { countIssues, cycleRange, daysLeft, statusOf, summaryCounts, type CycleCounts } from "../lib/cycles.ts";
import { cycleLines, endText, type CycleDay, type CycleEvent, type CycleWords } from "../lib/project-milestones.ts";
import { paths } from "../router.ts";
import { Link } from "../link.tsx";
import { store } from "../store.ts";
import { ProgressBar } from "./cycle-parts.tsx";
import { DayHeader, Line, RAIL, Toggle, type Node } from "./timeline-feed.tsx";
import { userName } from "./issue-history.tsx";

const WORDS: CycleWords = {
  issue: (id) => store.issues.get(id),
  key: (i) => store.issueKey(i),
  doer: (i: Issue) => i.delegateId ?? i.assigneeIds[0] ?? null,
  cycleName: (id) => store.cycles.get(id)?.name,
  issuesIn: (id) => store.issuesInCycle(id),
  done: (i) => store.states.get(i.stateId)?.group === "completed",
};

const countsOf = (c: Cycle): CycleCounts => summaryCounts(c) ?? countIssues(store.issuesInCycle(c.id), store.states, (p) => store.statesOf(p));

const lead = (c: Cycle) => c.leadId && `lead ${userName(c.leadId)}`;

/** A cycle's title and the line beside it, as the artboard words them. */
function wordsOf(e: CycleEvent, counts: CycleCounts): { title: string; meta: string } {
  const c = e.cycle;
  if (e.edge === "end" && e.mark === "planned") {
    const left = daysLeft(c);
    return { title: `${c.name} ends`, meta: counts.total ? `so far ${counts.completed} of ${counts.total - counts.cancelled} done · ${left}` : left };
  }
  if (e.edge === "end") return { title: `${c.name} ended`, meta: endText(c, counts, WORDS) };
  const planned = e.mark === "planned" ? counts.total : c.summary?.scope[0];
  return {
    title: `${c.name} ${e.mark === "planned" ? "starts" : "started"}`,
    meta: [planned ? `${planned} planned` : null, lead(c), cycleRange(c)].filter(Boolean).join(" · "),
  };
}

const CycleRow = observer(function CycleRow({ event, ws, project }: { event: CycleEvent; ws: string; project: Project }) {
  const [open, setOpen] = useState(false);
  const c = event.cycle;
  const counts = countsOf(c);
  const { title, meta } = wordsOf(event, counts);
  const ends = event.edge === "end";
  const opens = ends && !!c.completedAt && !!c.summary;
  const Icon = ends ? FlagCheckeredIcon : ArrowsClockwiseIcon;
  const href = paths.cycle(ws, project.key, c.number);
  const node: Node = event.mark;
  const planned = event.mark === "planned";
  return (
    <>
      <Line tall time={event.edge} node={node} row={event.key}>
        {opens && <Toggle expanded={open} label={title} onToggle={() => setOpen(!open)} />}
        <Link href={href} className={cn("link-plate inline-flex items-center gap-[7px] no-underline", planned ? "font-medium text-ink-2" : "text-[14px] font-semibold text-ink")}>
          <Icon className="size-[15px] shrink-0" />
          {title}
        </Link>
        {ends && counts.total > 0 && <ProgressBar counts={counts} className="w-[110px] shrink-0" />}
        <span className="font-mono text-[11px] whitespace-nowrap text-ink-3 max-md:whitespace-normal">{meta}</span>
        {(event.mark === "end" || (event.mark === "start" && statusOf(c) === "active")) && (
          <Link href={href} tabIndex={-1} className={buttonVariants({ variant: "ghost", size: "xs", className: "gap-1 text-[12px] text-ink-2" })}>
            Open cycle
            <ArrowRightIcon className="size-3" />
          </Link>
        )}
      </Line>
      {open &&
        cycleLines(c, counts, WORDS, userName).map((l) => (
          <Line key={l.label} time="" node={null} sub>
            <span className="font-medium text-ink">{l.label}</span>
            <span>{l.value}</span>
          </Line>
        ))}
    </>
  );
});

/** The line between what is ahead and what happened. */
const TodayLine = ({ now }: { now: Date }) => (
  <div className="mt-1 ml-14 flex items-center gap-2 font-mono text-[10.5px] text-signal-text after:h-px after:flex-auto after:bg-signal after:opacity-60">
    today · {clockTime(now.toISOString())}
  </div>
);

export const Milestones = observer(function Milestones({ days, today, now, ws, project }: { days: readonly CycleDay[]; today: string; now: Date; ws: string; project: Project }) {
  const line = days.findIndex((d) => d.key <= today);
  return days.map((d, i) => (
    <section key={d.key} aria-label={d.key}>
      {i === line && <TodayLine now={now} />}
      <DayHeader dayKey={d.key} now={now}>
        <span className="text-[12.5px] text-ink-3">{d.context}</span>
      </DayHeader>
      <ol className={RAIL}>
        {d.rows.map((e) => (
          <CycleRow key={e.key} event={e} ws={ws} project={project} />
        ))}
      </ol>
      {i === days.length - 1 && line < 0 && <TodayLine now={now} />}
    </section>
  ));
});

