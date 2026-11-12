// The one lazy chunk: everything beyond the list. The issue pane, the board, the overlays (row pickers and menu, create
// modal, palette; see overlays.tsx), the quick-add form and the project and workspace settings share the pickers, Base UI's popups and
// the sort keys.
//
// Separate chunks were measured first (issue pane, board, overlays, pickers, sort keys: five lazy files). The Service Worker
// precaches every chunk on the first visit anyway, so splitting saved no bytes and cost four requests; one chunk, fetched
// after the list has painted, is ready before the first click.
import "./sheet-drag.ts";
// Tab between areas and the arrows inside them (PLNR-304): here, not in the startup JS, as the chunk is loaded right
// after the first paint, before a key is pressed; until then Tab is the browser's.
import { watchAreas } from "../lib/areas.ts";
watchAreas();
export { enterPane, leavePane } from "../lib/areas.ts";
export { Board, BoardColumn } from "./board.tsx";
export { BulkBar, deleteMarked } from "./bulk-bar.tsx";
export { CommandPalette } from "./command-palette.tsx";
export { CreateIssueModal } from "./create-issue-modal.tsx";
export { copyIssueBranch, copyIssueKey, deleteIssue, showMove } from "./issue-actions.ts";
export { IssueDetail, IssuePage } from "./issue-detail.tsx";
export { ProjectArchive } from "./project-archive.tsx";
export { ProjectHistory } from "./project-history.tsx";
// A project's home and its widgets (RSVA-508, ADR 0053).
export { ProjectHome } from "./project-home.tsx";
// Cycles (PLNR-63): the project's cycles and one cycle's page, with their dialogs.
export { CyclePage } from "./cycle-page.tsx";
export { ProjectCycles } from "./cycles-page.tsx";
export { ProjectSettings } from "./project-settings.tsx";
// The navigation's menus and pages (PLNR-58).
export { AllProjects } from "./all-projects.tsx";
export { NewProjectDialog } from "./new-project-dialog.tsx";
export { ShortcutSheet } from "./shortcut-sheet.tsx";
export { ProjectMenu } from "./project-menu.tsx";
export { ProjectPagesMenu } from "./project-pages-menu.tsx";
export { attachPinDrag, attachProjectDrag } from "./project-actions.ts";
// The sidebar's groups of projects (RSVA-566).
export { GroupMenu, GroupNameField, GroupPicker, ProjectsAddMenu, QuietMenu, StripMenu } from "./group-menus.tsx";
export { QuickAddForm } from "./quick-add-form.tsx";
export { RowPopupHost } from "./row-popup-host.tsx";
export { WorkspaceMenu } from "./workspace-menu.tsx";
export { WorkspaceSettings } from "./workspace-settings.tsx";
// Members, invites and new workspaces (ADR 0011): opened rarely, and the invite page works signed out too.
export { CreateWorkspace } from "./create-workspace.tsx";
export { JoinScreen } from "./join-screen.tsx";
export { EmailRevert } from "./email-revert.tsx";
export { NoWorkspace } from "./no-workspace.tsx";
export { AccountMenu } from "./account-menu.tsx";
export { ConnectionPanel } from "./connection-panel.tsx";
export { Inbox } from "./inbox.tsx";
// The card of an issue key under the pointer (PLNR-43).
export { IssueRefCard } from "./issue-ref-card.tsx";
export { MoreMenu } from "./more-menu.tsx";
export { MyWork } from "./my-work.tsx";
// Saved views (PLNR-74): the View panel, the Display popover, the menu, the actions behind the tab row's keys, the views
// page and a view's own page, and the views' icons (view-icon.tsx draws them once this chunk is here).
export { moveTab } from "./view-actions.ts";
export { DisplayMenu } from "./view-panel-display.tsx";
export { ViewIconGlyph } from "./view-icons.tsx";
export { ViewMenu } from "./view-menu.tsx";
export { ViewPanel } from "./view-panel.tsx";
export { ViewsIndex } from "./views-index.tsx";
export { WorkspaceView } from "./workspace-view.tsx";
// What most visits never show (RSVA-497): drawn through chunkWhen, only while there is something to show.
export { Rejection } from "./rejection.tsx";
export { UpdateButton, UpdateCard } from "./update-card.tsx";
