// What a row of My work shows of an issue (my-work.tsx): the workspace's tile with the key, the started stage, and the
// context and time each group has on the right.
import { CaretRightIcon } from "@phosphor-icons/react";
import {
  isClosedGroup,
  startedStage,
  type WorkflowState,
} from "@rsva/schema/models";
import type { SyncStore } from "@rsva/sync";
import { CollapsibleTrigger } from "@rsva/ui/components/collapsible";
import { LetterTile } from "@rsva/ui/components/letter-tile";
import { PriorityIcon } from "@rsva/ui/components/priority-icon";
import { StateIcon } from "@rsva/ui/components/state-icon";
import type { Lane } from "../lib/my-work-groups.ts";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import type { ReactNode } from "react";
import { localToday } from "@rsva/query";
import { formatDate } from "@rsva/display/time";
import {
  age,
  ASK_LABELS,
  dueText,
  isIdle,
  shortDay,
  type WorkItem,
} from "../lib/my-work.ts";
import { workspaceTileTone } from "./workspace-switcher.tsx";

export type { Workspace } from "../held-engines.ts";
import type { Workspace } from "../held-engines.ts";
const STALE_MS = 5 * 86_400_000;

/** A lane's mark before its name (grouped by status or priority): the status's glyph or the priority's. */
export function LaneMark({ lane }: { lane: Lane }) {
  if (lane.status)
    return (
      <StateIcon
        group={lane.status.group}
        {...(lane.status.stage ? { stage: lane.status.stage } : {})}
        className="size-3.5 shrink-0"
      />
    );
  return lane.priority !== undefined ? (
    <PriorityIcon priority={lane.priority} className="size-3.5 shrink-0" />
  ) : null;
}

/**
 * A section's head inside its Collapsible, sticky over its rows: the fold, its mark and name with the count, what the
 * section adds after them (children) and its keys on the right.
 */
export function SectionHead({
  folded,
  mark,
  name,
  count,
  right,
  children,
}: {
  folded: boolean;
  mark?: ReactNode;
  name: string;
  count: number;
  right?: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-group-head
      className="sticky top-0 z-[2] flex h-(--row-head) items-center gap-2.5 border-b border-rule-soft bg-sidebar pr-4 pl-3.5 max-md:h-10 max-md:pl-2.5"
    >
      <CollapsibleTrigger className="flex h-[26px] items-center gap-[7px] rounded-[5px] px-1.5 text-[12.5px] font-semibold outline-none hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring max-md:h-10 max-md:text-[13px]">
        <CaretRightIcon
          className={cn(
            "size-[11px] text-ink-3 transition-transform duration-200",
            !folded && "rotate-90",
          )}
        />
        {mark}
        {name}
        <span className="font-mono text-meta font-normal text-ink-3">
          {count}
        </span>
      </CollapsibleTrigger>
      {children}
      <span className="flex-1" />
      {right && (
        <span className="font-mono text-[10.5px] whitespace-nowrap text-ink-3 max-lg:hidden">
          {right}
        </span>
      )}
    </div>
  );
}

/** The workspace's tile and the issue key; the tooltip names the workspace and project. */
export const Ref = observer(function Ref({
  item,
  engine,
  workspace,
  current,
}: {
  item: WorkItem;
  engine: SyncStore;
  workspace: Workspace;
  current: boolean;
}) {
  const project = engine.projects.get(item.issue.projectId);
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap"
      title={`${workspace.name} / ${project?.name ?? ""}`}
    >
      <LetterTile
        name={workspace.name}
        tone={workspaceTileTone(workspace, current)}
        className="size-[13px] text-[8px]"
      />
      <span className="font-mono text-[11.5px] text-ink-3">
        {engine.issueKey(item.issue)}
      </span>
    </span>
  );
});

export function stageOf(
  states: readonly WorkflowState[],
  state: WorkflowState,
) {
  return state.group === "started"
    ? (startedStage(states, state.id) ?? "progress")
    : undefined;
}

/** The context column and the time on the right, by group. */
export function describe(
  x: WorkItem,
  e: SyncStore,
  now: number,
  today: string,
): {
  ctx: string;
  accent: boolean;
  meta: string;
  metaTone: "accent" | "ink" | "muted";
  idle?: boolean;
} {
  const others = (ids: readonly string[]) =>
    ids
      .filter((id) => id !== e.me?.id)
      .map((id) => e.users.get(id)?.name)
      .filter(Boolean)
      .join(", ");
  const since = now - Date.parse(x.since);
  const due = dueText(x.issue.dueDate, today);
  const dueMeta = {
    meta: due?.text ?? "no due date",
    metaTone: due?.over ? "accent" : due?.soon ? "ink" : "muted",
  } as const;
  // An assignment not read yet (RSVA-612): who assigned it stands before this, the row says so until it is read.
  if (x.fresh)
    return {
      ctx: "assigned you",
      accent: true,
      ...(due ? dueMeta : { meta: `${age(since)} ago`, metaTone: "muted" as const }),
    };
  switch (x.group) {
    case "wait":
      return x.ask === "mention" || x.ask === "reply"
        ? {
            ctx: ASK_LABELS[x.ask],
            accent: false,
            meta: `${x.ask === "mention" ? "mentioned" : "replied"} ${age(since)} ago`,
            metaTone: "muted",
          }
        : {
            ctx: ASK_LABELS[x.ask!],
            accent: false,
            meta: `waiting ${age(since)}`,
            metaTone: since >= 86_400_000 ? "accent" : "muted",
          };
    case "doing": {
      const subs = e.subIssuesOf(x.issue.id);
      const bits: string[] = [];
      if (subs.length)
        bits.push(
          `${subs.filter((s) => isClosedGroup(e.states.get(s.stateId)?.group)).length}/${subs.length} sub-issues`,
        );
      const parent = x.issue.parentId
        ? e.issues.get(x.issue.parentId)
        : undefined;
      if (parent) bits.push(`in ${e.issueKey(parent)}`);
      const with_ = others(x.issue.assigneeIds);
      if (with_) bits.push(`with ${with_}`);
      const stale = since >= STALE_MS;
      if (stale) bits.push(`${age(since)} without changes`);
      return { ctx: bits.join(" · "), accent: stale, ...dueMeta };
    }
    case "agents": {
      const idle = isIdle(x, now);
      return {
        ctx: e.states.get(x.issue.stateId)?.name ?? "",
        accent: false,
        meta: idle ? `idle ${age(since)}` : `${age(since)} ago`,
        metaTone: idle ? "accent" : "muted",
        idle,
      };
    }
    case "next":
    case "later": {
      const start =
        x.issue.startDate && x.issue.startDate > today
          ? `Starts ${formatDate(x.issue.startDate)}`
          : "";
      const with_ = others(x.issue.assigneeIds);
      return {
        ctx: start || (with_ ? `With ${with_}` : ""),
        accent: false,
        ...dueMeta,
      };
    }
    case "done":
      return {
        ctx: "",
        accent: false,
        meta: `done ${shortDay(localToday(new Date(x.since)), today)}`,
        metaTone: "muted",
      };
  }
}
