// New cycle and Edit cycle (PLNR-63, the CycleCreate, CycleCreateOverlap and CycleEdit artboards), built like the New
// issue modal. The calendar draws the project's other cycles as bars under their days and today as a dot, and
// offers the first free dates after the last cycle; days that collide with another cycle turn red, the message names it
// and offers the first free start, and saving waits until the dates are clear. No dates saves a draft. A cycle that has
// started keeps its start; its end can move.
import { CalendarBlankIcon, CaretLeftIcon, CaretRightIcon, InfoIcon, UserIcon, WarningIcon } from "@phosphor-icons/react";
import { addDays, daysBetween } from "@rsva/schema/days";
import { CYCLE_DESCRIPTION_MAX, cleanName, type Cycle, type Project } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Segmented } from "@rsva/ui/components/segmented";
import { Textarea } from "@rsva/ui/components/textarea";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { face } from "../lib/face.ts";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { clashWith, freeStart, monthOf, nextCycleName, shifted, suggestDates, type Range } from "../lib/cycle-calendar.ts";
import { cycleShort, lengthText, statusOf } from "../lib/cycles.ts";
import { store } from "../store.ts";
import { ChipButton } from "./create-issue-modal.tsx";
import { submitKeys } from "./form-keys.ts";
import { LeadPicker } from "./pickers.tsx";
import { MONTHS, MonthGrid } from "./month-grid.tsx";
import { ProjectIcon } from "./sidebar-parts.tsx";
import { plural } from "@rsva/schema/util";
import { CreateCrumb, CreateDialog, CreateFooter, CreateName } from "./create-dialog.tsx";
import { localToday } from "@rsva/query";
import { formatDate } from "@rsva/display/time";

const LENGTHS = [1, 2, 3, 4].map((w) => ({ value: String(w * 7), label: `${w}w`, title: plural(w, "week") }));

/** `cycle` null: a new one. */
export const CycleDialog = observer(function CycleDialog({ project, cycle, onClose }: { project: Project; cycle: Cycle | null; onClose: () => void }) {
  return (
    <CreateDialog onClose={onClose} className="md:max-w-[640px]">
      <Form project={project} cycle={cycle} onClose={onClose} />
    </CreateDialog>
  );
});

const Form = observer(function Form({ project, cycle, onClose }: { project: Project; cycle: Cycle | null; onClose: () => void }) {
  const cycles = store.cyclesOf(project.id);
  const now = localToday();
  const [name, setName] = useState(() => cycle?.name ?? nextCycleName(cycles));
  const [description, setDescription] = useState(cycle?.description ?? "");
  const [leadId, setLeadId] = useState<string | null>(() => (cycle ? cycle.leadId : (store.me?.id ?? null)));
  const [range, setRange] = useState<Range | null>(() =>
    cycle ? (cycle.startDate && cycle.endDate ? { startDate: cycle.startDate, endDate: cycle.endDate } : null) : suggestDates(cycles, now),
  );
  const [picking, setPicking] = useState<"start" | "end">("start");
  // The first of the two months shown: the cycle's start, else this month.
  const [month, setMonth] = useState(() => monthOf(range?.startDate ?? now));
  const started = !!cycle && (statusOf(cycle, now) === "active" || statusOf(cycle, now) === "ended");
  const clash = range ? clashWith(cycles, cycle?.id ?? null, range) : null;
  const len = range ? daysBetween(range.startDate, range.endDate) + 1 : 0;
  const lead = leadId ? store.users.get(leadId) : undefined;
  const ok = !!cleanName(name) && !clash;

  const pick = (day: string) => {
    if (started) {
      if (range && day >= range.startDate) setRange({ ...range, endDate: day });
      return;
    }
    if (picking === "start" || !range) {
      // The length stays as it was: one click moves the whole cycle, a second one sets its end.
      const keep = range ? daysBetween(range.startDate, range.endDate) : 13;
      setRange({ startDate: day, endDate: addDays(day, keep) });
      setPicking("end");
    } else {
      setRange(day < range.startDate ? { startDate: day, endDate: range.startDate } : { ...range, endDate: day });
      setPicking("start");
    }
  };

  const submit = () => {
    if (!ok) return;
    const set = { name: cleanName(name), description: description.trim(), leadId, startDate: range?.startDate ?? null, endDate: range?.endDate ?? null };
    if (cycle) store.updateCycle(cycle.id, set);
    else store.createCycle(project.id, set);
    onClose();
  };

  // The previous cycle ends the day before: the message says so, which is the usual case.
  const before = range && cycles.find((c) => c.id !== cycle?.id && c.endDate === addDays(range.startDate, -1));
  const message = clash ? (
    <>
      Overlaps {clash.name} ({formatDate(clash.startDate!)} – {formatDate(clash.endDate!)}) on {overlapDays(range!, clash)} days. Cycles of one project can’t overlap.
    </>
  ) : range ? (
    started ? (
      <>The start date is fixed once a cycle has started. Moving the end changes the ideal line.</>
    ) : (
      <>
        {formatDate(range.startDate)} – {formatDate(range.endDate)}, {len} days.{before ? ` Starts the day after ${before.name} ends.` : ""}
      </>
    )
  ) : (
    <>No dates: the cycle is saved as a draft, to plan issues into before picking dates.</>
  );

  return (
    <form {...submitKeys(submit)}>
      <CreateCrumb
        where={
          <>
            <ProjectIcon project={project} className="size-4" />
            {project.name}
          </>
        }
        title={cycle ? `Edit ${cycle.name}` : "New cycle"}
      />
      <div className="flex flex-col gap-1 px-5 pt-3">
        <CreateName value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <Textarea
          rows={2}
          aria-label="Description"
          placeholder="What this cycle is for (optional)"
          value={description}
          maxLength={CYCLE_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.target.value)}
          className="min-h-0 resize-none border-transparent bg-transparent px-0 py-1 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-5 pt-2">
        <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-[5px] border px-2 font-mono text-meta", clash && "border-destructive/40 text-destructive")}>
          <CalendarBlankIcon className="size-3" />
          {range ? `${formatDate(range.startDate)} – ${formatDate(range.endDate)}` : "No dates"}
          {range && <span className="text-ink-3">{lengthText(len)}</span>}
        </span>
        <LeadPicker value={leadId} onChange={setLeadId} trigger={<ChipButton set>{lead ? <UserAvatar {...face(lead)} className="size-4" /> : <UserIcon />} Lead{lead ? `: ${lead.name}` : ""}</ChipButton>} />
        {cycle && <span className="font-mono text-meta text-ink-3">{cycleShort(cycle)}</span>}
      </div>
      <div className="mx-5 mt-3 rounded-md border bg-ground p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption text-ink-2">Length</span>
          <Segmented
            label="Length"
            variant="quiet"
            options={LENGTHS.map((l) => ({ ...l, disabled: !range }))}
            value={String(len) as string}
            onChange={(v) => range && setRange({ ...range, endDate: addDays(range.startDate, Number(v) - 1) })}
          />
          <span className="ml-auto flex items-center gap-1">
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Earlier months" onClick={() => setMonth((v) => shifted(v, -1))}>
              <CaretLeftIcon />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Later months" onClick={() => setMonth((v) => shifted(v, 1))}>
              <CaretRightIcon />
            </Button>
          </span>
        </div>
        <div className="mt-2 grid grid-cols-1 gap-5 sm:grid-cols-2">
          {[0, 1].map((k) => {
            const { y, m } = shifted(month, k);
            return <Month key={k} y={y} m={m} cycles={cycles} self={cycle?.id ?? null} range={range} clash={!!clash} startLocked={started} onPick={pick} />;
          })}
        </div>
        <div className="mt-3 flex items-start gap-2 border-t pt-2.5 text-caption" role={clash ? "alert" : "status"}>
          {clash ? <WarningIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" /> : <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-ink-3" />}
          <span className={cn("flex-1", clash ? "text-destructive" : "text-ink-2")}>{message}</span>
          {clash && range && !started && (
            <Button type="button" variant="outline" size="sm" onClick={() => setRange(freeStart(cycles, cycle?.id ?? null, range))}>
              Start {formatDate(freeStart(cycles, cycle?.id ?? null, range).startDate)}
            </Button>
          )}
          {!clash && range && !cycle && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setRange(null)}>
              Clear dates
            </Button>
          )}
        </div>
      </div>
      <CreateFooter
        note={clash ? "Fix the dates to continue." : cycle ? "Issues keep their cycle." : "Add issues from the cycle’s page, an issue’s Cycle field or the list."}
        onCancel={onClose}
        disabled={!ok}
      >
        {cycle ? "Save changes" : range ? "Create cycle" : "Save draft"}
      </CreateFooter>
    </form>
  );
});

const overlapDays = (r: Range, c: Cycle) => daysBetween(r.startDate > c.startDate! ? r.startDate : c.startDate!, r.endDate < c.endDate! ? r.endDate : c.endDate!) + 1;

/** One month's page: a button per day, the other cycles as bars under their days, the chosen range filled. */
const Month = observer(function Month({
  y,
  m,
  cycles,
  self,
  range,
  clash,
  startLocked,
  onPick,
}: {
  y: number;
  m: number;
  cycles: readonly Cycle[];
  self: string | null;
  range: Range | null;
  clash: boolean;
  startLocked: boolean;
  onPick: (day: string) => void;
}) {
  const now = localToday();
  const others = cycles.filter((c) => c.id !== self && c.startDate && c.endDate);
  const inMonth = (d: string) => Number(d.slice(5, 7)) - 1 === m;
  return (
    <div>
      <p className="mb-1.5 text-label font-semibold">
        {MONTHS[m]} {y}
      </p>
      <MonthGrid y={y} m={m}>
        {(d) => {
          const own = inMonth(d);
          const other = others.find((c) => d >= c.startDate! && d <= c.endDate!);
          const inRange = !!range && d >= range.startDate && d <= range.endDate;
          const edge = !!range && (d === range.startDate || d === range.endDate);
          const hit = inRange && !!other;
          const locked = startLocked && !!range && d < range.startDate;
          return (
            <button
              key={d}
              type="button"
              disabled={!own || locked}
              aria-pressed={inRange}
              aria-label={`${formatDate(d)}${other ? `, in ${other.name}` : ""}${d === now ? ", today" : ""}`}
              onClick={() => onPick(d)}
              className={cn(
                "relative grid h-8 place-items-center font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                !own && "text-faint",
                own && inRange && (hit ? "bg-destructive/10" : "bg-row-selected"),
              )}
            >
              {own && other && (d === other.startDate || d.endsWith("-01")) && (
                <span className="absolute top-0 left-1 text-[8.5px] leading-[9px] text-ink-3">{cycleShort(other)}</span>
              )}
              <span
                className={cn(
                  "relative z-1 grid h-6 w-7 place-items-center rounded-[4px]",
                  own && !edge && !locked && "hover:bg-row-hover",
                  own && edge && (hit || clash ? "bg-destructive text-white" : "bg-inverse text-inverse-ink"),
                  own && other && (d === other.startDate || d.endsWith("-01")) && "mt-1.5 h-[21px]",
                )}
              >
                {Number(d.slice(8))}
              </span>
              {own && other && (
                <span
                  className={cn(
                    "absolute bottom-px h-[3px]",
                    hit ? "bg-destructive" : "bg-rule-strong",
                    other.completedAt && "opacity-50",
                    d === other.startDate ? "left-1 rounded-l-[2px]" : "left-0",
                    d === other.endDate ? "right-1 rounded-r-[2px]" : "right-0",
                  )}
                />
              )}
              {own && d === now && <span className="absolute top-[3px] right-[5px] size-1 rounded-full bg-signal" />}
            </button>
          );
        }}
      </MonthGrid>
    </div>
  );
});
