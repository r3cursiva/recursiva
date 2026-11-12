// A project's issues: header and list, and when the URL is /:ws/projects/KEY/issues/KEY-N the issue beside the list,
// which narrows to a column (PLNR-34). Keyboard as in Plane.
import type { Issue, Project } from "@rsva/schema/models";
import { SplitView } from "@rsva/ui/components/split-view";
import { observer } from "mobx-react-lite";
import { Activity, Suspense, useEffect } from "react";
import { useIsPhone } from "../lib/phone.ts";
import { afterPaint } from "../perf.ts";
import { paths, routeIssue, router } from "../router.ts";
import { store } from "../store.ts";
import { focusIssue, IssueList, markKey, openIssue, scrollToIssue, stepSelection, visibleIssues } from "./issue-list.tsx";
import { AddIssueButton, Board, BoardColumn, SettingsLink } from "./layout-switch.tsx";
import { ignoredKey, listView } from "./list-view.ts";
import { normKey } from "../lib/step-keys.ts";
import { paneKeys, useWindowKeys } from "./list-keys.ts";
import { chunk, editChunk, loadEditChunk as loadDetail } from "./load-edit-chunk.ts";
import { ProjectHeader } from "./project-header.tsx";
import { currentList } from "../lib/views.ts";
import { useQueryUrl } from "./query-url.ts";
import { shownList } from "./view-panel-state.ts";
import { ViewControls, ViewTabs } from "./view-tabs.tsx";
import { useSteadyIssue, useWalkAhead } from "./walk.ts";
import "./split-transition.ts";

// The issue pane brings Base UI's combobox and menu with floating-ui, kept out of the startup JS. It is fetched once
// the list has painted (the Service Worker precaches it too), so opening an issue does not wait for the network.
const IssueDetail = chunk("IssueDetail");

/** The open issue, for its property keys: one in the trash takes no edits, so they do nothing. */
function openIssueOf(): Issue | undefined {
  const key = routeIssue(router.route);
  return key ? store.issueByKey(key) : undefined;
}

export const ProjectIssues = observer(function ProjectIssues({ ws, project, open }: { ws: string; project: Project; open: Issue | null }) {
  const openId = open?.id ?? null;
  const pane = useSteadyIssue(open);
  useWalkAhead(project, openId);
  const ready = store.status === "ready";
  const view = shownList(project.id);
  const board = view.layout === "board";
  const phone = useIsPhone();
  // The address follows the list itself, not a new view's draft standing in for it while the panel is open.
  useQueryUrl(currentList(project.id), paths.issues(ws, project.key));
  const close = () => {
    listView.setPicker(null);
    router.push(paths.issues(ws, project.key));
  };
  const step = (by: number) => {
    const next = stepSelection(project, by);
    if (next) openIssue(ws, next, true);
  };

  useEffect(() => {
    if (ready) afterPaint(() => void loadDetail());
  }, [ready]);

  // Selection follows the open issue (deep links, back/forward), stays on it once it is closed, so the list shows where
  // you were, and resets on project switch.
  useEffect(() => {
    listView.select(null);
    listView.setColumn(null);
    listView.clearMarks();
  }, [project.id]);
  useEffect(() => {
    if (!openId) return;
    listView.select(openId);
    scrollToIssue(openId);
  }, [openId]);

  // Capture (useWindowKeys): a picker's Esc closes the picker, not the issue too.
  useWindowKeys((e) => {
    if (markKey(e, project)) return e.preventDefault();
    if (ignoredKey(e)) return;
    const opened = router.route.name === "listIssue";
    const keys = paneKeys(e, normKey(e), {
      move: (by) => {
        const next = stepSelection(project, by);
        if (next) focusIssue(next.id);
        // With an issue open the pane follows the selection, without filling the history.
        if (next && opened) openIssue(ws, next, true);
      },
      enter: () => {
        const sel = listView.selectedId && store.issues.get(listView.selectedId);
        if (!sel) return false;
        // The row opens its issue, and on the issue already open the focus goes into the pane.
        if (!(opened && openIssueOf()?.id === sel.id && editChunk()?.enterPane())) openIssue(ws, sel);
        return true;
      },
      // From the pane to the list, then from the list the issue closes.
      leave: opened ? () => editChunk()?.leavePane() || router.push(paths.issues(ws, project.key)) : undefined,
      issue: opened ? openIssueOf() : undefined,
    });
    if (keys) e.preventDefault();
  }, true);

  const list = <IssueList key={`${project.id}:${view.key}`} view={view} project={project} ws={ws} />;
  return (
    <SplitView
      label="Issues"
      open={!!open}
      fill
      // Over a third of the pane, up to 520px on a wide screen: beside the list the issue has no column of properties.
      width="clamp(300px, 36%, 520px)"
      list={
        <>
          {/* Beside an open issue the column keeps only the list: the header stays mounted, hidden. */}
          <div className="flex shrink-0 flex-col in-data-[split]:hidden">
            <ProjectHeader ws={ws} project={project}>
              {!phone && <ViewControls list={currentList(project.id)} project={project} labels />}
              <SettingsLink ws={ws} project={project} />
              <AddIssueButton />
            </ProjectHeader>
            <ViewTabs project={project} list={currentList(project.id)} />
          </div>
          {open && !board && <ColumnHead project={project} />}
          {!ready ? (
            <div className="p-6 text-ink-3">Loading…</div>
          ) : board ? (
            // The board narrows to the open card's column (PLNR-55); the whole board is kept as it is, hidden, so Esc
            // brings it back at the same scroll.
            <>
              <Activity mode={open ? "hidden" : "visible"}>
                <Suspense fallback={<div className="flex-1" />}>
                  <Board key={project.id} project={project} ws={ws} />
                </Suspense>
              </Activity>
              {open && (
                <Suspense fallback={<div className="flex-1" />}>
                  <BoardColumn key={project.id} project={project} ws={ws} openId={open.id} />
                </Suspense>
              )}
            </>
          ) : (
            list
          )}
        </>
      }
      detail={
        pane.issue && (
          <Suspense>
            <IssueDetail key={pane.issue.id} ws={ws} project={project} issue={pane.issue} inList walked={pane.walked} onStep={step} onClose={close} />
          </Suspense>
        )
      }
    />
  );
});

/** The column's own header while an issue is open: the project and how many issues the view shows. */
const ColumnHead = observer(function ColumnHead({ project }: { project: Project }) {
  return (
    <header className="flex h-(--topbar) shrink-0 items-center gap-2 border-b px-4">
      <span className="truncate text-label font-semibold">{project.name}</span>
      <span className="font-mono text-meta text-ink-3">{visibleIssues(shownList(project.id), project).length}</span>
    </header>
  );
});
