// History entries as Linear words them, one line per changed field with its own icon: "Robin moved from Backlog to Done",
// "Robin added label bug". The words are shared with the TUI (packages/display history.ts); here they are drawn: names
// from the store, so a renamed state or label reads with its current name, icons, a state's glyph, a label's colour. A
// project's own changes (its states and labels, PLNR-270) read here too, with the names they had then: the log keeps
// them, the store knows only today's.
import {
  ArchiveIcon,
  ArrowSquareRightIcon,
  ArrowsClockwiseIcon,
  CalendarBlankIcon,
  CalendarCheckIcon,
  CircleDashedIcon,
  CopyIcon,
  GitCommitIcon,
  GitMergeIcon,
  LinkSimpleIcon,
  NotePencilIcon,
  ProhibitIcon,
  PencilSimpleLineIcon,
  RobotIcon,
  TagIcon,
  TrashIcon,
  TreeStructureIcon,
  UserCircleIcon,
} from "@phosphor-icons/react";
import type { HistoryEntry, ProjectSettingEntry } from "@rsva/sync";
import { priorityName, type GithubEvent } from "@rsva/schema/models";
import { ColorDot } from "@rsva/ui/components/color-chip";
import { PriorityIcon } from "@rsva/ui/components/priority-icon";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { githubWords } from "@rsva/display/github";
import { createdWith as sharedCreatedWith, fieldLine as sharedFieldLine, REMOVED, type HistoryIcon, type HistoryLine as SharedLine, type HistoryPart } from "@rsva/display/history";
import { faceOf } from "../lib/face.ts";
import { Fragment, type ReactNode } from "react";
import { store } from "../store.ts";
import { STATE_GROUP_LABELS } from "./filter-model.ts";
import { CommitChip, GithubMark, LinkedTag, PullChip } from "./github-parts.tsx";
import { StateGlyph } from "./state-glyph.tsx";

/** One line of the timeline: its icon and its sentence after the actor's name. */
export interface HistoryLine {
  key: string;
  icon: ReactNode;
  text: ReactNode;
  /** Who the line starts with, in place of the entry's author: GitHub's lines name a GitHub login, or nobody. */
  who?: string | null;
  /** The text is the runs around a pull request's chip: an ellipsis can only drop a chip whole, so a one-line row lays them out in a row, where the chip's title gives way before the words. */
  chip?: boolean;
}

const strong = (x: ReactNode) => <span className="font-medium text-foreground">{x}</span>;

export const userName = (id: unknown) => (typeof id === "string" && store.users.get(id)?.name) || REMOVED.user;

function label(id: string): ReactNode {
  const l = store.labels.get(id);
  return (
    <span className="inline-flex items-center gap-1 align-middle font-medium text-foreground">
      {l && <ColorDot color={l.color} />}
      {l?.name ?? REMOVED.label}
    </span>
  );
}

function stateName(id: unknown): ReactNode {
  const s = typeof id === "string" ? store.states.get(id) : undefined;
  return strong(s ? s.name : REMOVED.state);
}

function issueRef(id: unknown): ReactNode {
  const i = typeof id === "string" ? store.issues.get(id) : undefined;
  return strong(i ? `${store.issueKey(i)} ${i.title}` : REMOVED.issue);
}

/** One part of a shared sentence as the web draws it. */
export function drawPart(p: HistoryPart): ReactNode {
  if (typeof p === "string") return p;
  if ("em" in p) return strong(p.em);
  if ("aside" in p) return p.aside;
  if ("state" in p) return p.glyph ? stateMark(p.state) : stateName(p.state);
  if ("label" in p) return label(p.label);
  if ("user" in p) return strong(userName(p.user));
  if ("issue" in p) return issueRef(p.issue);
  if ("cycle" in p) return strong(typeof p.cycle === "string" ? (store.cycles.get(p.cycle)?.name ?? REMOVED.cycle) : "");
  if ("project" in p) return strong(typeof p.project === "string" ? (store.projects.get(p.project)?.name ?? REMOVED.project) : REMOVED.project);
  return strong(priorityName(p.priority));
}

/** A shared sentence; `draw` takes drawPart's place where a row draws some parts its own way. */
export const drawParts = (parts: readonly HistoryPart[], draw: (p: HistoryPart) => ReactNode = drawPart): ReactNode[] => parts.map((p, i) => <Fragment key={i}>{draw(p)}</Fragment>);

const ICON: Record<Exclude<HistoryIcon["kind"], "state" | "priority" | "person" | "github">, ReactNode> = {
  title: <PencilSimpleLineIcon />,
  description: <NotePencilIcon />,
  assignees: <UserCircleIcon />,
  labels: <TagIcon />,
  blockers: <ProhibitIcon />,
  related: <LinkSimpleIcon />,
  duplicate: <CopyIcon />,
  delegate: <RobotIcon />,
  parent: <TreeStructureIcon />,
  start: <CalendarBlankIcon />,
  due: <CalendarCheckIcon />,
  cycle: <ArrowsClockwiseIcon />,
  archive: <ArchiveIcon />,
  delete: <TrashIcon />,
  move: <ArrowSquareRightIcon />,
};

/** A line's icon: the new state's glyph (a removed one, a pencil), the priority's bars, a person's face. GitHub's lines draw their own. */
function drawIcon(icon: HistoryIcon): ReactNode {
  switch (icon.kind) {
    case "state": {
      const s = typeof icon.state === "string" ? store.states.get(icon.state) : undefined;
      return s ? <StateGlyph state={s} /> : <PencilSimpleLineIcon />;
    }
    case "priority":
      return <PriorityIcon priority={icon.priority} />;
    case "person":
      return <UserAvatar {...faceOf(icon.user, "someone")} className="size-4" />;
    case "github":
      return null;
    default:
      return ICON[icon.kind];
  }
}

/** A shared line as a row draws it; what GitHub did with its chips. */
export function drawLine(l: SharedLine<HistoryEntry>): HistoryLine {
  if (l.github?.gh) return githubLine(l.github, l.github.gh);
  return { key: l.key, icon: drawIcon(l.icon), text: <>{drawParts(l.parts)}</> };
}

/** A state in a sentence, with its glyph; the negative margin keeps the glyph from stretching the line. Plain inline, so an ellipsis cuts the name instead of dropping the whole mark. */
export function stateMark(id: unknown): ReactNode {
  const s = typeof id === "string" ? store.states.get(id) : undefined;
  return (
    <span className="font-medium whitespace-nowrap text-ink">
      {s && <StateGlyph state={s} className="-my-0.5 mr-[5px] inline align-[-1px]" />}
      {s?.name ?? REMOVED.state}
    </span>
  );
}

/** What the line is about: a pull request's chip, a commit, or a branch. */
function githubSubject(gh: GithubEvent): ReactNode {
  if (gh.number !== null) return <PullChip gh={gh} />;
  if (gh.sha) {
    return (
      <>
        <CommitChip gh={gh} /> {gh.title}
      </>
    );
  }
  return (
    <>
      branch <span className="font-mono text-[11.5px] text-ink">{gh.title}</span>
    </>
  );
}

/** What GitHub did, as one line of the GhIssue artboard: the state with what moved it; a merge that only links says the state stays. */
function githubLine(e: HistoryEntry, gh: GithubEvent): HistoryLine {
  const { line, who, verb, stays } = githubWords(gh, !!e.d.stateId);
  const base = { key: `${e.id}:github`, who, chip: gh.number !== null };
  if (line === "pushed") return { ...base, icon: <GitCommitIcon />, text: <>pushed {githubSubject(gh)}</> };
  const said = (
    <>
      {githubSubject(gh)}{" "}
      <span>
        {verb} by {strong(gh.by)}
        {stays && <>. It is <LinkedTag className="inline" />, so the state stays.</>}
      </span>
    </>
  );
  if (line === "moved") return { ...base, icon: <GithubMark className="size-[18px]" />, text: <><span>moved it from {stateMark(e.p.stateId)} to {stateMark(e.d.stateId)} ·</span> {said}</> };
  return { ...base, icon: <GitMergeIcon className="text-status-done" />, text: said };
}

/** The line of one field's change from `before` to `after`, drawn; null for a change that says nothing. */
export function fieldLine(key: string, field: string, before: unknown, after: unknown): HistoryLine | null {
  const l = sharedFieldLine<HistoryEntry>(key, field, before, after);
  return l && drawLine(l);
}

/**
 * What an issue started with, after "created": " in Backlog · security, proposed · for Robin · High". Null for an issue
 * whose creation is not in the log (an imported one), empty for one that started with nothing set.
 */
export const createdWith = (d: Record<string, unknown> | undefined): ReactNode => (d ? drawParts(sharedCreatedWith(d)) : null);

const named = (x: unknown) => strong(typeof x === "string" && x ? x : "a removed one");

/** The lines of a change of the project's own state or label: one per field it changed. */
export function settingLines(e: ProjectSettingEntry): HistoryLine[] {
  const isState = e.m === "WorkflowState";
  const noun = isState ? "state" : "label";
  const now = isState ? store.states.get(e.mid) : undefined;
  const icon = isState ? now ? <StateGlyph state={now} /> : <CircleDashedIcon /> : <TagIcon />;
  // The name it had at that moment: its own when the entry carries it, else today's.
  const name = e.d.name ?? (isState ? now?.name : store.labels.get(e.mid)?.name) ?? e.p.name;
  const line = (k: string, text: ReactNode): HistoryLine => ({ key: `${e.id}:${k}`, icon, text });
  if (e.a === "I") return [line("new", <>created {noun} {named(e.d.name)}</>)];
  if (e.a === "D") return [line("gone", typeof e.p.name === "string" ? <>deleted {noun} {named(e.p.name)}</> : <>deleted a {noun}</>)];
  const out: HistoryLine[] = [];
  if ("name" in e.d) out.push(line("name", <>renamed {noun} {named(e.p.name)} to {named(e.d.name)}</>));
  if ("group" in e.d) out.push(line("group", <>moved {noun} {named(name)} to the {strong(STATE_GROUP_LABELS[String(e.d.group)] ?? String(e.d.group))} group</>));
  if (e.d.isDefault === true) out.push(line("default", <>made {named(name)} the default {noun}</>));
  if ("parentId" in e.d) {
    const parent = typeof e.d.parentId === "string" ? store.labels.get(e.d.parentId)?.name : null;
    out.push(line("parent", e.d.parentId ? <>moved {noun} {named(name)} into {named(parent)}</> : <>moved {noun} {named(name)} to the top level</>));
  }
  return out;
}
