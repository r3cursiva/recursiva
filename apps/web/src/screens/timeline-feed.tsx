// The Timeline's chronology (PLNR-71, PLNR-120, PLNR-275): days of rows on a rail: the time, a node (square for an agent,
// ring for a person), the row. A row is one line in columns that a day's rows share (a CSS subgrid), so the eye goes down
// them: what the issue came to, its key and title, the states it passed, how long it took, its pull requests, who did it.
// An issue's day is one row that opens into its steps, and a step reads in the same columns. Nothing wraps on a wide
// screen; on a phone the issue is the first line and the rest a second one.
import { ArchiveIcon, CaretRightIcon, ChatCircleIcon, GitCommitIcon, GitMergeIcon, GitPullRequestIcon, PlusCircleIcon } from "@phosphor-icons/react";
import { startedStage, type Issue, type Project } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { StateIcon } from "@rsva/ui/components/state-icon";
import { AgentAvatar, UserAvatarStack } from "@rsva/ui/components/user-avatar";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { Fragment, useState, type ReactNode } from "react";
import { face } from "../lib/face.ts";
import { githubWords } from "@rsva/display/github";
import { dayTotals, oneLine, pullsOf, span, type ChainLink, type Day, type Pull, type Row, type Step, type StateKind, type Tally, type Total } from "../lib/project-history.ts";
import { exactTime } from "../lib/time.ts";
import { paths } from "../router.ts";
import { store } from "../store.ts";
import { BotMark } from "./actor.tsx";
import { CommitChip } from "./github-parts.tsx";
import { historyLines } from "@rsva/display/history";
import { clockTime } from "@rsva/display/time";
import { createdWith, drawLine, fieldLine, settingLines, userName } from "./issue-history.tsx";
import { StateGlyph } from "./state-glyph.tsx";
import { Link } from "../link.tsx";

/** The markers the artboards use for the two sides: a filled square for agents, a ring for people. */
export const AgentMark = ({ className }: { className?: string }) => <span aria-hidden className={cn("size-2 shrink-0 rounded-[2px] bg-current", className)} />;
export const PersonMark = ({ className }: { className?: string }) => <span aria-hidden className={cn("size-2 shrink-0 rounded-full border-[1.5px] border-current", className)} />;

const weekday = new Intl.DateTimeFormat("en", { weekday: "long" });
const dateShort = new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric" });
const dateYear = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

/** "Today", "Yesterday", the weekday within the week, a planned day's weekday, else the date alone. */
function dayTitle(key: string, now: Date): { name: string; date: string; today: boolean; planned: boolean } {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const day = new Date(y, m - 1, d);
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - day.getTime()) / 86_400_000);
  const date = y === now.getFullYear() ? dateShort.format(day) : dateYear.format(day);
  if (days < 0) return { name: `${weekday.format(day)}, planned`, date, today: false, planned: true };
  const name = days === 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? weekday.format(day) : date;
  return { name, date: name === date ? "" : date, today: days === 0, planned: false };
}

export function stateKind(stateId: string): StateKind {
  const s = store.states.get(stateId);
  if (!s) return "other";
  if (s.group === "completed") return "done";
  if (s.group === "cancelled") return "canceled";
  const stage = s.group === "started" ? startedStage(store.statesOf(s.projectId), s.id) : undefined;
  return stage === "review" || stage === "approved" ? stage : "other";
}

export const isAgent = (id: string | null) => !!id && store.users.get(id)?.kind === "agent";

/** The issue waits on the viewer: it is in review and they created it, so the review is theirs (as the inbox asks). */
function waitsForMe(issueId: string): boolean {
  const i = store.issues.get(issueId);
  return !!i && !!store.me && i.createdById === store.me.id && stateKind(i.stateId) === "review";
}

/** A day's header, sticky over its rows: its name and date, and what the page says about it. */
export function DayHeader({ dayKey, now, children }: { dayKey: string; now: Date; children: ReactNode }) {
  const { name, date, today, planned } = dayTitle(dayKey, now);
  return (
    <header className="sticky top-0 z-[2] flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b bg-ground pt-3.5 pb-2.5">
      <span className="inline-flex items-baseline gap-2.5">
        <h2 className={cn("text-[15px] font-semibold", today && "text-signal-text", planned && "text-ink-3")}>{name}</h2>
        {date && <span className="font-mono text-[11px] text-ink-3">{date}</span>}
      </span>
      {children}
    </header>
  );
}

/** The rail: a line down the node column (56 px of time, the middle of 28 px of nodes). */
export const RAIL = "relative pt-1.5 pb-[18px] before:absolute before:top-0 before:bottom-0 before:left-[69px] before:w-px before:bg-rule";

export type Node = "agent" | "human" | "start" | "end" | "planned" | null;

const NODE: Record<NonNullable<Node>, string> = {
  agent: "size-[9px] rounded-[2px] border-ink-2 bg-ink-2",
  human: "size-2.5 rounded-full border-ink-2 bg-ground",
  start: "size-3 rounded-full border-2 border-ink bg-panel",
  end: "size-3 rounded-[2px] border-2 border-ink bg-ink",
  planned: "size-3 rounded-[2px] border-dashed border-ink-3 bg-ground",
};

/**
 * A line of the Milestones level: the time, its node on the rail, the body. `sub`: what an opened line says, smaller.
 * `row`: J and K stop here, and the row's link and toggle answer Enter and the arrows.
 */
export function Line({ time, node, sub = false, tall = false, row, children }: { time: ReactNode; node: Node; sub?: boolean; tall?: boolean; row?: string; children: ReactNode }) {
  return (
    <li data-timeline-row={row} className={cn("group relative grid scroll-mt-14 animate-in grid-cols-[56px_28px_minmax(0,1fr)] items-start duration-300 fade-in slide-in-from-bottom-1", sub ? "min-h-7" : "min-h-8")}>
      <span className={cn("pr-1.5 text-right font-mono text-[11px] text-ink-3 tabular-nums", tall ? "pt-[9px]" : "pt-2")}>{time}</span>
      <span className={cn("relative grid place-items-center", sub ? "h-7" : tall ? "h-9" : "h-8")}>
        {node && <i className={cn("box-border block border-[1.5px]", sub ? "size-1.5 rounded-[1px] border-ink-2 bg-ground" : NODE[node])} />}
      </span>
      <div className={cn("min-w-0 rounded-[5px] pr-2 pl-1 text-ink-2 group-data-[selected]:bg-row-selected", tall ? "py-[7px]" : "py-[5px]", sub ? "pl-6 text-[12.5px]" : "text-[13px]")}>
        <div className={cn("flex min-w-0 flex-wrap items-center gap-y-1", tall ? "gap-x-2.5" : "gap-x-2")}>{children}</div>
      </div>
    </li>
  );
}

/** A row's clock time. An issue's row says when it last moved, what its day is sorted by; the range is in the tooltip. */
function Time({ at, from }: { at: string; from?: string }) {
  return (
    <time dateTime={at} title={from ? `${exactTime(from)} – ${exactTime(at)}` : exactTime(at)}>
      {clockTime(at)}
    </time>
  );
}

/** The caret of a row that opens; Enter and the arrows find it by `data-timeline-toggle`. */
export function Toggle({ expanded, label, onToggle }: { expanded: boolean; label: string; onToggle: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      data-timeline-toggle
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
      onClick={onToggle}
      className="relative max-md:before:absolute max-md:before:-inset-2.5 size-[22px] rounded-[4px] border-0 text-ink-3 transition-transform duration-200 aria-expanded:not-hover:bg-transparent aria-expanded:not-hover:text-ink-3 max-md:size-[22px] max-md:rounded-[4px]"
      style={{ transform: expanded ? "rotate(90deg)" : undefined }}
    >
      <CaretRightIcon className="size-3" />
    </Button>
  );
}

/** Where an issue opens beside the list, and its key; null for a removed one. */
function issueLink(id: string, ws: string, project: Project): { issue: Issue; key: string; href: string } | null {
  const issue = store.issues.get(id);
  if (!issue) return null;
  const key = store.issueKey(issue);
  return { issue, key, href: paths.listIssue(ws, project.key, key) };
}

/** The issue's key and title in their own columns, so the titles of a day start at one place. */
const IssueCells = observer(function IssueCells({ id, ws, project }: { id: string; ws: string; project: Project }) {
  const l = issueLink(id, ws, project);
  if (!l) return <span className="text-ink-3 md:col-[3/5]">a removed issue</span>;
  return (
    <>
      <Link href={l.href} tabIndex={-1} className="shrink-0 font-mono text-[11.5px] text-ink-3 no-underline hover:text-ink-2 md:col-start-3">
        {l.key}
      </Link>
      <Link href={l.href} className="link-plate min-w-0 truncate text-ink no-underline max-md:shrink max-md:grow max-md:basis-0 md:col-start-4">
        {l.issue.title}
      </Link>
    </>
  );
});

/** What a row says, column by column. */
interface Cells {
  /** What the row came to: the state the issue ended the day in, or what the step did. */
  icon: ReactNode;
  label: string;
  /** The outcome is the issue's state now: the day did not move it. */
  now?: boolean;
  issueId?: string;
  /** A change of the project's own says what it was where an issue has its key and title. */
  text?: ReactNode;
  /** How it got there: the states it passed, a comment's words, the change in full. */
  path?: ReactNode;
  span?: string;
  pulls?: readonly Pull[];
  by: readonly string[];
}

/** The columns a day's rows share: time, node, caret, outcome, key, title, path, span, pull requests, who. */
const COLUMNS = "md:grid md:grid-cols-[56px_28px_26px_max-content_max-content_minmax(0,1fr)_fit-content(22%)_max-content_max-content_max-content]";

/** The pull requests of a row: the last one, merged in violet, and how many more; all of them in the tooltip. */
function Pulls({ pulls }: { pulls: readonly Pull[] }) {
  const last = pulls.at(-1);
  if (!last) return null;
  const Icon = last.merged ? GitMergeIcon : GitPullRequestIcon;
  return (
    <span title={pulls.map((p) => `PR #${p.number}${p.merged ? " merged" : ""}`).join(", ")} className="flex items-center gap-1 font-mono text-[11px] whitespace-nowrap text-ink-3 md:col-start-7">
      <Icon className={cn("size-3.5", last.merged ? "text-status-done" : "text-status-review")} />#{last.number}
      {pulls.length > 1 && <span className="text-faint">+{pulls.length - 1}</span>}
    </span>
  );
}

/** Who did it, side by side: an agent's square, a bot's mark, a person's avatar; overlapped, the square and the mark read as one blot. */
const Actors = observer(function Actors({ ids }: { ids: readonly string[] }) {
  const people = ids.flatMap((id) => {
    const u = store.users.get(id);
    if (!u) return [];
    const mark = u.kind === "agent" ? <AgentAvatar name={u.name} className="[&_svg]:size-3" /> : u.kind === "bot" ? <BotMark user={u} /> : undefined;
    return [{ ...face(u), ...(mark && { mark }) }];
  });
  return <UserAvatarStack people={people} className="ml-auto space-x-[3px] *:ring-0 md:col-start-8 md:justify-self-end" />;
});

/**
 * A row of the chronology: the time, its node, and the cells in the day's columns. `sub`: a step of an opened issue's
 * row, its words under the title. `row`: J and K stop here. Without `cells`, `children` take the row from the title on.
 */
function LedgerRow({ time, node, sub = false, row, toggle, cells, ws, project, children }: { time: ReactNode; node: Node; sub?: boolean; row?: string; toggle?: ReactNode; cells?: Cells; ws?: string; project?: Project; children?: ReactNode }) {
  const outcome = cells && (
    <span className="grid size-4 shrink-0 place-items-center text-ink-3 [&_svg]:size-3.5" title={cells.now ? "Its state now" : undefined}>
      {cells.icon}
    </span>
  );
  return (
    <li data-timeline-row={row} className={cn("group relative grid scroll-mt-14 animate-in grid-cols-[56px_28px_minmax(0,1fr)] items-start duration-300 fade-in slide-in-from-bottom-1 md:col-span-full md:grid-cols-subgrid", sub ? "min-h-7" : "min-h-8")}>
      <span className={cn("pr-1.5 text-right font-mono text-[11px] text-ink-3 tabular-nums", sub ? "pt-1.5" : "pt-2")}>{time}</span>
      <span className={cn("relative grid place-items-center", sub ? "h-7" : "h-8")}>
        {node && <i className={cn("box-border block border-[1.5px]", sub ? "size-1.5 rounded-[1px] border-ink-2 bg-ground" : NODE[node])} />}
      </span>
      <div className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[5px] pr-2 pl-1 text-ink-2 group-data-[selected]:bg-row-selected md:col-[3/-1] md:grid md:grid-cols-subgrid md:gap-x-3", sub ? "py-[3px] text-[12.5px]" : "py-[5px] text-[13px]")}>
        {!cells ? (
          <span className="min-w-0 md:col-[4/-1]">{children}</span>
        ) : sub ? (
          <>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 md:col-[4/6]">
              {outcome}
              <span className="shrink-0 whitespace-nowrap text-ink-2">{cells.label}</span>
              {cells.path && <span className="min-w-0 truncate text-ink-3">{cells.path}</span>}
            </span>
            {cells.pulls && <Pulls pulls={cells.pulls} />}
            {cells.by.length > 0 && <Actors ids={cells.by} />}
          </>
        ) : (
          <>
            {toggle ? <span className="flex md:col-start-1">{toggle}</span> : <span aria-hidden className="w-[22px] md:hidden" />}
            <span className={cn("flex items-center gap-1.5 whitespace-nowrap md:col-start-2", cells.now ? "text-ink-3" : "text-ink-2")}>
              {outcome}
              <span className="max-md:sr-only">{cells.label}</span>
            </span>
            {cells.issueId && ws && project && <IssueCells id={cells.issueId} ws={ws} project={project} />}
            {cells.text && <span className="min-w-0 truncate text-ink-2 max-md:shrink max-md:grow max-md:basis-0 md:col-[3/5]">{cells.text}</span>}
            <span className="flex min-w-0 basis-full items-center gap-x-2.5 empty:hidden max-md:pl-[54px] md:contents">
              {cells.path && <span className="min-w-0 truncate text-[12.5px] text-ink-3 md:col-start-5">{cells.path}</span>}
              {cells.span && <span className="font-mono text-[11px] whitespace-nowrap text-ink-3 tabular-nums md:col-start-6 md:justify-self-end">{cells.span}</span>}
              {cells.pulls && <Pulls pulls={cells.pulls} />}
              {cells.by.length > 0 && <Actors ids={cells.by} />}
            </span>
          </>
        )}
      </div>
    </li>
  );
}

/** A state as an outcome: its glyph and its name. */
function stateCells(id: unknown): Pick<Cells, "icon" | "label"> {
  const s = typeof id === "string" ? store.states.get(id) : undefined;
  return { icon: s && <StateGlyph state={s} />, label: s?.name ?? "A removed state" };
}

const fromState = (id: unknown) => (typeof id === "string" ? `from ${store.states.get(id)?.name ?? "a removed state"}` : undefined);

/** The field a change was to, as the outcome column names it; the state reads as the state itself. */
const FIELD: Record<string, string> = {
  title: "Renamed",
  description: "Description",
  priority: "Priority",
  assigneeIds: "Assignees",
  labelIds: "Labels",
  blockedByIds: "Blocked by",
  relatedIds: "Related",
  duplicateOfId: "Duplicate",
  delegateId: "Delegate",
  parentId: "Parent",
  startDate: "Start date",
  dueDate: "Due date",
  cycleId: "Cycle",
  archivedAt: "Archive",
  deletedAt: "Trash",
};

/** One step as cells: one per field it changed, as the issue activity does; what GitHub did is one. */
function stepCells(step: Step): Cells[] {
  const base = { issueId: step.issueId, by: step.by ? [step.by] : [] };
  if (step.kind === "created") return [{ ...base, icon: <PlusCircleIcon />, label: "Created", path: createdWith(step.with) }];
  if (step.kind === "comment") {
    // Only a picture or a file has no words.
    const text = oneLine(step.comment.x, (id) => store.users.get(id)?.name);
    return [{ ...base, icon: <ChatCircleIcon />, label: "Comment", path: text && <q title={text}>{text}</q> }];
  }
  const e = step.entry;
  if (e.gh) {
    const { line, stays } = githubWords(e.gh, typeof e.d.stateId === "string");
    const pulls = pullsOf([step]);
    if (line === "moved") return [{ ...base, ...stateCells(e.d.stateId), path: fromState(e.p.stateId), pulls }];
    if (line === "merged") return [{ ...base, icon: <GitMergeIcon className="text-status-done" />, label: "Merged", path: stays && "Linked: the state stays", pulls }];
    return [{ ...base, icon: <GitCommitIcon />, label: "Pushed", path: <><CommitChip gh={e.gh} /> {e.gh.title}</> }];
  }
  if (e.a === "A") return [{ ...base, icon: <ArchiveIcon />, label: "Archived" }];
  // A move to another project (PLNR-448) is one line, as in the issue's activity: the state and labels it mapped with it.
  if ("projectId" in e.d) {
    const l = drawLine(historyLines(e)[0]!);
    return [{ ...base, icon: l.icon, label: "Moved", path: l.text }];
  }
  return Object.entries(e.d).flatMap((([k, after]): Cells[] => {
    if (k === "stateId") return [{ ...base, ...stateCells(after), path: fromState(e.p.stateId) }];
    const l = fieldLine(`${e.id}:${k}`, k, e.p[k], after);
    return l ? [{ ...base, icon: l.icon, label: FIELD[k] ?? k, path: l.text }] : [];
  }));
}

/** One step as rows: the first with the time and the node. `sub`: under its issue's row, so the issue stays out. */
const StepRows = observer(function StepRows({ step, ws, project, sub = false, actor = true, row }: { step: Step; ws: string; project: Project; sub?: boolean; actor?: boolean; row?: string }) {
  const node: Node = isAgent(step.by) ? "agent" : "human";
  return stepCells(step).map((c, i) => (
    <LedgerRow key={i} time={i === 0 ? <Time at={step.at} /> : ""} node={i === 0 ? node : null} sub={sub} {...(row && i === 0 ? { row } : {})} cells={actor ? c : { ...c, by: [] }} ws={ws} project={project} />
  ));
});

/** A change of the project's own, a state or a label: what it was, no issue. */
const SettingRows = observer(function SettingRows({ row }: { row: Extract<Row, { kind: "setting" }> }) {
  const { entry } = row;
  const node: Node = isAgent(entry.by) ? "agent" : "human";
  const label = entry.m === "WorkflowState" ? "State" : "Label";
  return settingLines(entry).map((l, i) => (
    <LedgerRow key={l.key} time={i === 0 ? <Time at={entry.at} /> : ""} node={i === 0 ? node : null} {...(i === 0 ? { row: row.key } : {})} cells={{ icon: l.icon, label, text: l.text, by: entry.by ? [entry.by] : [] }} />
  ));
});

const linkName = (c: ChainLink) => (c.kind === "created" ? "created" : (store.states.get(c.stateId)?.name ?? "a removed state"));

/** The states an issue passed before its outcome, as glyphs alone; the words are in the tooltip. A phone has no room for it. */
function Trail({ chain, words }: { chain: readonly ChainLink[]; words: string }) {
  if (!chain.length) return null;
  return (
    <span title={words} className="inline-flex items-center gap-[3px] align-middle text-ink-3 max-md:hidden [&_svg]:size-3">
      <span className="sr-only">{words}</span>
      {chain.map((c, i) => {
        const s = c.kind === "state" ? store.states.get(c.stateId) : undefined;
        return (
          <Fragment key={i}>
            {i > 0 && <i aria-hidden className="h-px w-1 bg-rule-strong" />}
            {c.kind === "created" ? <PlusCircleIcon aria-hidden /> : s && <StateGlyph state={s} />}
          </Fragment>
        );
      })}
    </span>
  );
}

/** Where an issue stands now, for a row whose day did not move it. */
function nowCells(issueId: string): Pick<Cells, "icon" | "label" | "now"> {
  const stateId = store.issues.get(issueId)?.stateId;
  return { ...stateCells(stateId), now: true };
}

/** Steps an opened row shows before the earlier ones fold: the last ones, where the outcome is. */
const SHOWN = 3;

const Story = observer(function Story({ row, ws, project, level }: { row: Extract<Row, { kind: "story" }>; ws: string; project: Project; level: string }) {
  const [flipped, setFlipped] = useState(false);
  const [whole, setWhole] = useState(false);
  const expanded = (level === "steps") !== flipped;
  const approval = row.steps.find((s) => s.kind === "entry" && typeof s.entry.d.stateId === "string" && stateKind(s.entry.d.stateId) === "approved");
  const waiting = waitsForMe(row.issueId);
  const last = row.chain.at(-1);
  const outcome = !last ? nowCells(row.issueId) : last.kind === "created" ? { icon: <PlusCircleIcon />, label: "Created" } : stateCells(last.stateId);
  const words = [row.chain.map(linkName).join(" → "), approval && `approved by ${userName(approval.by)}`].filter(Boolean).join(", ");
  const path = (
    <>
      <Trail chain={row.chain.slice(0, -1)} words={words} />
      {waiting && <span className="ml-2 text-signal-text">waits for you</span>}
    </>
  );
  const fold = expanded && !whole && row.steps.length > SHOWN + 1;
  const steps = fold ? row.steps.slice(-SHOWN) : row.steps;
  const oneActor = row.by.length === 1;
  return (
    <>
      <LedgerRow
        time={<Time at={row.to} from={row.from} />}
        node={row.by.some(isAgent) ? "agent" : "human"}
        row={row.key}
        toggle={<Toggle expanded={expanded} label={issueLink(row.issueId, ws, project)?.key ?? "a removed issue"} onToggle={() => setFlipped(!flipped)} />}
        cells={{ ...outcome, issueId: row.issueId, path: row.chain.length > 1 || waiting ? path : undefined, span: span(row.from, row.to), pulls: row.pulls, by: row.by }}
        ws={ws}
        project={project}
      />
      {fold && (
        <LedgerRow time="" node={null} sub>
          <button type="button" onClick={() => setWhole(true)} className="cursor-pointer rounded-[4px] text-[12.5px] text-ink-3 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring max-md:py-1">
            {row.steps.length - SHOWN} earlier
          </button>
        </LedgerRow>
      )}
      {expanded && steps.map((s) => <StepRows key={stepKey(s)} step={s} ws={ws} project={project} sub actor={!oneActor} />)}
    </>
  );
});

const stepKey = (s: Step) => (s.kind === "created" ? "created" : s.kind === "entry" ? s.entry.id : s.comment.id);

/** The glyph of each figure of a day's header, the same as the outcome column draws. */
const TOTAL_ICON: Record<keyof Tally, ReactNode> = {
  done: <StateIcon group="completed" />,
  merged: <GitMergeIcon className="text-status-done" />,
  opened: <GitPullRequestIcon className="text-status-review" />,
  review: <StateIcon group="started" stage="review" />,
  approved: <StateIcon group="started" stage="approved" />,
  created: <PlusCircleIcon className="text-ink-3" />,
  canceled: <StateIcon group="cancelled" />,
  comments: <ChatCircleIcon className="text-ink-3" />,
};

/** What the day got done, both sides together; how agents and people split each figure is in its tooltip. */
function Totals({ totals }: { totals: readonly Total[] }) {
  return totals.map((t) => (
    <span key={t.kind} title={`Agents ${t.agents} · People ${t.people}`} className="inline-flex items-center gap-1.5 whitespace-nowrap [&_svg]:size-3.5">
      {TOTAL_ICON[t.kind]}
      {t.text}
    </span>
  ));
}

const DaySection = observer(function DaySection({ day, now, ws, project, level }: { day: Day; now: Date; ws: string; project: Project; level: string }) {
  const waiting = new Set(day.rows.flatMap((r) => (r.kind === "story" ? [r.issueId] : r.kind === "step" ? [r.step.issueId] : [])).filter(waitsForMe)).size;
  const myWork = paths.myWork(ws);
  return (
    <section aria-label={day.key}>
      <DayHeader dayKey={day.key} now={now}>
        <span className="inline-flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px] text-ink-2">
          <Totals totals={dayTotals(day.agents, day.people)} />
          {waiting > 0 && (
            <Link href={myWork} className="link-plate font-medium text-signal-text no-underline">
              {waiting} {now.toDateString() === new Date(`${day.key}T12:00`).toDateString() ? "wait" : "still wait"}
              {waiting === 1 ? "s" : ""} for you →
            </Link>
          )}
        </span>
      </DayHeader>
      <ol className={cn(RAIL, COLUMNS)}>
        {day.rows.length === 0 ? (
          <LedgerRow time="" node={null}>
            <span className="text-ink-3">Nothing at this level for the people you picked.</span>
          </LedgerRow>
        ) : (
          day.rows.map((r) =>
            r.kind === "story" ? (
              <Story key={`${level}:${r.key}`} row={r} ws={ws} project={project} level={level} />
            ) : r.kind === "setting" ? (
              <SettingRows key={r.key} row={r} />
            ) : (
              <StepRows key={r.key} row={r.key} step={r.step} ws={ws} project={project} />
            ),
          )
        )}
      </ol>
    </section>
  );
});

export const Chronology = observer(function Chronology({ days, now, ws, project, level }: { days: readonly Day[]; now: Date; ws: string; project: Project; level: string }) {
  return days.map((d) => <DaySection key={d.key} day={d} now={now} ws={ws} project={project} level={level} />);
});
