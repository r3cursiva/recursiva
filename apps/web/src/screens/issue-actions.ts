// Actions on one issue shared by the row menu and the command palette.
import { TITLE_MAX, branchName, isClosedGroup, type Issue } from "@rsva/schema/models";
import { when } from "mobx";
import { keys } from "@rsva/ui/lib/keys";
import { subIssuesLeft as subsLeft } from "@rsva/display/move";
import { isPhone } from "../lib/phone.ts";
import { paths, router } from "../router.ts";
import { currentWs, store } from "../store.ts";
import { createIssue } from "./create-state.ts";
import { copyName, notice, toClipboard } from "./notice.ts";
import { listView } from "./list-view.ts";
import { moveRequest } from "./palette-state.ts";

export function issuePath(issue: Issue): string {
  return paths.browse(currentWs(), store.issueKey(issue));
}

/** The path of an issue opened beside its project's list. */
export function listIssuePath(ws: string, issue: Issue): string {
  return paths.listIssue(ws, store.projects.get(issue.projectId)?.key ?? "", store.issueKey(issue));
}

/** The issue's parent, unless it is in the trash. */
export function liveParent(issue: Issue): Issue | undefined {
  const parent = issue.parentId ? store.issues.get(issue.parentId) : undefined;
  return parent && !parent.deletedAt ? parent : undefined;
}

export function openIssue(issue: Issue): void {
  router.push(issuePath(issue));
}

export function openIssueInNewTab(issue: Issue): void {
  window.open(new URL(issuePath(issue), location.origin).href, "_blank", "noopener");
}

export function copy(text: string, what: string): Promise<void> {
  return toClipboard(
    text,
    () => notice.show(`${what} copied`),
    () => notice.show(`Could not copy the ${what.toLowerCase()}`),
  );
}

export function copyIssueLink(issue: Issue): void {
  void copy(new URL(issuePath(issue), location.origin).href, "Link");
}

/** ⌘. copies the key (shortcuts.ts); the menu, the palette and the header's key button show it. */
export const copyKeyHint = keys("mod", ".");

export function copyIssueKey(issue: Issue): void {
  void copy(store.issueKey(issue), "Key");
}

/** ⌘⇧. copies the branch name (shortcuts.ts); the button, the menu and the palette show it. */
export const copyBranchHint = keys("mod", "shift", ".");

export const issueBranch = (issue: Issue): string => branchName(store.issueKey(issue), issue.title);

export function copyIssueBranch(issue: Issue): void {
  void copyName(issueBranch(issue), "Branch name", isPhone() ? "Press and hold the name to copy it." : `The browser blocked the clipboard. Select it and press ${keys("mod", "C")}.`);
}

// ── Archive, delete, copy (PLNR-33) ───────────────────────────────────────────────────────────────────────────
// No confirmation dialog: each one shows at once and the toast offers Undo (⌘Z), which is an edit like any other, so it
// also works after a reload from the issue's banner or the project's archive.

/** Plane's rule, checked here to say why before the server refuses. */
export function canArchive(issue: Issue): boolean {
  return isClosedGroup(store.states.get(issue.stateId)?.group);
}

export function archiveIssue(issue: Issue): void {
  if (!canArchive(issue)) return notice.show("Only completed or cancelled issues can be archived");
  store.updateIssue(issue.id, { archivedAt: new Date().toISOString() });
  notice.show(`${store.issueKey(issue)} archived`, () => store.updateIssue(issue.id, { archivedAt: null }));
}

export function deleteIssue(issue: Issue): void {
  if (!store.mayDelete(issue)) return notice.show("Only the creator or an admin can delete this issue");
  store.updateIssue(issue.id, { deletedAt: new Date().toISOString() });
  notice.show(`${store.issueKey(issue)} moved to the trash`, () => store.updateIssue(issue.id, { deletedAt: null }));
}

/** An archived issue anyone may restore; a deleted one, as deleting, its creator or an admin. */
export function canRestore(issue: Issue): boolean {
  return issue.deletedAt ? store.mayDelete(issue) : !!issue.archivedAt;
}

/** Out of the archive or the trash, back into the lists. */
export function restoreIssue(issue: Issue): void {
  store.updateIssue(issue.id, { archivedAt: null, ...(issue.deletedAt ? { deletedAt: null } : {}) });
}

/**
 * Plane's "Make a copy": the create modal with every field of the issue and its description, the title marked as a
 * copy. The description comes with the issue's feed; an issue not opened yet waits for it (one request).
 */
export async function copyIssue(issue: Issue): Promise<void> {
  const feed = store.feed(issue.id);
  await when(() => store.description(issue.id) !== undefined || feed.status !== "loading");
  const { stateId, priority, assigneeIds, delegateId, labelIds, startDate, dueDate } = issue;
  // A parent in the trash cannot take a new sub-issue: the copy goes without it.
  const parentId = liveParent(issue)?.id ?? null;
  createIssue.show({ stateId, priority, assigneeIds, delegateId, labelIds, startDate, dueDate, parentId }, issue.projectId, {
    // A title near the limit gives up its end, not the mark: the server refuses a title past TITLE_MAX.
    title: `${issue.title.slice(0, TITLE_MAX - " (copy)".length)} (copy)`,
    description: store.description(issue.id)?.doc ?? null,
  });
}

// ── Move to another project (PLNR-448) ────────────────────────────────────────────────────────────────────────
// One way in from everywhere: the palette's project page (moveRequest), opened by an issue's menu, ⌘K, ⌘⇧M and the bulk
// bar. No Undo: a move back is another move, with another number.

/** ⌘⇧M, as in Linear: the open, selected or marked issues to another project. */
export const moveHint = keys("mod", "shift", "M");

/** An issue can move once it has its number, unless it is in the trash. */
export const canMove = (issue: Issue): boolean => issue.number > 0 && !issue.deletedAt;

/** The marked issues when this one is among them, else this one: a row's menu acts on the selection it is part of. */
export function markedOrOne(issue: Issue): Issue[] {
  if (!listView.marked.has(issue.id)) return [issue];
  return [...listView.marked].flatMap((id) => store.issues.get(id) ?? []);
}

export function showMove(issues: readonly Issue[]): void {
  const ids = issues.filter(canMove).map((i) => i.id);
  if (ids.length) moveRequest.show(ids);
}

/** Live sub-issues at any depth a move of these issues would leave behind. */
export const subIssuesLeft = (ids: readonly string[]): Issue[] => subsLeft((id) => store.subIssuesOf(id), ids);

/** Moves the issues, with their sub-issues when `withSubIssues`, and says where they went. */
export function moveIssues(ids: readonly string[], projectId: string, withSubIssues: boolean): void {
  const all = withSubIssues ? [...ids, ...subIssuesLeft(ids).map((i) => i.id)] : [...ids];
  const project = store.projects.get(projectId);
  const n = store.moveIssues(all, projectId);
  // The selection moved away, as archived or deleted ones do.
  if (ids.some((id) => listView.marked.has(id))) listView.clearMarks();
  if (!n || !project) return;
  // A lone move names the key it left; its new number comes with the server's answer.
  const one = n === 1 && ids.length === 1 ? store.issues.get(ids[0]!)?.formerKeys.at(-1) : undefined;
  notice.show(`${one ?? `${n} issues`} moved to ${project.name}`);
}
