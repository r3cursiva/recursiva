// Pure pieces of project settings that the app's settings screens and the agent API share: where a moved state lands,
// the label tree and the label colors. A module of its own, not models.ts: models.ts is in the app's startup code, and a
// module goes whole into one chunk, so these would load with every start instead of with the settings screens.
import type { Label } from "./models.ts";
import { groupBy } from "./util.ts";

/**
 * Position for a row dropped at `index` among `positions` (ascending, without the moved row): halfway between its new
 * neighbours, one step past the edge, 0 in an empty list. Doubles halve about 50 times before two neighbours meet,
 * far more moves into one gap than a workflow sees.
 */
export function positionAt(positions: readonly number[], index: number): number {
  const before = positions[index - 1];
  const after = positions[index];
  if (before === undefined) return after === undefined ? 0 : after - 1;
  return after === undefined ? before + 1 : (before + after) / 2;
}

/** Labels in reading order: each parent followed by the labels inside it, by position; depth for the indent. */
export function labelTree(labels: readonly Label[]): { label: Label; depth: number }[] {
  const ids = new Set(labels.map((l) => l.id));
  // A parent outside the list (another project's, or gone) shows its labels at the top level.
  const children = groupBy(labels, (l) => (l.parentId && ids.has(l.parentId) ? l.parentId : null));
  const out: { label: Label; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const l of (children.get(parent) ?? []).sort((a, b) => a.position - b.position)) {
      if (seen.has(l.id)) continue; // a cycle from bad data must not loop
      seen.add(l.id);
      out.push({ label: l, depth });
      walk(l.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Colors offered for labels: Radix step 9 of twelve hues, distinct in both themes. A new label without one takes the next. */
export const LABEL_COLORS = [
  { value: "#E5484D", name: "Red" },
  { value: "#F76B15", name: "Orange" },
  { value: "#FFC53D", name: "Amber" },
  { value: "#46A758", name: "Green" },
  { value: "#12A594", name: "Teal" },
  { value: "#0090FF", name: "Blue" },
  { value: "#3E63DD", name: "Indigo" },
  { value: "#8E4EC6", name: "Purple" },
  { value: "#D6409F", name: "Pink" },
  { value: "#A18072", name: "Brown" },
  { value: "#8D8D86", name: "Gray" },
  { value: "#60646C", name: "Slate" },
] as const;
