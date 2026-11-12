// The actions on one issue: one list for the row and card menu, the "…" of the issue panel and the ⌘K palette, so they
// never differ. Archive and Delete show only when they can apply, Restore only for an issue it can bring back.
import { ArchiveIcon, ArrowCounterClockwiseIcon, ArrowSquareOutIcon, ArrowSquareRightIcon, CheckSquareIcon, CopyIcon, CopySimpleIcon, GitBranchIcon, LinkIcon, SidebarSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { pinRef } from "@rsva/protocol";
import { isLiveIssue, type Issue } from "@rsva/schema/models";
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from "@rsva/ui/components/dropdown-menu";
import { keys } from "@rsva/ui/lib/keys";
import { observer } from "mobx-react-lite";
import type { ReactNode } from "react";
import { store } from "../store.ts";
import { listView } from "./list-view.ts";
import { pinLabel, togglePin } from "./pin-actions.ts";
import { FavoriteStar } from "./favorite-button.tsx";
import {
  archiveIssue,
  canArchive,
  canMove,
  canRestore,
  copyBranchHint,
  copyIssue,
  copyIssueBranch,
  copyIssueKey,
  copyIssueLink,
  copyKeyHint,
  deleteIssue,
  issueBranch,
  markedOrOne,
  moveHint,
  openIssue,
  openIssueInNewTab,
  restoreIssue,
  showMove,
} from "./issue-actions.ts";

export interface IssueAction {
  id: string;
  label: string;
  icon: ReactNode;
  /** A shortcut, shown at the right. */
  hint?: string;
  destructive?: boolean;
  disabled?: boolean;
  run: () => void;
}

/** Make a copy, then Archive and Delete, or Restore for an archived or deleted issue. An issue without a number waits. */
export function issueActions(issue: Issue): IssueAction[] {
  const pending = issue.number === 0;
  const out: IssueAction[] = [{ id: "copy", label: "Make a copy", icon: <CopySimpleIcon />, disabled: pending, run: () => void copyIssue(issue) }];
  if (issue.archivedAt || issue.deletedAt) {
    if (canRestore(issue)) out.push({ id: "restore", label: "Restore", icon: <ArrowCounterClockwiseIcon />, run: () => restoreIssue(issue) });
    return out;
  }
  if (canArchive(issue)) out.push({ id: "archive", label: "Archive", icon: <ArchiveIcon />, disabled: pending, run: () => archiveIssue(issue) });
  if (store.mayDelete(issue))
    out.push({ id: "delete", label: "Delete", icon: <TrashIcon />, hint: keys("mod", "⌫"), destructive: true, disabled: pending, run: () => deleteIssue(issue) });
  return out;
}

export const IssueMenuItems = observer(function IssueMenuItems({ issue, open = true }: { issue: Issue; open?: boolean }) {
  const [copy, ...lifecycle] = issueActions(issue);
  return (
    <>
      {open && (
        <>
          <DropdownMenuItem onClick={() => openIssue(issue)}>
            <SidebarSimpleIcon />
            Open
            <DropdownMenuShortcut>↵</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openIssueInNewTab(issue)}>
            <ArrowSquareOutIcon />
            Open in new tab
          </DropdownMenuItem>
          {/* For a bulk action (PLNR-294); on a phone the way in, after which a tap marks. */}
          <DropdownMenuItem onClick={() => listView.toggleMark(issue.id)}>
            <CheckSquareIcon />
            {listView.marked.has(issue.id) ? "Deselect" : "Select"}
            <DropdownMenuShortcut>X</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem onClick={() => copyIssueLink(issue)}>
        <LinkIcon />
        Copy link
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => copyIssueBranch(issue)} disabled={issue.number === 0}>
        <GitBranchIcon />
        <span className="min-w-0">
          Copy branch name
          {/* A phone's sheet says which name, as the hover does elsewhere. */}
          <span className="block truncate font-mono text-[11.5px] text-ink-3 md:hidden">{issueBranch(issue)}</span>
        </span>
        <DropdownMenuShortcut>{copyBranchHint}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => copyIssueKey(issue)} disabled={issue.number === 0}>
        <CopyIcon />
        Copy key
        <DropdownMenuShortcut>{copyKeyHint}</DropdownMenuShortcut>
      </DropdownMenuItem>
      {isLiveIssue(issue) && issue.number > 0 && (
        <DropdownMenuItem onClick={() => togglePin(pinRef("issue", issue.id), store.issueKey(issue))}>
          <FavoriteStar on={store.views.pinned(pinRef("issue", issue.id))} />
          {pinLabel(pinRef("issue", issue.id))}
        </DropdownMenuItem>
      )}
      <ActionItem a={copy!} />
      {canMove(issue) && (
        <DropdownMenuItem onClick={() => showMove(markedOrOne(issue))}>
          <ArrowSquareRightIcon />
          Move to project…
          <DropdownMenuShortcut>{moveHint}</DropdownMenuShortcut>
        </DropdownMenuItem>
      )}
      {lifecycle.length > 0 && <DropdownMenuSeparator />}
      {lifecycle.map((a) => (
        <ActionItem key={a.id} a={a} />
      ))}
    </>
  );
});

function ActionItem({ a }: { a: IssueAction }) {
  return (
    <DropdownMenuItem onClick={a.run} disabled={a.disabled} {...(a.destructive ? { variant: "destructive" as const } : {})}>
      {a.icon}
      {a.label}
      {a.hint && <DropdownMenuShortcut>{a.hint}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  );
}
