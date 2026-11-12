// What each widget of a project's home shows (RSVA-512, RSVA-513), after the FramedHome artboard: a list, a count or a
// chart of a query's issues, the cycle in progress, what waits on the viewer and the latest
// activity. Everything but the burn-up's past days and the activity is read from the pool, with no request.
import { ArrowRightIcon } from "@phosphor-icons/react";
import type { HomeWidget } from "@rsva/protocol/home";
import { compactAge } from "@rsva/display/time";
import { localToday, sortedStates } from "@rsva/query";
import { cycleStatus, isLiveIssue, PRIORITIES, startedStage, type Issue, type Project } from "@rsva/schema/models";
import { PriorityIcon } from "@rsva/ui/components/priority-icon";
import { StateIcon } from "@rsva/ui/components/state-icon";
import { Button } from "@rsva/ui/components/button";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, type ReactNode } from "react";
import { plural } from "@rsva/schema/util";
import { openPulls, pullLabel, watchPulls } from "../lib/github.ts";
import { openAsList, runWidget } from "../lib/home.ts";
import { ASK_LABELS, asksViewer, collect, dueText, toTriage, type WorkItem } from "../lib/my-work.ts";
import { burnSeries, cycleProgress, cycleRange, daysLeft, paceEnd } from "../lib/cycles.ts";
import { foldHistory, stepsOf, type Row } from "../lib/project-history.ts";
import { useNow } from "../lib/time.ts";
import { Link } from "../link.tsx";
import { paths } from "../router.ts";
import { store } from "../store.ts";
import { BurnUp, GROUPS, ProgressBar } from "./cycle-parts.tsx";
import { cycleCounts } from "./cycles-page.tsx";
import { Face } from "./face.tsx";
import { PullVerdicts } from "./github-panel.tsx";
import { reviewFrom } from "./review-queue.ts";
import { StateGlyph } from "./state-glyph.tsx";
import { isAgent, stateKind } from "./timeline-feed.tsx";

export const shown = <T,>(list: readonly T[], rows: number): T[] => (rows ? list.slice(0, rows) : [...list]);
export const Empty = ({ children }: { children: ReactNode }) => <p className="px-2 py-[18px] text-[12.5px] text-ink-3">{children}</p>;
export const More = ({ n, children }: { n: number; children?: ReactNode }) =>
  n > 0 ? <p className="px-2 pt-1.5 font-mono text-[11.5px] text-ink-3">{children ?? `${n} more`}</p> : null;
export const meta = "font-mono text-[11.5px] leading-none text-ink-3";
export const rowHover = "rounded-md outline-none hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring";
/** A row J and K step to (project-home.tsx) carries `data-home-row` with its issue's id and is lit while selected. */
export const selectable = "data-selected:bg-row-selected";

/**
 * An issue as a row of a widget: its state, key and title, then what the widget adds (`children`, with their columns in
 * `className`). It opens the issue; J and K step to it.
 */
export const IssueRow = observer(function IssueRow({ ws, issue, className, children }: { ws: string; issue: Issue; className: string; children?: ReactNode }) {
  const state = store.states.get(issue.stateId);
  return (
    <Link href={paths.browse(ws, store.issueKey(issue))} data-home-row={issue.id} className={cn("grid min-h-[30px] items-center gap-2 px-2 text-[13px]", rowHover, selectable, className)}>
      <span className="flex">{state && <StateGlyph state={state} />}</span>
      <span className={meta}>{store.issueKey(issue)}</span>
      <span className="truncate">{issue.title}</span>
      {children}
    </Link>
  );
});

/** "N more", which opens them all as the project's list. */
export const MoreAsList = ({ n, open }: { n: number; open: () => void }) => (
  <More n={n}>
    <button type="button" onClick={open} className="underline decoration-rule-strong underline-offset-2 outline-none hover:text-ink focus-visible:text-ink">
      {n} more · open as a list
    </button>
  </More>
);

// ── From a query ───────────────────────────────────────────────────────────────────────────────────────────

/** Why a query finds nothing it could: its first mistake, as the query line says it. */
const QueryProblem = ({ message }: { message: string }) => <Empty>The query has a mistake: {message}.</Empty>;

/** The count a query widget puts beside its title. */
function queryCount(project: Project, w: HomeWidget): number | null {
  const { rows, errors } = runWidget(project.id, w.query);
  return errors.length ? null : rows.length;
}

export const ListBody = observer(function ListBody({ ws, project, w, more }: { ws: string; project: Project; w: HomeWidget; more: () => void }) {
  const { rows, errors } = runWidget(project.id, w.query);
  if (errors.length) return <QueryProblem message={errors[0]!.message} />;
  if (!rows.length) return <Empty>No issues match this query.</Empty>;
  const list = shown(rows, w.rows);
  const today = localToday();
  return (
    <>
      {list.map((i) => {
        const due = dueText(i.dueDate, today);
        return (
          <IssueRow key={i.id} ws={ws} issue={i} className="grid-cols-[16px_max-content_minmax(0,1fr)_auto]">
            <span className={cn("flex items-center gap-2", meta, due?.soon && "text-signal-text", due?.over && "text-error")}>
              {i.priority > 0 && <PriorityIcon priority={i.priority} className="size-3.5" />}
              {due?.text.replace(/^Due /, "")}
            </span>
          </IssueRow>
        );
      })}
      <MoreAsList n={rows.length - list.length} open={more} />
    </>
  );
});

/** The number, a button that shows its issues as the project's list. */
export const CountBody = observer(function CountBody({ project, w, open }: { project: Project; w: HomeWidget; open: () => void }) {
  const { rows, errors } = runWidget(project.id, w.query);
  if (errors.length) return <QueryProblem message={errors[0]!.message} />;
  return (
    <button type="button" onClick={open} title="Open as a list" className={cn("px-2 pt-0.5 pb-1 text-left", rowHover)}>
      <b className="block text-[30px] leading-none font-semibold tracking-[-0.04em] tabular-nums">{rows.length}</b>
      <span className="block pt-1.5 text-[12px] text-ink-3">{rows.length === 1 ? "1 issue" : `${rows.length} issues`}</span>
    </button>
  );
});

interface Bar {
  key: string;
  label: ReactNode;
  name: string;
  n: number;
  color: string;
}

const STAGE_COLOR = { progress: "bg-status-progress", review: "bg-status-review", approved: "bg-status-approved" } as const;
const GROUP_COLOR: Record<string, string> = {
  backlog: "bg-status-backlog",
  unstarted: "bg-status-todo",
  completed: "bg-status-done",
  cancelled: "bg-status-canceled",
};

/** The bars of a chart: the project's states in workflow order, the priorities, or the five busiest assignees. */
function barsOf(project: Project, rows: readonly Issue[], by: HomeWidget["by"]): Bar[] {
  const count = (key: (i: Issue) => string[]) => {
    const n = new Map<string, number>();
    for (const i of rows) for (const k of key(i)) n.set(k, (n.get(k) ?? 0) + 1);
    return n;
  };
  if (by === "state") {
    const n = count((i) => [i.stateId]);
    const states = store.statesOf(project.id);
    return sortedStates(states)
      .filter((s) => s.group !== "cancelled" || n.get(s.id))
      .map((s) => {
        const stage = s.group === "started" ? (startedStage(states, s.id) ?? "progress") : null;
        return { key: s.id, label: <StateGlyph state={s} />, name: s.name, n: n.get(s.id) ?? 0, color: stage ? STAGE_COLOR[stage] : (GROUP_COLOR[s.group] ?? "bg-ink-3") };
      });
  }
  if (by === "priority") {
    const n = count((i) => [String(i.priority)]);
    return PRIORITIES.map((p) => ({ key: String(p.code), label: <PriorityIcon priority={p.code} className="size-3.5" />, name: p.name, n: n.get(String(p.code)) ?? 0, color: p.code === 1 ? "bg-signal" : "bg-ink-3" }));
  }
  const n = count((i) => (i.assigneeIds.length ? i.assigneeIds : ["none"]));
  return [...n]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id, k]) => ({ key: id, label: id === "none" ? <span className="size-[18px]" /> : <Face id={id} />, name: id === "none" ? "No one" : (store.users.get(id)?.name ?? "?"), n: k, color: "bg-ink-3" }));
}

export const ChartBody = observer(function ChartBody({ project, w }: { project: Project; w: HomeWidget }) {
  const { rows, errors } = runWidget(project.id, w.query);
  if (errors.length) return <QueryProblem message={errors[0]!.message} />;
  const bars = barsOf(project, rows, w.by);
  if (!bars.length) return <Empty>No issues match this query.</Empty>;
  const max = Math.max(1, ...bars.map((b) => b.n));
  const cols = { gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` };
  return (
    <div role="img" aria-label={bars.map((b) => `${b.name} ${b.n}`).join(", ")}>
      <div className="grid h-[120px] items-end gap-2.5 px-2.5 pt-2" style={cols}>
        {bars.map((b) => (
          <div key={b.key} className="flex h-full flex-col items-center justify-end gap-1.5" title={`${b.name}: ${b.n}`}>
            <b className="font-mono text-[11px] leading-none font-medium text-ink-2 tabular-nums">{b.n}</b>
            <i className={cn("block w-full max-w-11 rounded-t-[4px] rounded-b-[2px]", b.color)} style={{ height: b.n ? `${Math.max(4, (b.n / max) * 88)}px` : "2px", opacity: b.n ? 1 : 0.35 }} />
          </div>
        ))}
      </div>
      <div className="grid gap-2.5 px-2.5 pt-1.5" style={cols}>
        {bars.map((b) => (
          <span key={b.key} className="flex min-w-0 flex-col items-center gap-1 text-center font-mono text-[10.5px] leading-[1.3] text-ink-3">
            {b.label}
            <span className="w-full truncate">{b.name}</span>
          </span>
        ))}
      </div>
    </div>
  );
});

// ── The project ────────────────────────────────────────────────────────────────────────────────────────────

/** The cycle in progress, or one past its end and not completed yet. */
const currentCycle = (project: Project) => {
  const day = localToday();
  return store.cyclesOf(project.id).find((c) => {
    const s = cycleStatus(c, day);
    return s === "active" || s === "ended";
  });
};

export const CycleBody = observer(function CycleBody({ ws, project }: { ws: string; project: Project }) {
  const c = currentCycle(project);
  if (!c)
    return (
      <Empty>
        No cycle in progress.{" "}
        <Link href={paths.cycles(ws, project.key)} className="text-ink-2 underline decoration-rule-strong underline-offset-2">
          Cycles
        </Link>
      </Empty>
    );
  const counts = cycleCounts(c);
  const series = burnSeries(c, cycleProgress(c), counts);
  const ended = cycleStatus(c, localToday()) === "ended";
  const pace = series && paceEnd(series);
  // What nobody has started, the soonest due first (RSVA-570): with the days left, the part of the cycle at risk.
  const idle = store
    .issuesInCycle(c.id)
    .filter((i) => isLiveIssue(i) && ["backlog", "unstarted"].includes(store.states.get(i.stateId)?.group ?? ""))
    .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || (a.priority || 5) - (b.priority || 5));
  return (
    <div className="px-2">
      <Link href={paths.cycle(ws, project.key, c.number)} className={cn("-mx-1 flex justify-between px-1 py-0.5", meta, rowHover)}>
        <span>
          {c.name} · {cycleRange(c)}
        </span>
        <span className={ended ? "text-signal-text" : undefined}>{ended ? "past its end" : <b className="font-medium text-ink">{daysLeft(c)}</b>}</span>
      </Link>
      {series && series.scope.length > 0 && (
        <div className="my-2.5">
          <BurnUp series={series} height={92} />
        </div>
      )}
      {pace !== null && pace !== undefined && !ended && (
        <p className={cn(meta, "mb-2 leading-[1.4]", pace < counts.total && "text-warning")}>
          At this pace {pace} of {counts.total} by its end
        </p>
      )}
      <ProgressBar counts={counts} className="my-2 h-1.5 rounded-[2px]" />
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px] text-ink-2">
        {/* Every group that has issues, so the rows add up to the scope (RSVA-528). */}
        {GROUPS.filter((l) => counts[l.key] > 0).map((l) => {
          return (
            <span key={l.key} className="flex items-center gap-1.5">
              <StateIcon group={l.group} {...(l.stage ? { stage: l.stage } : {})} />
              {l.name}
              <b className="ml-auto font-mono text-[11.5px] font-medium text-ink tabular-nums">{counts[l.key]}</b>
            </span>
          );
        })}
      </div>
      {idle.length > 0 && !ended && (
        <div className="-mx-2 mt-2.5">
          <p className="px-2 pb-1 text-[11.5px] font-semibold text-ink-2">
            Not started, {daysLeft(c)} <span className="font-mono font-normal text-ink-3">{idle.length}</span>
          </p>
          {idle.slice(0, NOT_STARTED).map((i) => (
            <Link
              key={i.id}
              href={paths.browse(ws, store.issueKey(i))}
              data-home-row={i.id}
              className={cn("grid min-h-[28px] grid-cols-[max-content_minmax(0,1fr)] items-center gap-2 px-2 text-[13px]", rowHover, selectable)}
            >
              <span className={meta}>{store.issueKey(i)}</span>
              <span className="truncate">{i.title}</span>
            </Link>
          ))}
          <More n={idle.length - NOT_STARTED} />
        </div>
      )}
    </div>
  );
});

/** How many of the cycle's issues nobody has started the widget names. */
const NOT_STARTED = 3;

/**
 * What waits on the viewer in this project, by the one rule (asksViewer): reviews, replies and mentions, the longest
 * waiting first; and how many proposals wait to be triaged beside them.
 */
function waiting(project: Project, ws: string): { asks: WorkItem[]; triage: number } {
  const here = collect(ws, store, Date.now(), { others: true }).filter((x) => x.issue.projectId === project.id);
  return { asks: here.filter(asksViewer).sort((a, b) => (a.since < b.since ? -1 : 1)), triage: here.filter(toTriage).length };
}

/** The proposals of a project, as the project's list shows them. */
const PROPOSALS = "label:proposed group:backlog";

/**
 * What waits, as rows that open the issue: a title is not enough to approve by (RSVA-597), so the decision is the issue's
 * review bar. A review says what was handed in, its pull request and checks, from the project's open pull requests
 * (one request, shared with the Pull requests widget); a review opens in the queue of the project's reviews.
 */
export const WaitBody = observer(function WaitBody({ ws, project, w }: { ws: string; project: Project; w: HomeWidget }) {
  const now = useNow();
  useEffect(() => watchPulls(project.id), [project.id]);
  const { asks: items, triage } = waiting(project, ws);
  const reviews = items.filter((x) => x.ask === "review");
  const from = reviewFrom(project.id);
  // A pile to sort, not a question: one line that opens the proposals as the project's list.
  const pile = triage > 0 && (
    <button type="button" onClick={() => openAsList(ws, project, PROPOSALS)} className={cn("mt-1 flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12.5px] text-ink-2", rowHover)}>
      {plural(triage, "proposal")} to triage
      <span className={cn(meta, "ml-auto")}>open as a list</span>
    </button>
  );
  if (!items.length)
    return (
      <>
        <Empty>Nothing waits on you here. Reviews, replies and mentions come here.</Empty>
        {pile}
      </>
    );
  const list = shown(items, w.rows);
  const pulls = openPulls(project.id);
  return (
    <>
      {list.map((x) => {
        const review = x.ask === "review";
        const pull = review ? pulls?.find((p) => p.issueId === x.issue.id) : undefined;
        return (
          <Link
            key={x.issue.id}
            href={paths.browse(ws, store.issueKey(x.issue))}
            from={review ? from : null}
            data-home-row={x.issue.id}
            className={cn("grid grid-cols-[18px_minmax(0,1fr)] gap-2.5 p-2 text-[13px] leading-[1.45]", rowHover, selectable)}
          >
            <Face id={x.from} />
            <span className="min-w-0">
              <span className={cn(meta, "mr-1.5")}>{store.issueKey(x.issue)}</span>
              {x.issue.title}
              <span className={cn(meta, "mt-1 flex flex-wrap items-center gap-x-2 gap-y-1")}>
                {ASK_LABELS[x.ask!]} · {compactAge(now - Date.parse(x.since))}
                {pull && (
                  <span className="inline-flex items-center gap-1.5 font-sans">
                    <span className="font-mono">{pullLabel(pull, pulls ?? [])}</span>
                    <PullVerdicts pull={pull} />
                  </span>
                )}
              </span>
            </span>
          </Link>
        );
      })}
      <More n={items.length - list.length} />
      {reviews.length > 0 && (
        <Button size="sm" variant="outline" className="mx-2 mt-2" render={<Link href={paths.browse(ws, store.issueKey(reviews[0]!.issue))} from={from} />} nativeButton={false}>
          Review {reviews.length === 1 ? "it" : `all ${reviews.length}`}
          <ArrowRightIcon />
        </Button>
      )}
      {pile}
    </>
  );
});

/** A row of the history as one line: who, what happened to which issue. */
function activityLine(r: Row): { by: string | null; at: string; issueId: string | null; what: string } {
  if (r.kind === "setting") return { by: r.entry.by, at: r.entry.at, issueId: null, what: "changed the project's settings" };
  if (r.kind === "story") {
    const last = r.chain.at(-1);
    const state = last?.kind === "state" ? store.states.get(last.stateId)?.name : null;
    const merged = r.pulls.find((p) => p.merged);
    const what = merged ? `merged #${merged.number}` : state ? (r.chain.length === 1 && r.chain[0]!.kind === "created" ? "created" : `moved to ${state}`) : "created";
    return { by: r.by[0] ?? null, at: r.to, issueId: r.issueId, what };
  }
  const s = r.step;
  const what = s.kind === "created" ? "created" : s.kind === "comment" ? "commented on" : "changed";
  return { by: s.by, at: s.at, issueId: s.issueId, what };
}

export const ActivityBody = observer(function ActivityBody({ ws, project, w }: { ws: string; project: Project; w: HomeWidget }) {
  const now = useNow();
  const feed = store.projectHistory(project.id, "outcomes");
  if (feed.status === "loading") return <Empty>Loading…</Empty>;
  if (feed.status === "error") return <Empty>The activity could not be loaded.</Empty>;
  const issues = [...store.issuesOf(project.id), ...store.issuesOf(project.id, "archived")];
  const days = foldHistory(stepsOf(issues, feed.entries, feed.comments, feed.older), { level: "outcomes", who: "all", isAgent, stateKind }, feed.settings);
  const rows = days.flatMap((d) => d.rows);
  if (!rows.length) return <Empty>Nothing has happened in this project yet.</Empty>;
  const list = shown(rows, w.rows);
  return (
    <>
      {list.map((r) => {
        const l = activityLine(r);
        const issue = l.issueId ? store.issues.get(l.issueId) : undefined;
        const who = l.by ? (l.by === store.me?.id ? "You" : (store.users.get(l.by)?.name ?? "Someone")) : "Someone";
        return (
          <div
            key={r.key}
            {...(issue ? { "data-home-row": issue.id } : {})}
            className={cn("grid min-h-[30px] grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 text-[12.5px] text-ink-2", issue && selectable)}
          >
            <Face id={l.by} />
            <span className="truncate">
              <b className="font-semibold text-ink">{who}</b> {l.what}{" "}
              {issue && (
                <Link href={paths.browse(ws, store.issueKey(issue))} className="text-ink outline-none hover:underline focus-visible:underline">
                  <span className={meta}>{store.issueKey(issue)}</span> {issue.title}
                </Link>
              )}
            </span>
            <span className="font-mono text-[11px] text-ink-3">{compactAge(now - Date.parse(l.at))}</span>
          </div>
        );
      })}
      <More n={rows.length - list.length} />
    </>
  );
});

/** The count beside a widget's title, for the kinds that have one. */
export function widgetCount(ws: string, project: Project, w: HomeWidget): { n: string; signal: boolean } | null {
  if (w.kind === "list" || w.kind === "chart") {
    const n = queryCount(project, w);
    return n === null ? null : { n: String(n), signal: false };
  }
  if (w.kind === "wait") {
    const n = waiting(project, ws).asks.length;
    return { n: String(n), signal: n > 0 };
  }
  if (w.kind === "pulls") {
    const pulls = openPulls(project.id);
    return pulls ? { n: String(pulls.length), signal: false } : null;
  }
  return null;
}
