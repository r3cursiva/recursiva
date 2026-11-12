// Swimlanes of a sub-grouped board: runQuery returns columns, each with its sub-groups; the board draws them as rows.
import type { IssueGroup } from "@rsva/query";
import type { Issue } from "@rsva/schema/models";

export interface Lane {
  lane: IssueGroup;
  /** Issues of the lane across all columns. */
  count: number;
}

/** Lanes in order of first appearance across columns (a lane may be missing from some columns). */
export function laneList(groups: readonly Pick<IssueGroup, "subGroups">[]): Lane[] {
  const lanes = new Map<string, Lane>();
  for (const g of groups)
    for (const s of g.subGroups ?? []) {
      const l = lanes.get(s.key);
      if (l) l.count += s.issues.length;
      else lanes.set(s.key, { lane: s, count: s.issues.length });
    }
  return [...lanes.values()];
}

/**
 * A column's cards in the board's order, each issue once: lane by lane when sub-grouped (an issue in two lanes is
 * walked at its first), else the column's own order. What J/K walk and N / M count beside an open card (PLNR-55).
 */
export function columnIssues(group: IssueGroup, lanes: readonly Lane[] | null): Issue[] {
  if (!lanes || !group.subGroups) return group.issues;
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const { lane } of lanes)
    for (const i of group.subGroups.find((s) => s.key === lane.key)?.issues ?? []) {
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      out.push(i);
    }
  return out;
}

/**
 * The column an issue is shown in: `preferred` (the one it was opened from, or moved to with ‹ ›) while that column
 * holds it, else the first that does, so a state change takes the column along. An issue no column shows (filtered
 * out by an edit) keeps `preferred`; nothing at all falls back to the first column with cards.
 */
export function columnOf(groups: readonly IssueGroup[], issueId: string | null, preferred: string | null): IssueGroup | undefined {
  const has = (g: IssueGroup) => g.issues.some((i) => i.id === issueId);
  const pref = groups.find((g) => g.key === preferred);
  if (pref && (!issueId || has(pref))) return pref;
  return groups.find(has) ?? pref ?? groups.find((g) => g.issues.length);
}

/**
 * The issue in `there` at the height `id` has in `here` (the first row when `here` lacks it), or the last one when
 * `there` is shorter: where ←/→ land in the neighbouring column, on the board and beside an open card.
 */
export function sameHeight(here: readonly Issue[], there: readonly Issue[], id: string | null): Issue | undefined {
  return there[Math.min(Math.max(0, here.findIndex((i) => i.id === id)), there.length - 1)];
}
