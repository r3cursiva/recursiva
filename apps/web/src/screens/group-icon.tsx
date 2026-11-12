// The parts of a group header shared by list sections and board columns: the icon (what the group stands for, as in
// Plane), name and count, and the button that adds an issue to the group.
import { PlusIcon, RobotIcon, UserCircleDashedIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { IssueGroup } from "@rsva/query";
import { Button } from "@rsva/ui/components/button";
import { ColorDot } from "@rsva/ui/components/color-chip";
import { PriorityIcon } from "@rsva/ui/components/priority-icon";
import { StateIcon } from "@rsva/ui/components/state-icon";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { face } from "../lib/face.ts";
import { presetFor, type GroupTarget } from "../lib/group-patch.ts";
import { store } from "../store.ts";
import { createIssue } from "./create-state.ts";
import { ProjectIcon } from "./sidebar-parts.tsx";
import { IssueStateGlyph, StateGlyph } from "./state-glyph.tsx";

/** A small square button of a group header. */
export const groupButton =
  "grid size-[22px] place-items-center rounded-sm text-ink-2 outline-none transition-colors duration-120 hover:bg-row-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-ring max-md:size-9 max-md:rounded-lg [&_svg]:size-3 max-md:[&_svg]:size-4";

export function GroupIcon({ group }: { group: IssueGroup }) {
  const ref = group.ref;
  if (ref && "state" in ref) return <StateGlyph state={ref.state} />;
  if (ref && "stateGroup" in ref) return <StateIcon group={ref.stateGroup} />;
  if (ref && "priority" in ref) return <PriorityIcon priority={ref.priority} />;
  if (ref && "user" in ref) return <UserAvatar {...face(ref.user)} className="size-4" />;
  if (ref && "label" in ref) return <ColorDot color={ref.label.color} className="mx-0.5" />;
  if (ref && "project" in ref) return <ProjectIcon project={ref.project} />;
  if (ref && "parent" in ref) return <IssueStateGlyph issue={ref.parent} />;
  if (group.groupBy === "delegate") return <RobotIcon className="size-4 text-ink-3" />;
  if (group.groupBy === "assignee" || group.groupBy === "createdBy") return <UserCircleDashedIcon className="size-4 text-ink-3" />;
  if (group.groupBy === "label") return <ColorDot color="var(--color-rule-strong)" className="mx-0.5" />;
  return null;
}

/**
 * Icon, name and issue count. `caret`, a list section's collapse caret, takes the icon's place while the header is
 * hovered or focused by keyboard, so it never sits beside the icon (with a mouse; a touch screen keeps its own caret).
 */
export function GroupLabel({ group, caret }: { group: IssueGroup; caret?: ReactNode }) {
  return (
    <>
      {caret ? (
        <span className="grid place-items-center [&>*]:[grid-area:1/1]">
          <span className="flex transition-opacity duration-150 pointer-fine:group-hover/head:opacity-0 group-has-focus-visible/head:opacity-0">
            <GroupIcon group={group} />
          </span>
          {caret}
        </span>
      ) : (
        <GroupIcon group={group} />
      )}
      <span className="truncate text-label font-semibold">{group.name}</span>
      <span className="font-mono text-meta text-ink-3">{group.issues.length}</span>
    </>
  );
}

/** Opens the create form preset to the group (its state, priority, assignee or label), and to the list's `base` groups (its cycle). */
export function GroupAddButton({ group, projectId, base = [] }: { group: IssueGroup; projectId: string; base?: readonly GroupTarget[] | undefined }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title="Add issue"
      aria-label={`Add issue to ${group.name}`}
      onClick={() => createIssue.show(presetFor([...base, group], store.statesOf(projectId)), projectId)}
      className={`${groupButton} border-0 active:scale-100!`}
    >
      <PlusIcon className="size-3 max-md:size-4" />
    </Button>
  );
}
