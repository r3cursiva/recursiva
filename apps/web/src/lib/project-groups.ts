// The viewer's groups of projects in the sidebar and Quiet (RSVA-566, the SidebarGroups artboards): where each project
// stands, and the changes the sidebar and the project menu make, each returning the whole new value to write.
//
// Groups are the viewer's own, like their order of projects: a group holds which projects are in it, the order inside
// is their order of projects, so a drag inside a group is the same move as anywhere else. Quiet fills itself from the
// local data: no change for the person's quiet days (Settings › Preferences: 14 unless they chose otherwise, or never), nothing waiting on the viewer, nothing overdue, no current cycle.
import type { ProjectGroup, QuietDays, SidebarGroups } from "@rsva/protocol";
import type { Project } from "@rsva/schema/models";

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the sidebar knows of a project to call it quiet. */
export interface ProjectSignals {
  /** When anything in it last changed, ISO. */
  lastChange(id: string): string;
  /** Something in it waits on the viewer: a review, a proposal, a question. */
  waits(id: string): boolean;
  overdue(id: string): boolean;
  inCycle(id: string): boolean;
}

/**
 * Marked quiet by the viewer, with nothing changed in it since: what they asked for holds, overdue or not. Otherwise
 * still for `days` (the person's choice; 0, never) with nothing that needs the viewer: a waiting issue, an overdue one or a running cycle keeps it out.
 * Keep visible exempts a project from both.
 */
export function isQuiet(id: string, g: SidebarGroups, s: ProjectSignals, now: number, days: QuietDays): boolean {
  if (g.keep.includes(id)) return false;
  const last = Date.parse(s.lastChange(id));
  const marked = g.quiet.find(([q]) => q === id)?.[1];
  if (marked !== undefined && last <= Date.parse(marked)) return true;
  return days > 0 && !s.waits(id) && !s.overdue(id) && !s.inCycle(id) && now - last >= days * DAY_MS;
}

interface GroupRows {
  group: ProjectGroup;
  projects: Project[];
}

export interface QuietRow {
  project: Project;
  /** The group it came from. */
  from: string | null;
}

export interface SidebarLayout {
  /** Projects in no group, on top. */
  top: Project[];
  groups: GroupRows[];
  quiet: QuietRow[];
}

/**
 * The sidebar's projects (already in the viewer's order, hidden ones left out) by place: ungrouped, each group, Quiet.
 * The open project keeps its place even when quiet, so the page has its row.
 */
export function layOut(projects: Project[], g: SidebarGroups, quiet: (id: string) => boolean, activeId: string | null): SidebarLayout {
  const groupOf = new Map<string, ProjectGroup>();
  for (const group of g.groups) for (const id of group.ids) groupOf.set(id, group);
  const rows = new Map<ProjectGroup | null, Project[]>([null, ...g.groups].map((group) => [group, []]));
  const out: QuietRow[] = [];
  for (const p of projects) {
    const group = groupOf.get(p.id) ?? null;
    if (p.id !== activeId && quiet(p.id)) out.push({ project: p, from: group?.name ?? null });
    else rows.get(group)!.push(p);
  }
  return { top: rows.get(null)!, groups: g.groups.map((group) => ({ group, projects: rows.get(group)! })), quiet: out };
}

/** A group's short caption over its tiles in the collapsed sidebar: its first three letters, "ACM" for Acme. */
export const caption = (name: string): string => name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 3).toUpperCase();

const without = (g: SidebarGroups, ids: readonly string[]): ProjectGroup[] => g.groups.map((group) => ({ ...group, ids: group.ids.filter((id) => !ids.includes(id)) }));

/** A new group goes right under the ungrouped projects, before the others; `ids` leave their groups for it. */
export const addGroup = (g: SidebarGroups, id: string, name: string, ids: readonly string[] = []): SidebarGroups => ({
  ...g,
  groups: [{ id, name, ids: [...ids] }, ...without(g, ids)],
});

export const renameGroup = (g: SidebarGroups, id: string, name: string): SidebarGroups => ({
  ...g,
  groups: g.groups.map((group) => (group.id === id ? { ...group, name } : group)),
});

/** Its projects go back on top. */
export const removeGroup = (g: SidebarGroups, id: string): SidebarGroups => ({ ...g, groups: g.groups.filter((group) => group.id !== id) });

/** Projects into a group (last), or out of every group with `to` null. */
export const moveToGroup = (g: SidebarGroups, ids: readonly string[], to: string | null): SidebarGroups => ({
  ...g,
  groups: without(g, ids).map((group) => (group.id === to ? { ...group, ids: [...group.ids, ...ids] } : group)),
});

/** A group dragged to stand right before `next` (undefined: last), RSVA-567. */
export function moveGroup(g: SidebarGroups, id: string, next: string | undefined): SidebarGroups {
  const moved = g.groups.find((group) => group.id === id);
  if (!moved) return g;
  const out = g.groups.filter((group) => group.id !== id);
  const at = next === undefined ? -1 : out.findIndex((group) => group.id === next);
  out.splice(at < 0 ? out.length : at, 0, moved);
  return { ...g, groups: out };
}

export function toggleFold(g: SidebarGroups, id: string): SidebarGroups {
  return {
    ...g,
    groups: g.groups.map((group) => {
      if (group.id !== id) return group;
      const { folded, ...open } = group;
      return folded ? open : { ...open, folded: true };
    }),
  };
}

/** Keep visible: never in Quiet, and no longer marked quiet. */
export const keepVisible = (g: SidebarGroups, id: string, on: boolean): SidebarGroups => ({
  ...g,
  keep: on ? [...g.keep.filter((k) => k !== id), id] : g.keep.filter((k) => k !== id),
  quiet: on ? g.quiet.filter(([q]) => q !== id) : g.quiet,
});

/** Mark as quiet: into Quiet now, until something in it changes; no longer kept visible. */
export const markQuiet = (g: SidebarGroups, id: string, at: string): SidebarGroups => ({
  ...g,
  keep: g.keep.filter((k) => k !== id),
  quiet: [...g.quiet.filter(([q]) => q !== id), [id, at]],
});

export const groupOf = (g: SidebarGroups, id: string): ProjectGroup | undefined => g.groups.find((group) => group.ids.includes(id));
