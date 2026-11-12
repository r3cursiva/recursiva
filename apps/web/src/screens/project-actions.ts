// Actions on a project shared by the sidebar, All projects and its settings; the sidebar's groups of projects (RSVA-566).
import { uuidv7, type PinRef, type ProjectGroup, type SidebarGroups } from "@rsva/protocol";
import type { Project } from "@rsva/schema/models";
import { addGroup, groupOf, keepVisible, markQuiet, moveGroup, moveToGroup, removeGroup, renameGroup } from "../lib/project-groups.ts";
import { paths } from "../router.ts";
import { currentWs, store } from "../store.ts";
import { attachDragDrop } from "./drag-drop.ts";
import { copy } from "./issue-actions.ts";
import { notice } from "./notice.ts";
import { sidebar } from "./sidebar-state.ts";

export function copyProjectLink(project: Project): void {
  void copy(new URL(paths.issues(currentWs(), project.key), location.origin).href, "Link");
}

/** Out of the sidebar and the project menus, with Undo in the toast; its issues stay reachable by key and link. */
export function archiveProject(project: Project): void {
  store.updateProject(project.id, { archivedAt: new Date().toISOString() });
  notice.show(`${project.name} archived`, () => store.updateProject(project.id, { archivedAt: null }));
}

export function restoreProject(project: Project): void {
  const at = project.archivedAt;
  store.updateProject(project.id, { archivedAt: null });
  notice.show(`${project.name} restored`, () => store.updateProject(project.id, { archivedAt: at }));
}

/**
 * Dragging the rows of `list`, one `[data-card]` each, into a new place; `move` gets the row and the one it now stands
 * before (undefined: last). Returns the cleanup. The row under the pointer is as wide as the list and sits on the drop
 * line: `previewClass` keeps it see-through.
 */
function attachRowDrag(list: HTMLElement, scroller: HTMLElement, previewClass: string, move: (id: string, next: string | undefined) => void): () => void {
  return attachDragDrop(list, {
    scroller,
    vertical: true,
    previewClass,
    onDrop: (id, _, to) => {
      move(id, cardsOf(list, id)[to.index]);
    },
  });
}

const cardsOf = (el: Element, but: string) => [...el.querySelectorAll<HTMLElement>("[data-card]")].map((r) => r.dataset.card!).filter((r) => r !== but);

/**
 * The projects' rows into the viewer's own order, and from one cell of `root` to another into that group (the sidebar's
 * groups, RSVA-566; "" is no group). A cell may leave out projects hidden from the sidebar or quiet: a row dropped last
 * goes right after the cell's last one; dropped on a folded or empty group, it only joins it.
 */
export function attachProjectDrag(root: HTMLElement, scroller: HTMLElement, previewClass: string): () => void {
  const groups = attachGroupDrag(root, scroller, previewClass);
  const projects = attachDragDrop(root, {
    scroller,
    vertical: true,
    previewClass,
    onDrop: (id, from, to) => {
      if (from.groupKey !== to.groupKey) setGroups(moveToGroup(store.views.groups, [id], to.groupKey || null));
      const cell = [...root.querySelectorAll<HTMLElement>("[data-cell]")].find((c) => c.dataset.group === to.groupKey) ?? root;
      const rows = cardsOf(cell, id);
      const next = rows[to.index];
      const last = rows.at(-1);
      if (!next && !last) return;
      const others = store.projectList().map((p) => p.id).filter((p) => p !== id);
      store.moveProject(id, next ? others.indexOf(next) : others.indexOf(last!) + 1);
    },
  });
  return () => {
    projects();
    groups();
  };
}

/** The groups by their name (or caption in the strip) into the viewer's own order (RSVA-567). */
function attachGroupDrag(root: HTMLElement, scroller: HTMLElement, previewClass: string): () => void {
  return attachDragDrop(root, {
    scroller,
    vertical: true,
    previewClass,
    card: "data-group-card",
    cell: "data-group-cell",
    over: "data-group-over",
    handle: "[data-group-handle]",
    onDrop: (id, _, to) => {
      const cell = root.querySelector("[data-group-cell]");
      const rows = cell ? [...cell.children].map((c) => c.getAttribute("data-group-card")).filter((g): g is string => !!g && g !== id) : [];
      setGroups(moveGroup(store.views.groups, id, rows[to.index]));
    },
  });
}

/** Pins dragged in the sidebar's Pinned section. */
export function attachPinDrag(list: HTMLElement, scroller: HTMLElement, previewClass: string): () => void {
  return attachRowDrag(list, scroller, previewClass, (id, next) => store.views.movePin(id as PinRef, next as PinRef | undefined));
}

/** Out of the viewer's sidebar or back in, with Undo in the toast; All projects keeps showing it. */
export function hideProject(project: Project, hidden: boolean): void {
  store.views.hideProject(project.id, hidden);
  notice.show(hidden ? `${project.name} hidden from the sidebar` : `${project.name} back in the sidebar`, () => store.views.hideProject(project.id, !hidden));
}

// ── Groups of projects in the sidebar (RSVA-566) ─────────────────────────────────────────────────────────────────

const setGroups = (g: SidebarGroups) => store.views.setGroups(g);

/** A change to the groups with Undo in the toast, which puts back the whole set as it was. */
function changeGroups(next: SidebarGroups, text: string): void {
  const was = store.views.groups;
  setGroups(next);
  notice.show(text, () => setGroups(was));
}

/** Makes the group under the ungrouped projects, then opens the projects to pick for it. */
export function createGroup(name: string): void {
  const id = uuidv7();
  setGroups(addGroup(store.views.groups, id, name));
  sidebar.pick(id);
}

export function renameGroupTo(group: ProjectGroup, name: string): void {
  setGroups(renameGroup(store.views.groups, group.id, name));
}

/** The group goes, its projects back on top. */
export function ungroup(group: ProjectGroup): void {
  changeGroups(removeGroup(store.views.groups, group.id), `${group.name} ungrouped`);
}

export function addToGroup(group: ProjectGroup, ids: readonly string[]): void {
  setGroups(moveToGroup(store.views.groups, ids, group.id));
}

/** Into a group, or out of its group with null. */
export function moveProjectToGroup(project: Project, to: ProjectGroup | null): void {
  if ((groupOf(store.views.groups, project.id)?.id ?? null) === (to?.id ?? null)) return;
  changeGroups(moveToGroup(store.views.groups, [project.id], to?.id ?? null), to ? `${project.name} moved to ${to.name}` : `${project.name} out of its group`);
}

export function keepProjectVisible(project: Project, on: boolean): void {
  setGroups(keepVisible(store.views.groups, project.id, on));
}

/** Into Quiet now, until something in it changes. */
export function markProjectQuiet(project: Project): void {
  changeGroups(markQuiet(store.views.groups, project.id, new Date().toISOString()), `${project.name} is quiet`);
}
