// The widgets of a project's home that say where it stands (RSVA-570, the Quire artboards FramedProjectHomeStructure
// and …Cycle, cut to what the pool holds): its figures and its structure by parent issue or by label. The marks are My
// work Home's (pulse-parts.tsx): a colour means the same on both pages. No request, but for the pull requests: their
// links come with an issue's feed, not with the snapshot, so the widget asks for the open ones (lib/github.ts).
import type { HomeWidget } from "@rsva/protocol/home";
import { localToday } from "@rsva/query";
import { plural } from "@rsva/schema/util";
import { pullUrl, startedStage, type Issue, type Project } from "@rsva/schema/models";
import { Segmented } from "@rsva/ui/components/segmented";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import { openPulls, pullRef, watchPulls } from "../lib/github.ts";
import { openAsList, runWidget } from "../lib/home.ts";
import { age, asksViewer, collect, type WorkItem } from "../lib/my-work.ts";
import { blankPulse, pulses } from "../lib/my-work-projects.ts";
import { groupOfRow, hasParents, rowTotal, sortRows, structure, STRUCTURE_GROUPS, type StructureBy, type StructureRow } from "../lib/structure.ts";
import { exactTime, useNow } from "../lib/time.ts";
import { Link } from "../link.tsx";
import { myWorkView } from "../my-work-view.ts";
import { paths, router } from "../router.ts";
import { store } from "../store.ts";
import { PullVerdicts } from "./github-panel.tsx";
import { PullStateIcon } from "./github-parts.tsx";
import { Empty, meta, More, rowHover, selectable, shown } from "./home-widgets.tsx";
import { Figures, LIVE_NAMES, LIVE_TONE, Units, type Live } from "./pulse-parts.tsx";

/** Open: neither done nor cancelled. */
const OPEN = "-group:completed -group:cancelled";
const BLOCKED = `is:blocked ${OPEN}`;

/** The viewer's My work in the project. */
const mine = (ws: string, project: Project, now: number): WorkItem[] => collect(ws, store, now, { others: true }).filter((x) => x.issue.projectId === project.id);

/** The live kinds a project shows, in its columns' order. Overdue is My work's; here a blocked issue is the news. */
const LIVE = ["wait", "doing", "agents", "review", "blocked"] as const satisfies readonly Live[];
type Kind = (typeof LIVE)[number];

// ── Figures ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Where a figure's issues are listed: the project's list with this query. */
const LISTS: Partial<Record<Kind, string>> = { doing: "assignee:me group:started", agents: "agent:any group:started", blocked: BLOCKED };

export const FiguresBody = observer(function FiguresBody({ ws, project }: { ws: string; project: Project }) {
  const now = useNow();
  const source = { projectList: () => [project], issues: { values: () => store.issuesOf(project.id) }, states: store.states, labels: store.labels, statesOf: store.statesOf, cyclesOf: () => [], issuesInCycle: () => [] };
  const p = pulses(ws, source, mine(ws, project, now), localToday(), now)[0] ?? blankPulse(ws, project);
  const n: Record<Kind, number> = { wait: p.wait, doing: p.doing, agents: p.agents, review: p.review, blocked: runWidget(project.id, BLOCKED).rows.length };
  return (
    <div className="px-1 pb-1">
      <Figures
        kinds={LIVE}
        n={n}
        go={(k) => {
          // What waits on the viewer here (reviews of agents' work, proposals) is decided in Triage, narrowed to the project.
          if (k === "wait")
            return () => {
              myWorkView.setScope(`p:${ws}/${project.id}`);
              router.push(paths.triage(ws));
            };
          const query = LISTS[k];
          return query === undefined ? undefined : () => openAsList(ws, project, query);
        }}
        goTip="open as a list"
        parked={p.parked}
      />
    </div>
  );
});

// ── Structure ────────────────────────────────────────────────────────────────────────────────────────────────

/** Name, the live kinds, the bar, done of all, the last change; the narrower the widget, the fewer columns. */
// Columns give way as the widget narrows: the bar and Last, then Blocked, then Agents and Review, then Yours, so a
// quarter of the grid keeps the names readable with what waits on the viewer and done.
const GRID =
  "grid items-center gap-x-2.5 grid-cols-[minmax(0,1fr)_repeat(5,44px)_minmax(70px,120px)_52px_34px] @max-[620px]/st:grid-cols-[minmax(0,1fr)_repeat(5,40px)_52px] @max-[440px]/st:grid-cols-[minmax(0,1fr)_repeat(4,42px)_48px] @max-[440px]/st:gap-x-1.5 @max-[360px]/st:grid-cols-[minmax(0,1fr)_repeat(2,40px)_48px] @max-[240px]/st:grid-cols-[minmax(0,1fr)_28px_44px]";
const WIDE_COL = "@max-[620px]/st:hidden";
const MID_COL = "@max-[440px]/st:hidden";
const NARROW_COL = "@max-[360px]/st:hidden";
const TINY_COL = "@max-[240px]/st:hidden";
/** The class that hides a live column where the widget is too narrow for it. */
const liveCol = (k: Live): string | undefined => (k === "blocked" ? MID_COL : k === "agents" || k === "review" ? NARROW_COL : k === "doing" ? TINY_COL : undefined);

const NAMES: Record<StructureBy, string> = { parent: "Parents", label: "Labels" };
const REST: Record<StructureBy, { name: string; query: string }> = {
  parent: { name: "Without a parent", query: `parent:none ${OPEN}` },
  label: { name: "No label", query: `label:none ${OPEN}` },
};

export const StructureBody = observer(function StructureBody({ ws, project }: { ws: string; project: Project }) {
  const now = useNow();
  const issues = store.issuesOf(project.id);
  const states = store.statesOf(project.id);
  const groupOf = (i: Issue) => store.states.get(i.stateId)?.group;
  // The cut the project's own work suggests, until the viewer picks the other; theirs for this visit, not saved.
  const [picked, setPicked] = useState<StructureBy | null>(null);
  const by = picked ?? (hasParents(issues, { groupOf }) ? "parent" : "label");
  const items = mine(ws, project, now);
  const ids = (group: WorkItem["group"]) => new Set(items.filter((x) => (group === "wait" ? asksViewer(x) : x.group === group)).map((x) => x.issue.id));
  const rows = sortRows(
    structure(by, issues, {
      groupOf,
      stageOf: (i) => startedStage(states, i.stateId),
      wait: ids("wait"),
      doing: ids("doing"),
      agents: ids("agents"),
      blocked: new Set(runWidget(project.id, BLOCKED).rows.map((i) => i.id)),
    }),
    now,
  );
  const scale = Math.max(1, ...rows.map(rowTotal));
  // Under the parents only: the rest row is not under one, and by label an issue with two labels would count twice.
  const parents = rows.filter((r) => r.kind === "parent");
  const under = parents.reduce((n, r) => n + r.open + r.backlog, 0);
  return (
    <div className="@container/st px-1">
      <div className="mb-1 flex items-center gap-2 px-1">
        <span className={cn(meta, "min-w-0 truncate", TINY_COL)}>
          {by === "parent" ? `${under} open under ${plural(parents.length, "parent")}` : plural(rows.filter((r) => r.kind === "label").length, "label")}
        </span>
        <span className="flex-1" />
        <Segmented label="Rows are" variant="quiet" value={by} onChange={setPicked} options={(["parent", "label"] as const).map((v) => ({ value: v, label: NAMES[v] }))} />
      </div>
      {!rows.length && <Empty>No open issues here.</Empty>}
      {rows.length > 0 && (
        <div className={cn(GRID, "h-6 px-1 font-mono text-[10px] font-medium tracking-[.06em] text-ink-3 uppercase")} aria-hidden>
          <span />
          {LIVE.map((k) => (
            <span key={k} title={LIVE_NAMES[k].tip} className={cn(liveCol(k))}>
              {LIVE_NAMES[k].head}
            </span>
          ))}
          <span title="Done, open and backlog, on one scale for all rows" className={WIDE_COL}>
            Progress
          </span>
          <span className="text-right">Done</span>
          <span className={cn("text-right", WIDE_COL)}>Last</span>
        </div>
      )}
      {STRUCTURE_GROUPS.map((g) => {
        const list = rows.filter((r) => groupOfRow(r, now) === g.id);
        if (!list.length) return null;
        return (
          <div key={g.id} className="mt-2 flex flex-col first:mt-0">
            <div className="flex h-5 items-baseline gap-[7px] px-1">
              <span className="text-[11.5px] font-semibold text-ink-2">{g.name}</span>
              <span className="font-mono text-[11px] text-ink-3">{list.length}</span>
            </div>
            {list.map((r) => (
              <StructureLine key={r.id} ws={ws} project={project} by={by} row={r} scale={scale} stalled={g.id === "stalled"} now={now} />
            ))}
          </div>
        );
      })}
      {rows.length > 0 && (
        <p className="mt-2.5 px-1 text-[12px] leading-[1.45] text-ink-3">
          A row is {by === "parent" ? "a parent issue with everything under it" : "a label with its issues"}. Squares are issues live right now; the bar is done, open and backlog on
          one scale, so the rows compare.
        </p>
      )}
    </div>
  );
});

const SEGMENTS = [
  ["done", "bg-status-done"],
  ["open", "bg-ink-3/60"],
  ["backlog", "bg-rule-strong"],
] as const;

function StructureLine({ ws, project, by, row: r, scale, stalled, now }: { ws: string; project: Project; by: StructureBy; row: StructureRow; scale: number; stalled: boolean; now: number }) {
  const issue = r.kind === "parent" ? store.issues.get(r.id) : undefined;
  const label = r.kind === "label" ? store.labels.get(r.id) : undefined;
  const name = issue?.title ?? label?.name ?? REST[by].name;
  const total = rowTotal(r);
  const cells = (
    <>
      <span className="flex min-w-0 items-baseline gap-2">
        {issue && <span className={cn(meta, "shrink-0 whitespace-nowrap max-md:hidden")}>{store.issueKey(issue)}</span>}
        <span className="min-w-0 truncate font-medium">{name}</span>
      </span>
      {LIVE.map((k) => (
        <span key={k} className={cn("flex items-center gap-0.5 overflow-hidden", liveCol(k))}>
          {r[k] ? <Units n={r[k]} max={4} tone={LIVE_TONE[k]} /> : <span className="text-faint">·</span>}
        </span>
      ))}
      <span className={cn("flex h-2 items-center gap-px overflow-hidden", WIDE_COL)} style={{ width: `${(total / scale) * 100}%` }}>
        {SEGMENTS.map(([k, tone]) => (r[k] ? <i key={k} className={cn("block h-2 min-w-0.5 rounded-[1.5px]", tone)} style={{ width: `${(r[k] / total) * 100}%` }} /> : null))}
      </span>
      <span className="text-right font-mono text-[11.5px] text-ink-3 tabular-nums">
        <b className="font-medium text-ink">{r.done}</b>/{total}
      </span>
      <span title={r.changed ? exactTime(r.changed) : undefined} className={cn("text-right font-mono text-[11.5px]", stalled ? "font-semibold text-warning" : "text-ink-3", WIDE_COL)}>
        {r.changed ? age(now - Date.parse(r.changed)) : "–"}
      </span>
    </>
  );
  const cls = cn(GRID, "min-h-[27px] w-full px-1 text-left text-[13px] max-md:min-h-11", rowHover, selectable);
  const said = `${name}: ${LIVE.map((k) => `${r[k]} ${LIVE_NAMES[k].figure}`).join(", ")}, ${r.done} of ${total} done`;
  // A parent opens as its issue, with its sub-issues; a label or the rest, as the project's list of them.
  if (issue)
    return (
      <Link href={paths.browse(ws, store.issueKey(issue))} data-home-row={issue.id} aria-label={said} className={cls}>
        {cells}
      </Link>
    );
  const query = label ? `label:"${label.name.replaceAll('"', "")}" ${OPEN}` : REST[by].query;
  return (
    <button type="button" aria-label={said} onClick={() => openAsList(ws, project, query)} className={cls}>
      {cells}
    </button>
  );
}

// ── Pull requests ────────────────────────────────────────────────────────────────────────────────────────────

/** The project's open pull requests (lib/github.ts): what is being reviewed and what its checks say. A row opens it on GitHub. */
export const PullsBody = observer(function PullsBody({ project, w }: { project: Project; w: HomeWidget }) {
  useEffect(() => watchPulls(project.id), [project.id]);
  const pulls = openPulls(project.id);
  if (!pulls) return <Empty>Loading…</Empty>;
  if (!pulls.length) return <Empty>No open pull requests. One linked to an issue of this project shows here.</Empty>;
  const list = shown(pulls, w.rows);
  // A number is a repository's own: its name is said only when the list holds pull requests of more than one.
  const oneRepo = new Set(pulls.map((p) => p.repo)).size === 1;
  return (
    <>
      {list.map((p) => {
        const issue = store.issues.get(p.issueId);
        return (
          <a
            key={pullRef(p)}
            href={pullUrl(p)}
            target="_blank"
            rel="noopener"
            title="Opens on GitHub"
            className={cn("grid min-h-[30px] grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 px-2 text-[13px]", rowHover)}
          >
            <PullStateIcon state={p.state} className="size-[15px]" />
            <span className="truncate">
              <span className={cn(meta, "mr-1.5")}>{oneRepo ? `#${p.number}` : pullRef(p)}</span>
              {p.title}
              {issue && <span className={cn(meta, "ml-1.5")}>{store.issueKey(issue)}</span>}
            </span>
            <span className="flex items-center gap-2.5 text-[11.5px] text-ink-2">
              <PullVerdicts pull={p} />
            </span>
          </a>
        );
      })}
      <More n={pulls.length - list.length} />
    </>
  );
});

