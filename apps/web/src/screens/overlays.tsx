// Everything that floats over the screens: the row popup (pickers and menu), the create modal, the command palette, New
// project, the card of an issue key under the pointer and short confirmations. The first five live in one lazy chunk (edit-chunk.ts),
// prefetched once the list has painted, so their Base UI code stays out of the startup JS and the first open does not
// wait for the network.
import type { Issue } from "@rsva/schema/models";
import { Toast } from "@rsva/ui/components/toast";
import { keys } from "@rsva/ui/lib/keys";
import { reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { Suspense, useEffect } from "react";
import { isPhone } from "../lib/phone.ts";
import { router } from "../router.ts";
import { afterPaint } from "../perf.ts";
import { store } from "../store.ts";
import { createIssue } from "./create-state.ts";
import { openIssue } from "./issue-actions.ts";
import { issueRefHover, watchIssueRefs } from "./issue-ref.ts";
import { notice } from "./notice.ts";
import { newProject, palette, shortcutSheet } from "./palette-state.ts";
import { watchLongPress } from "./row-menu.tsx";
import { rowPopup } from "./row-popup.ts";
import { listView } from "./list-view.ts";
import { viewPanel } from "./view-panel-state.ts";
import { chunk, loadEditChunk } from "./load-edit-chunk.ts";

const RowPopupHost = chunk("RowPopupHost");
const CreateIssueModal = chunk("CreateIssueModal");
const CommandPalette = chunk("CommandPalette");
const NewProjectDialog = chunk("NewProjectDialog");
const ShortcutSheet = chunk("ShortcutSheet");
const IssueRefCard = chunk("IssueRefCard");
const ViewPanel = chunk("ViewPanel");
const BulkBar = chunk("BulkBar");
/** The screens with a list or board of issues to mark in. */
const LISTS = new Set<string>(["issues", "listIssue", "view", "cycle"]);

export const Overlays = observer(function Overlays() {
  const ready = store.status === "ready";
  useEffect(() => {
    if (ready) afterPaint(() => void loadEditChunk());
  }, [ready]);
  useEffect(watchIssueRefs, []);
  useEffect(watchLongPress, []);
  // Marks belong to the list they were made in: leaving the lists drops them (PLNR-294). While some are marked, every
  // row shows its box and a phone's corner button gives way to the bar ([data-marking] on the root).
  useEffect(() => reaction(() => router.route.name, (name) => LISTS.has(name) || listView.clearMarks()), []);
  useEffect(() => reaction(() => listView.marked.size > 0, (on) => document.documentElement.toggleAttribute("data-marking", on)), []);
  const undoable = !!notice.undo;
  useEffect(() => {
    if (!undoable) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
      // Text fields keep their own undo.
      if (e.target instanceof Element && e.target.closest("input, textarea, [contenteditable=true], [contenteditable='']")) return;
      e.preventDefault();
      notice.runUndo();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [undoable]);
  const created = notice.issueId ? store.issues.get(notice.issueId) : undefined;
  return (
    <Suspense>
      {rowPopup.current && <RowPopupHost />}
      {createIssue.open && <CreateIssueModal />}
      {palette.open && <CommandPalette />}
      {newProject.open && <NewProjectDialog />}
      {shortcutSheet.open && <ShortcutSheet />}
      {issueRefHover.current && <IssueRefCard />}
      {(viewPanel.open || viewPanel.leaving) && <ViewPanel key={viewPanel.run} />}
      {listView.marked.size > 0 && <BulkBar />}
      {notice.text && (
        <Toast
          key={notice.n}
          title={created && isPhone() ? "created" : notice.text}
          duration={notice.undo ? 5000 : notice.code || created ? 3200 : 2500}
          onClose={clearNotice}
          {...(notice.undo ? { action: { label: "Undo", kbd: keys("mod", "Z"), onClick: undoNotice } } : {})}
          {...(notice.code ? { code: notice.code } : {})}
          {...(created ? { lead: store.issueKey(created), action: { label: "Open", onClick: () => openCreated(created) } } : {})}
          {...(notice.failed ? { variant: "error" as const, description: notice.failed.detail, field: notice.failed } : {})}
        />
      )}
    </Suspense>
  );
});

const clearNotice = () => notice.clear();
const openCreated = (issue: Issue) => {
  notice.clear();
  openIssue(issue);
};
const undoNotice = () => notice.runUndo();
