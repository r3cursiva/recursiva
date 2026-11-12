// A person's own order of the projects (ADR 0020): one list of ids per person, not a position on each project. A
// project the list does not name, one made since or an order never set, follows by key.
import type { Project } from "@rsva/schema/models";

/** `projects` (by key, without archived ones) in the order of `order`; the same array when there is no order. */
export function orderProjects(projects: Project[], order: readonly string[]): Project[] {
  if (order.length === 0) return projects;
  const rank = new Map(order.map((id, i) => [id, i]));
  const at = (p: Project) => rank.get(p.id) ?? order.length;
  return [...projects].sort((a, b) => at(a) - at(b));
}

/**
 * The order with `id` moved right before `next` (undefined: last). `shown` is the list as the viewer sees it: its
 * projects the order does not name yet are held where they stand. Ids only the order knows stay, so an archived project
 * comes back to its place.
 */
export function movedOrder(order: readonly string[], shown: readonly string[], id: string, next: string | undefined): string[] {
  const named = new Set(order);
  const out = [...order, ...shown.filter((p) => !named.has(p))].filter((p) => p !== id);
  out.splice(next === undefined ? out.length : out.indexOf(next), 0, id);
  return out;
}
