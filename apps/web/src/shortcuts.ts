// App-wide keyboard shortcuts, as in Plane: ⌘/Ctrl+K palette, C or N I create, N P a new project (admins; the
// artboard's N alone would start N I), G O the project's home (RSVA-508), G I issues, G C cycles and G H history
// of the open project (PLNR-63, the tabs in its header), G P all projects, ⌘/Ctrl+\\ the sidebar, ⌘/Ctrl+.
// copy the key, ⌘/Ctrl+Backspace delete, ⌘/Ctrl+⇧M move to another project (PLNR-448). G N opens the inbox: the artboard's G I is Plane's issues here; G M, My work.
// The navigation artboards' (PLNR-58): `,` the project's settings, G , the workspace's, [ and ] the previous and next
// project, Esc from a project's settings or archive back to the page they were opened from. The list's own keys (↑↓, Enter, Esc,
// S/P/A/L) stay in project-issues.tsx, E, F, V, ⇧V (Display) and / in view-tabs.tsx. `?` shows them all
// (screens/shortcut-sheet.tsx, the one list of the keys); Tab, the arrows inside an area and F6 are lib/areas.ts.
//
// The listener is added when this module loads, before any screen's effect, so a chord's second key ("p" of "g p") is
// taken here and does not reach the list's handlers registered later on the same capture phase.
import { isLiveIssue } from "@rsva/schema/models";
import { copyKeys } from "./lib/copy-keys.ts";
import { viewerCan } from "./lib/roles.ts";
import { typing } from "./lib/typing.ts";
import { paths, routeIssue, routeProject, router } from "./router.ts";
import { backToProject } from "./return-to.ts";
import { currentWs, store } from "./store.ts";
import { createIssue } from "./screens/create-state.ts";
import { listView } from "./screens/list-view.ts";
import { loadEditChunk } from "./screens/load-edit-chunk.ts";
import { newProject, palette, shortcutSheet } from "./screens/palette-state.ts";
import { sidebar } from "./screens/sidebar-state.ts";

const CHORD_MS = 1000;
let prefix: { key: string; at: number } | null = null;

/** The open issue, else the selected one. */
function currentIssue() {
  const r = router.route;
  const key = routeIssue(r);
  if (key) return store.issueByKey(key);
  return listView.selectedId ? store.issues.get(listView.selectedId) : undefined;
}

/**
 * What ⌘⌫ deletes: the open issue, or the selected row of the list or board on screen. The selection outlives the
 * list (it is kept for coming back), so on any other screen nothing is deleted.
 */
function deleteTarget() {
  const r = router.route;
  const key = routeIssue(r);
  if (key) {
    const i = store.issueByKey(key);
    return i && !i.deletedAt ? i : undefined;
  }
  if (r.name !== "issues" || !listView.selectedId) return undefined;
  const i = store.issues.get(listView.selectedId);
  return i && isLiveIssue(i) && i.projectId === store.projectByKey(r.projectKey)?.id ? i : undefined;
}

/** The previous or next project of the sidebar, on the same page of it (its issues, settings or archive). */
function stepProject(by: number): void {
  const r = router.route;
  const key = routeProject(r);
  const list = store.projectList();
  if (!key || !list.length) return;
  const at = list.findIndex((p) => p.key === store.projectByKey(key)?.key);
  // From an archived project (not in the list): the first or the last one.
  const next = list[at < 0 ? (by > 0 ? 0 : list.length - 1) : (at + by + list.length) % list.length]!;
  const ws = currentWs();
  router.push(r.name === "settings" || r.name === "archive" || r.name === "history" || r.name === "cycles" || r.name === "projectHome" ? paths[r.name](ws, next.key) : paths.issues(ws, next.key));
}

function onKey(e: KeyboardEvent): void {
  const mod = e.metaKey || e.ctrlKey;
  const copying = copyKeys(e);
  if (e.key === "Escape" && !mod && !e.altKey && !e.shiftKey) {
    const r = router.route;
    if ((r.name !== "settings" && r.name !== "archive") || typing(e.target)) return;
    router.push(backToProject(r.ws, r.projectKey));
  } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
    // In the editor ⌘K is "link": the palette opens from anywhere else.
    if (e.target instanceof Element && e.target.closest(".ProseMirror")) return;
    if (palette.open) palette.close();
    else palette.show();
  } else if (mod && !e.altKey && !e.shiftKey && e.code === "Backslash") {
    // By the key's place: on a Russian layout the same key gives "ё".
    sidebar.toggle();
  } else if (copying) {
    const issue = currentIssue();
    if (!issue || typing(e.target) || (copying === "branch" && issue.number === 0)) return;
    e.preventDefault();
    // Within the key press's user activation, which the clipboard needs; the module is in the prefetched edit chunk.
    void loadEditChunk().then((m) => (copying === "branch" ? m.copyIssueBranch(issue) : m.copyIssueKey(issue)));
  } else if (mod && e.shiftKey && !e.altKey && e.code === "KeyM") {
    // Linear's Move to team (PLNR-448): the marked issues, else the open or selected one. By the key's place, as ⌘\.
    if (typing(e.target)) return;
    const issue = currentIssue();
    const issues = listView.marked.size > 0 ? [...listView.marked].flatMap((id) => store.issues.get(id) ?? []) : issue ? [issue] : [];
    if (!issues.length) return;
    void loadEditChunk().then((m) => m.showMove(issues));
  } else if (mod && e.key === "Backspace" && !e.shiftKey && !e.altKey) {
    // Plane's delete; Undo is in the toast, so it asks nothing. With issues marked, those (PLNR-294).
    if (listView.marked.size > 0 && !typing(e.target)) return void loadEditChunk().then((m) => m.deleteMarked());
    const issue = deleteTarget();
    if (!issue || typing(e.target)) return;
    void loadEditChunk().then((m) => m.deleteIssue(issue));
  } else {
    if (mod || e.altKey || typing(e.target) || e.key.length !== 1) return;
    const key = e.key.toLowerCase();
    const chord = prefix && e.timeStamp - prefix.at < CHORD_MS ? prefix.key : null;
    prefix = null;
    const ws = currentWs();
    if (chord === "g" && (key === "o" || key === "i" || key === "c" || key === "h")) {
      const r = router.route;
      const projectKey = routeProject(r);
      const project = projectKey ? store.projectByKey(projectKey) : store.projectList()[0];
      const page = { o: paths.projectHome, i: paths.issues, c: paths.cycles, h: paths.history }[key];
      if (project) router.push(page(ws, project.key));
    } else if (chord === "g" && key === "n") {
      router.push(paths.inbox(ws));
    } else if (chord === "g" && key === "m") {
      router.push(paths.myWork(ws));
    } else if (chord === "g" && key === "p") {
      router.push(paths.projects(ws));
    } else if (chord === "g" && key === "v") {
      router.push(paths.views(ws));
    } else if (chord === "g" && key === ",") {
      router.push(paths.workspaceSettings(ws));
    } else if (chord === "n" && key === "i") {
      createIssue.show();
    } else if (chord === "n" && key === "p") {
      if (!viewerCan("projects.write")) return;
      newProject.show();
    } else if (!chord && e.key === "?") {
      // Every key on one sheet (PLNR-304); `?` again closes it.
      if (shortcutSheet.open) shortcutSheet.close();
      else shortcutSheet.show();
    } else if (!chord && key === "c" && !e.shiftKey) {
      createIssue.show();
    } else if (!chord && key === ",") {
      const project = routeProject(router.route);
      if (!project || router.route.name === "settings") return;
      router.push(paths.settings(ws, store.projectByKey(project)?.key ?? project));
    } else if (!chord && (key === "[" || key === "]")) {
      if (!routeProject(router.route)) return;
      stepProject(key === "]" ? 1 : -1);
    } else if (!chord && (key === "g" || key === "n") && !e.shiftKey) {
      prefix = { key, at: e.timeStamp };
      return;
    } else {
      return;
    }
  }
  e.preventDefault();
  e.stopImmediatePropagation();
}

addEventListener("keydown", onKey, true);
