// One cycle (PLNR-63, the CycleDetail, CycleDetailBoard and CycleDetailCompleted artboards): its issues in the
// project's own list or board, run over the cycle's issues (cycleList), with a panel of its progress, burn-up,
// assignees and details. Groups follow the workflow, as everywhere; the reviews waiting on the viewer sit in a strip
// above. A completed cycle is read-only: a banner with its final numbers, and the items it moved on listed with where
// they went. A new item made here joins the cycle.
import { FlagCheckeredIcon, InfoIcon, LockSimpleIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { pinRef } from "@rsva/protocol";
import { cyclesAhead, localToday } from "@rsva/query";
import type { Cycle, Project } from "@rsva/schema/models";
import { cn } from "@rsva/ui/lib/utils";
import { Button } from "@rsva/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@rsva/ui/components/dialog";
import { Segmented } from "@rsva/ui/components/segmented";
import { Hint } from "@rsva/ui/components/tooltip";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { face } from "../lib/face.ts";
import { observer } from "mobx-react-lite";
import { Suspense, useState, type ReactNode } from "react";
import { formatDate } from "@rsva/display/time";
import { burnSeries, countIssues, cycleDays, cycleProgress, cycleRange, cycleShort, cycleWhen, lengthText, percentDone, statusOf } from "../lib/cycles.ts";
import { isPhone } from "../lib/phone.ts";
import { store } from "../store.ts";
import { cycleList, type Layout } from "../view-state.ts";
import { createIssue } from "./create-state.ts";
import { AssigneeRows, BurnUp, ProgressBlock } from "./cycle-parts.tsx";
import { cycleCounts, CycleHeaderTools, useCycleDialogs, waitingOnMe } from "./cycles-page.tsx";
import { IssueList } from "./issue-list.tsx";
import { AddIssueButton, Board, HEAD_FIT, layoutOptions } from "./layout-switch.tsx";
import { FavoriteButton } from "./favorite-button.tsx";
import { ProjectHeader } from "./project-header.tsx";
import { IssueLine } from "./state-glyph.tsx";
import { listIssuePath } from "./issue-actions.ts";
import { Link } from "../link.tsx";

/** What an ended cycle asks for: a person to complete it, or nothing while the project's rollover does it (PLNR-64). */
function endedNote(project: Pick<Project, "cycleRollover">, c: Cycle, cycles: Iterable<Cycle>): string {
  const past = `${c.name} is past its end.`;
  if (!project.cycleRollover) return `${past} Complete it to move its unfinished issues on and freeze its numbers.`;
  return cyclesAhead(cycles, c.id, localToday()).some((x) => x.startDate)
    ? `${past} Automatic rollover will complete it and move its unfinished issues to the next cycle.`
    : `${past} Automatic rollover is on, but there is no next cycle: its unfinished issues wait for one, or complete it now.`;
}

export const CyclePage = observer(function CyclePage({ ws, project, number }: { ws: string; project: Project; number: number }) {
  const cycle = store.cyclesOf(project.id).find((c) => c.number === number);
  const { dialog, open } = useCycleDialogs(project);
  const [panel, setPanel] = useState(true);
  // A phone has no room beside the list: the same details open as a sheet.
  const [sheet, setSheet] = useState(false);
  if (!cycle) return <p className="p-6 text-ink-3">{store.status === "loading" ? "Loading…" : `No cycle ${number} in ${project.key}`}</p>;
  const view = cycleList(cycle);
  const status = statusOf(cycle);
  const done = status === "completed";
  const issues = store.issuesInCycle(cycle.id);
  const waiting = done ? [] : waitingOnMe(issues);
  const counts = cycleCounts(cycle);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-ground">
      <ProjectHeader ws={ws} project={project} page={cycle.name} favorite={<FavoriteButton pin={pinRef("cycle", cycle.id)} name={cycle.name} />}>
        <span className={cn("mr-2 shrink-0 font-mono text-meta whitespace-nowrap text-ink-3 max-md:hidden", HEAD_FIT.when)} title={cycleRange(cycle)}>
          <span className={HEAD_FIT.dates}>{cycleRange(cycle)} · </span>
          {cycleWhen(cycle)}
        </span>
        <Segmented label="Layout" variant="quiet" labelClassName={HEAD_FIT.layout} options={layoutOptions(true)} value={view.layout} onChange={(l: Layout) => view.setLayout(l)} />
        <CycleHeaderTools ws={ws} project={project}>
          <Hint label="Details">
            <Button variant="ghost" size="icon" aria-label="Details" aria-pressed={panel} onClick={() => (isPhone() ? setSheet(true) : setPanel(!panel))}>
              <InfoIcon />
            </Button>
          </Hint>
          {!done && (
            <Hint label="Edit cycle">
              <Button variant="ghost" size="icon" aria-label="Edit cycle" onClick={() => open({ kind: "edit", cycle })}>
                <PencilSimpleIcon />
              </Button>
            </Hint>
          )}
          {(status === "active" || status === "ended") && (
            <Button variant={status === "ended" ? "default" : "outline"} onClick={() => open({ kind: "complete", cycle })}>
              <FlagCheckeredIcon /> <span className={HEAD_FIT.done}>Complete</span>
            </Button>
          )}
          {!done && (
            <AddIssueButton onClick={() => createIssue.show({ cycleId: cycle.id }, project.id)} />
          )}
        </CycleHeaderTools>
      </ProjectHeader>
      {done && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-panel px-5 py-2.5 text-label max-md:px-4">
          <LockSimpleIcon className="size-4 text-ink-3" />
          <span>
            <b>
              {cycle.name} ended on {formatDate(cycle.endDate!)}.
            </b>{" "}
            It’s read-only: issues can’t be added, and its numbers are final.
          </span>
          <span className="font-mono text-meta text-ink-2">
            {counts.completed} of {counts.total - counts.cancelled} done · {percentDone(counts)}% · {moved(cycle.summary?.open ?? [], cycle.id)} moved on
          </span>
        </div>
      )}
      {status === "ended" && (
        <div className="flex flex-wrap items-center gap-3 border-b bg-panel px-5 py-2.5 text-label max-md:px-4">
          <FlagCheckeredIcon className="size-4 text-signal-text" />
          <span className="flex-1">{endedNote(project, cycle, store.cyclesOf(project.id))}</span>
        </div>
      )}
      {waiting.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b bg-panel px-5 py-2 text-label max-md:px-4">
          <span className="font-semibold">Waiting on you</span>
          <span className="font-mono text-meta text-signal-text">{waiting.length} to review</span>
          {waiting.map((i) => (
            <Link key={i.id} href={listIssuePath(ws, i)} className="flex h-[26px] max-w-[300px] items-center gap-1.5 rounded-full border bg-ground px-2.5 outline-none hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring max-md:h-9">
              <IssueLine issue={i} />
            </Link>
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {store.status !== "ready" ? (
            <p className="p-6 text-ink-3">Loading…</p>
          ) : view.layout === "board" ? (
            <Suspense fallback={<div className="flex-1" />}>
              <Board key={cycle.id} project={project} ws={ws} list={view} />
            </Suspense>
          ) : (
            <IssueList key={cycle.id} view={view} project={project} ws={ws} />
          )}
        </div>
        {panel && (
          <aside aria-label="Cycle details" className="w-[340px] shrink-0 overflow-y-auto border-l bg-panel max-lg:hidden">
            <CycleDetails cycle={cycle} />
          </aside>
        )}
      </div>
      {sheet && (
        <Dialog open onOpenChange={setSheet}>
          <DialogContent showCloseButton={false} aria-describedby={undefined}>
            <DialogTitle className="sr-only">{cycle.name}</DialogTitle>
            <CycleDetails cycle={cycle} />
          </DialogContent>
        </Dialog>
      )}
      {dialog}
    </div>
  );
});

/** Progress, burn-up, assignees and facts of a cycle: beside its list, or in a sheet on a phone. */
const CycleDetails = observer(function CycleDetails({ cycle }: { cycle: Cycle }) {
  const status = statusOf(cycle);
  const done = status === "completed";
  const issues = store.issuesInCycle(cycle.id);
  return (
    <>
      <Panel title={done ? "Final" : "Progress"} note={status === "active" ? (cycleWhen(cycle).split(" · ")[0] ?? "") : done ? "final" : ""}>
        <ProgressBlock counts={cycleCounts(cycle)} frozen={done} />
      </Panel>
      <BurnUpPanel cycleId={cycle.id} />
      <Panel title="Assignees" note="done / issues">
        <AssigneeRows issues={issues} counts={(list) => countIssues(list, store.states, (p) => store.statesOf(p))} />
      </Panel>
      <Panel title="Details">
        <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-y-2 text-label">
          <dt className="text-ink-3">Dates</dt>
          <dd className="m-0 font-mono text-meta">{cycleRange(cycle)}</dd>
          {cycle.startDate && (
            <>
              <dt className="text-ink-3">Length</dt>
              <dd className="m-0 font-mono text-meta">{lengthText(cycleDays(cycle))}</dd>
            </>
          )}
          <dt className="text-ink-3">Short</dt>
          <dd className="m-0 font-mono text-meta">{cycleShort(cycle)}</dd>
          <dt className="text-ink-3">Lead</dt>
          <dd className="m-0">{cycle.leadId ? <Lead id={cycle.leadId} /> : <span className="text-ink-3">No lead</span>}</dd>
          {cycle.description && (
            <>
              <dt className="text-ink-3">Description</dt>
              <dd className="m-0 whitespace-pre-line text-ink-2">{cycle.description}</dd>
            </>
          )}
        </dl>
      </Panel>
    </>
  );
});

const moved = (open: readonly string[], cycleId: string) => open.filter((id) => store.issues.get(id)?.cycleId !== cycleId).length;

function Lead({ id }: { id: string }) {
  const u = store.users.get(id);
  return (
    <span className="flex items-center gap-1.5">
      <UserAvatar {...face(u)} className="size-4" />
      {u?.name ?? "Unknown"}
    </span>
  );
}

function Panel({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-b px-5 py-4 max-md:last:border-b-0">
      <p className="mb-3 flex items-center text-label font-semibold">
        {title}
        {note && <span className="ml-auto font-mono text-meta font-normal text-ink-3">{note}</span>}
      </p>
      {children}
    </section>
  );
}

/** Its own observer: the burn-up's today point moves with every delta, the rest of the panel does not. */
const BurnUpPanel = observer(function BurnUpPanel({ cycleId }: { cycleId: string }) {
  const c = store.cycles.get(cycleId);
  if (!c) return null;
  const series = burnSeries(c, cycleProgress(c), cycleCounts(c));
  if (!series) return null;
  return (
    <Panel title="Burn-up" note="issues">
      <BurnUp series={series} height={112} />
    </Panel>
  );
});
