// Issues as the agent API lists them, and the order the app lists them in: for the CLI's text and the TUI's screens.
import type { issueView } from "@rsva/query";
import type { Equal, StateGroup } from "@rsva/schema/models";

/**
 * The app's state groups in list order, and which of them are closed: STATE_GROUPS and isClosedGroup of @rsva/schema.
 * Written out, because importing that module adds about 9 ms to every start of the CLI (2026-11-04, 21 runs); a test
 * keeps the two equal (test/terminal.test.ts), and the type below the set of groups.
 */
export const STATE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
true satisfies Equal<(typeof STATE_GROUPS)[number], StateGroup>;
export const isClosedGroup = (group: string | null | undefined) => group === "completed" || group === "cancelled";

// The app's status glyphs (state-icon.tsx) in characters a terminal font has: a shape per group, so the state reads
// without colour too. The CLI's lists and the TUI's screens draw them.
const STATE_GLYPH: Record<Group, string> = { backlog: "◌", unstarted: "○", started: "◐", completed: "●", cancelled: "✕" };
type Group = (typeof STATE_GROUPS)[number];

/** A group's glyph; a group the app does not know reads as unstarted. */
export const stateGlyph = (group: string | null | undefined): string => (Object.hasOwn(STATE_GLYPH, group ?? "") ? STATE_GLYPH[group as Group] : STATE_GLYPH.unstarted);

/** The token's person's open issues: `rsva my` and the TUI's start. */
export const MY_WORK = "assignee:me -group:completed,cancelled";

/**
 * What a list row reads of an issue as the agent API sends it (issueView): a type-only import, so the CLI's start loads
 * nothing more. `state` is null when the issue's state is not found.
 */
export type IssueRow = Pick<
  ReturnType<typeof issueView>,
  "key" | "title" | "state" | "stateGroup" | "priority" | "labels" | "assignees" | "delegate" | "parent" | "cycle" | "startDate" | "dueDate"
>;

/** The states of a list in the app's order: by group, then as they first come. */
export function byState(issues: readonly IssueRow[]): IssueRow[][] {
  const groups = new Map<string, IssueRow[]>();
  for (const i of issues) {
    const k = `${i.stateGroup ?? ""}\u0000${i.state ?? ""}`;
    const group = groups.get(k);
    if (group) group.push(i);
    else groups.set(k, [i]);
  }
  const rank = (g: string | null | undefined) => (STATE_GROUPS as readonly string[]).indexOf(g ?? "") >>> 0;
  return [...groups.values()].sort((a, b) => rank(a[0]!.stateGroup) - rank(b[0]!.stateGroup));
}
