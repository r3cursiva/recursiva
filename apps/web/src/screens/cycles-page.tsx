// A project's cycles (PLNR-63, the CyclesProject and CyclesEmpty artboards). The cycle in progress sits on top: its
// progress by state, the burn-up, the reviews waiting on the viewer and the assignees; a cycle past its end and not
// completed yet asks to be completed there. Upcoming, Drafts and Completed fold below, each row a link to the cycle's
// page. Everything is read from the store; only the burn-up's past days come from the server, once a day.
import { ArrowRightIcon, ArrowsClockwiseIcon, CircleDashedIcon, DotsThreeIcon, FlagCheckeredIcon, PencilSimpleIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { pinRef } from "@rsva/protocol";
import { sortedCycles } from "@rsva/query";
import { startedStage, type Cycle, type Issue, type Project } from "@rsva/schema/models";
import { Button, buttonVariants } from "@rsva/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@rsva/ui/components/collapsible";
import { CollapsibleCaret } from "@rsva/ui/components/collapsible-caret";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { Hint } from "@rsva/ui/components/tooltip";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { face } from "../lib/face.ts";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useState, type ReactNode } from "react";
import { burnSeries, countIssues, cycleProgress, cycleRange, cycleWhen, percentDone, statusOf, summaryCounts, type CycleCounts } from "../lib/cycles.ts";
import { paths } from "../router.ts";
import { store } from "../store.ts";
import { CompleteCycleDialog } from "./cycle-complete.tsx";
import { CycleDialog } from "./cycle-dialog.tsx";
import { pinLabel, togglePin } from "./pin-actions.ts";
import { AssigneeRows, BurnUp, ProgressBar, ProgressBlock } from "./cycle-parts.tsx";
import { FAB, SettingsLink } from "./layout-switch.tsx";
import { ProjectHeader } from "./project-header.tsx";
import { IssueLine } from "./state-glyph.tsx";
import { listIssuePath } from "./issue-actions.ts";
import { FavoriteStar } from "./favorite-button.tsx";
import { Link } from "../link.tsx";

type Open = { kind: "new" } | { kind: "edit" | "complete"; cycle: Cycle } | null;

/** The dialogs a cycle screen opens: one at a time, rendered where the screen puts it. */
export function useCycleDialogs(project: Project) {
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  const dialog =
    open?.kind === "new" ? (
      <CycleDialog project={project} cycle={null} onClose={close} />
    ) : open?.kind === "edit" ? (
      <CycleDialog project={project} cycle={open.cycle} onClose={close} />
    ) : open?.kind === "complete" ? (
      <CompleteCycleDialog project={project} cycle={open.cycle} onClose={close} />
    ) : null;
  return { dialog, open: setOpen };
}

/** Counts of the cycle's issues now, or as frozen at its completion. */
export function cycleCounts(c: Cycle): CycleCounts {
  return summaryCounts(c) ?? countIssues(store.issuesInCycle(c.id), store.states, (p) => store.statesOf(p));
}

/** Reviews waiting on the viewer: their items in the review stage, mostly an agent's finished work. */
export function waitingOnMe(issues: readonly Issue[]): Issue[] {
  const me = store.me?.id;
  return me ? issues.filter((i) => i.assigneeIds.includes(me) && startedStage(store.statesOf(i.projectId), i.stateId) === "review") : [];
}

/** The header's tools on both cycle screens: the project's pages, then the screen's own buttons. */
export function CycleHeaderTools({ ws, project, children }: { ws: string; project: Project; children?: ReactNode }) {
  return (
    <>
      <SettingsLink ws={ws} project={project} />
      {children}
    </>
  );
}

export const ProjectCycles = observer(function ProjectCycles({ ws, project }: { ws: string; project: Project }) {
  const { dialog, open } = useCycleDialogs(project);
  const all = sortedCycles(store.cyclesOf(project.id), true);
  const by = (s: string) => all.filter((c) => statusOf(c) === s);
  const current = [...by("active"), ...by("ended")];
  const completed = by("completed").reverse();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-ground">
      <ProjectHeader ws={ws} project={project}>
        <CycleHeaderTools ws={ws} project={project}>
          {all.length > 0 && (
            <Button className={`ml-1 ${FAB}`} aria-label="New cycle" onClick={() => open({ kind: "new" })}>
              <PlusIcon className="size-[22px] md:hidden" />
              <span>New cycle</span>
            </Button>
          )}
        </CycleHeaderTools>
      </ProjectHeader>
      <main className="min-h-0 flex-1 overflow-y-auto">
        {all.length === 0 ? (
          <Empty project={project} onCreate={() => open({ kind: "new" })} />
        ) : (
          <div className="flex flex-col gap-5 p-5 max-md:gap-4 max-md:p-3 max-md:pb-24">
            {current.map((c) => (
              <CurrentCard key={c.id} ws={ws} project={project} cycle={c} onComplete={() => open({ kind: "complete", cycle: c })} />
            ))}
            <Section ws={ws} project={project} title="Upcoming" note="start in date order" cycles={by("upcoming")} onAdd={() => open({ kind: "new" })} onEdit={(c) => open({ kind: "edit", cycle: c })} />
            <Section ws={ws} project={project} title="Drafts" note="no dates yet: plan issues before picking dates" cycles={by("draft")} onAdd={() => open({ kind: "new" })} onEdit={(c) => open({ kind: "edit", cycle: c })} />
            <Section ws={ws} project={project} title="Completed" note="read-only" cycles={completed} />
          </div>
        )}
      </main>
      {dialog}
    </div>
  );
});

function Empty({ project, onCreate }: { project: Project; onCreate: () => void }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <span className="grid size-10 place-items-center rounded-[10px] border border-rule-strong text-ink-2">
          <ArrowsClockwiseIcon className="size-5" />
        </span>
        <h2 className="text-body-lg font-semibold">No cycles in {project.name} yet</h2>
        <p className="text-label text-ink-2">
          A cycle is a time box for the project’s work, usually two weeks. Each issue sits in one cycle at most, and unfinished items can move to the next
          one when it ends.
        </p>
        <Button onClick={onCreate}>Create cycle</Button>
      </div>
    </div>
  );
}

/** The cycle in progress, or one past its end that waits to be completed. */
const CurrentCard = observer(function CurrentCard({ ws, project, cycle, onComplete }: { ws: string; project: Project; cycle: Cycle; onComplete: () => void }) {
  const issues = store.issuesInCycle(cycle.id);
  const counts = cycleCounts(cycle);
  const series = burnSeries(cycle, cycleProgress(cycle), counts);
  const href = paths.cycle(ws, project.key, cycle.number);
  const ended = statusOf(cycle) === "ended";
  const lead = cycle.leadId ? store.users.get(cycle.leadId) : undefined;
  const waiting = waitingOnMe(issues);
  return (
    <section aria-label={cycle.name} className="overflow-hidden rounded-(--float-radius) border bg-panel">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-5 py-3.5 max-md:gap-y-1.5 max-md:px-4">
        <span className={cn("font-mono text-[10.5px] tracking-wider uppercase", ended ? "text-signal-text" : "text-ink-3")}>{ended ? "Ended" : "Active"}</span>
        <Link href={href} className="link-plate text-title-md font-semibold">
          {cycle.name}
        </Link>
        <span className="font-mono text-meta text-ink-2">
          {cycleRange(cycle)} · {cycleWhen(cycle)}
        </span>
        <span className="ml-auto flex items-center gap-2 max-md:ml-0 max-md:w-full max-md:flex-wrap">
          {lead && (
            <span className="flex items-center gap-1.5 text-caption text-ink-3">
              Lead <UserAvatar {...face(lead)} className="size-4" /> <span className="text-ink-2">{lead.name}</span>
            </span>
          )}
          {ended && (
            <Button size="sm" onClick={onComplete}>
              <FlagCheckeredIcon /> Complete cycle
            </Button>
          )}
          <Link href={href} className={buttonVariants({ variant: "outline", size: "sm", className: "max-md:ml-auto" })}>
            Open cycle <ArrowRightIcon />
          </Link>
        </span>
        {cycle.description && <p className="w-full text-label text-ink-2">{cycle.description}</p>}
      </header>
      <div className="grid grid-cols-1 divide-y lg:grid-cols-3 lg:divide-x lg:divide-y-0">
        <div className="p-5 max-md:p-4">
          <ProgressBlock counts={counts} />
        </div>
        <div className="p-5 max-md:p-4">
          <p className="mb-3 flex items-center text-label font-semibold">
            Burn-up <span className="ml-auto font-mono text-meta font-normal text-ink-3">issues</span>
          </p>
          {series && <BurnUp series={series} />}
        </div>
        <div className="flex flex-col gap-3 p-5 max-md:p-4">
          <p className="flex items-center gap-2 text-label font-semibold">
            Waiting on you
            <span className={cn("font-mono text-meta font-normal", waiting.length ? "text-signal-text" : "text-ink-3")}>{waiting.length} to review</span>
          </p>
          {waiting.length === 0 ? (
            <p className="text-caption text-ink-3">Nothing in this cycle waits for your review.</p>
          ) : (
            <div className="flex flex-col">
              {waiting.map((i) => (
                <Link key={i.id} href={listIssuePath(ws, i)} className="flex h-7 items-center gap-2 rounded-sm px-1 outline-none hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring max-md:h-11">
                  <IssueLine issue={i} titleClassName="text-label" />
                </Link>
              ))}
            </div>
          )}
          <div className="border-t border-rule-soft pt-2.5">
            <p className="mb-1 flex items-center text-caption font-semibold text-ink-2">
              Assignees <span className="ml-auto font-mono text-meta font-normal text-ink-3">done / issues</span>
            </p>
            <AssigneeRows issues={issues} counts={(list) => countIssues(list, store.states, (p) => store.statesOf(p))} />
          </div>
        </div>
      </div>
    </section>
  );
});

/** A folding list of cycles: upcoming, drafts or completed. */
const Section = observer(function Section({
  ws,
  project,
  title,
  note,
  cycles,
  onAdd,
  onEdit,
}: {
  ws: string;
  project: Project;
  title: string;
  note: string;
  cycles: Cycle[];
  onAdd?: () => void;
  onEdit?: (c: Cycle) => void;
}) {
  const [shut, setShut] = useState(false);
  if (!cycles.length) return null;
  return (
    <Collapsible render={<section aria-label={title} />} open={!shut} onOpenChange={(open) => setShut(!open)} className="overflow-hidden rounded-(--float-radius) border bg-panel">
      <div className="flex h-9 items-center gap-2 border-b bg-group pr-3 pl-3 max-md:h-11 max-md:pr-1">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <CollapsibleCaret open={!shut} />
          <span className="text-label font-semibold">{title}</span>
          <span className="font-mono text-meta text-ink-3">{cycles.length}</span>
          <span className="truncate text-caption text-ink-3 max-md:hidden">{note}</span>
        </CollapsibleTrigger>
        {onAdd && (
          <Hint label="New cycle">
            <Button variant="ghost" size="icon-sm" aria-label={`New cycle in ${title}`} onClick={onAdd}>
              <PlusIcon />
            </Button>
          </Hint>
        )}
      </div>
      <CollapsibleContent>
        {cycles.map((c) => (
          <CycleRow key={c.id} ws={ws} project={project} cycle={c} {...(onEdit ? { onEdit: () => onEdit(c) } : {})} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
});

const CycleRow = observer(function CycleRow({ ws, project, cycle, onEdit }: { ws: string; project: Project; cycle: Cycle; onEdit?: () => void }) {
  const counts = cycleCounts(cycle);
  const status = statusOf(cycle);
  const href = paths.cycle(ws, project.key, cycle.number);
  const pin = pinRef("cycle", cycle.id);
  const lead = cycle.leadId ? store.users.get(cycle.leadId) : undefined;
  const moved = cycle.summary ? cycle.summary.open.filter((id) => store.issues.get(id)?.cycleId !== cycle.id).length : 0;
  const sub = [cycle.description, status === "upcoming" ? cycleWhen(cycle) : null, moved ? `${moved} moved on` : null].filter(Boolean).join(" · ");
  return (
    <div className="group/row relative grid grid-cols-[22px_minmax(0,1fr)_150px_120px_40px_44px_24px_28px] items-center gap-3 border-b border-rule-soft px-3.5 py-[calc(8px+var(--air))] last:border-b-0 hover:bg-row-hover max-md:min-h-14 max-md:grid-cols-[22px_minmax(0,1fr)_44px_auto] max-md:py-1.5 max-md:pr-1">
      <span className="text-ink-3">{status === "draft" ? <CircleDashedIcon className="size-4" /> : status === "completed" ? <FlagCheckeredIcon className="size-4" /> : <ArrowsClockwiseIcon className="size-4" />}</span>
      <Link href={href} className="min-w-0 outline-none after:absolute after:inset-0 focus-visible:underline">
        <span className="block truncate text-label max-md:text-[15px] max-md:font-medium">{cycle.name}</span>
        {sub && <span className="block truncate text-caption text-ink-3">{sub}</span>}
      </Link>
      <span className="font-mono text-meta text-ink-2 max-md:hidden">{cycleRange(cycle)}</span>
      <ProgressBar counts={counts} className="max-md:hidden" />
      <span className="text-right font-mono text-meta text-ink-3 max-md:hidden">{counts.total}</span>
      <span className="text-right font-mono text-meta font-medium">{percentDone(counts)}%</span>
      <span className="max-md:hidden">{lead && <UserAvatar {...face(lead)} className="size-[18px]" />}</span>
      <span className="relative z-1">
        {/* Anyone pins a cycle (PLNR-292); those who may change it also edit and delete it. */}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${cycle.name} options`} className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100 max-md:text-ink-3" />}>
            <DotsThreeIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => togglePin(pin, cycle.name)}>
              <FavoriteStar on={store.views.pinned(pin)} />
              {pinLabel(pin)}
            </DropdownMenuItem>
            {onEdit && (
              <>
                <DropdownMenuItem onClick={onEdit}>
                  <PencilSimpleIcon />
                  Edit…
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => store.deleteCycle(cycle.id)}>
                  <TrashIcon />
                  Delete
                  <span className="ml-auto text-caption text-ink-3">{counts.total ? `${counts.total} leave it` : ""}</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  );
});

