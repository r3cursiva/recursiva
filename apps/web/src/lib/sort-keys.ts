// Manual order of issues: fractional indexes, the same `fractional-indexing` 4.0.0 the server uses (1.3 KB brotli,
// loaded only with the board and the create forms). A key written by the client must stay valid for the server's own
// generateKeyBetween, so a compatible rewrite would have to track the library anyway.
//
// sortOrder is one order across the whole project, while a column or a list group shows only part of it. Issues of
// other groups can sit between two neighbours of a group, so a key taken straight between the neighbours can equal one
// of theirs. Equal keys break the next insert between them (generateKeyBetween(a, a) throws), so the bounds are always
// two keys that are adjacent in the project order.
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/** Index of the first key greater than `k` in ascending `keys` (`orEqual`: not less than `k`). */
function bound(keys: readonly string[], k: string, orEqual: boolean): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]! < k || (!orEqual && keys[mid] === k)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The two keys, adjacent in the project order, an issue placed right after `above` or right before `below` within a group
 * goes between.
 *
 * - `projectKeys`: every sortOrder of the project in ascending order, without the moved issues. Empty keys (local issues
 *   the server has not numbered yet) are ignored.
 * - `above`, `below`: sortOrder of the neighbours in the group, or null at the group's edge.
 *
 * With both null (an empty group) the issue goes after everything else.
 */
function boundsFor(projectKeys: readonly string[], above: string | null, below: string | null): [string | null, string | null] {
  const keys = projectKeys.filter((k) => k !== "");
  let lo: string | null;
  let hi: string | null;
  if (above) {
    lo = above;
    hi = keys[bound(keys, above, false)] ?? null;
  } else if (below) {
    hi = below;
    lo = keys[bound(keys, below, true) - 1] ?? null;
  } else {
    lo = keys.at(-1) ?? null;
    hi = null;
  }
  // Duplicate keys can only come from outside (the server does not create them); fall back to "after lo".
  if (lo !== null && hi !== null && lo >= hi) hi = null;
  return [lo, hi];
}

/** The key for an issue placed right after `above` or right before `below` within a group (boundsFor). */
export function keyForPosition(projectKeys: readonly string[], above: string | null, below: string | null): string {
  return generateKeyBetween(...boundsFor(projectKeys, above, below));
}

/** Moves `id` before or after `targetId` in a group (`group` in on-screen order): its new sortOrder, or null if it would not move. */
export function keyForMove(
  projectOrder: readonly { id: string; sortOrder: string }[],
  group: readonly { id: string; sortOrder: string }[],
  id: string,
  index: number,
): string | null {
  const rest = group.filter((i) => i.id !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  const above = rest[at - 1] ?? null;
  const below = rest[at] ?? null;
  const old = group.findIndex((i) => i.id === id);
  // Same place in the same group: nothing to write.
  if (old >= 0 && group[old - 1]?.id === above?.id && group[old + 1]?.id === below?.id) return null;
  const keys = projectOrder.filter((i) => i.id !== id).map((i) => i.sortOrder);
  return keyForPosition(keys, above?.sortOrder || null, below?.sortOrder || null);
}

/**
 * Moves several issues (`ids`, in the order they will stand) to `index` of a group, as one block: their new sortOrders in
 * that order (RSVA-303, dragging marked cards). `index` counts the group's cards without the one dragged, as drop
 * places do; the other moved issues above it are not counted either.
 */
export function keysForMove(
  projectOrder: readonly { id: string; sortOrder: string }[],
  group: readonly { id: string; sortOrder: string }[],
  dragged: string,
  ids: readonly string[],
  index: number,
): string[] {
  const moving = new Set(ids);
  const withoutDragged = group.filter((i) => i.id !== dragged);
  const at = index - withoutDragged.slice(0, index).filter((i) => moving.has(i.id)).length;
  const rest = group.filter((i) => !moving.has(i.id));
  const clamped = Math.max(0, Math.min(at, rest.length));
  const keys = projectOrder.filter((i) => !moving.has(i.id)).map((i) => i.sortOrder);
  return generateNKeysBetween(...boundsFor(keys, rest[clamped - 1]?.sortOrder || null, rest[clamped]?.sortOrder || null), ids.length);
}
