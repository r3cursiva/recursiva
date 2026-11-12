// Project › Archive: the archived issues and the trash (deleted ones), latest first, each with Restore. Plane keeps
// archived issues under the project's Archives; the trash is Linear's "Recently deleted". Both are filters of the pool:
// archived and deleted issues come with the snapshot, so the screen opens without a request. An issue in the trash is
// deleted for good from its row, after a yes in the row's ConfirmBar, or by the server after 30 days (RSVA-457).
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import type { IssueShelf } from "@rsva/sync";
import { TRASH_DAYS, type Issue, type Project } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Segmented } from "@rsva/ui/components/segmented";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { exactTime, timeAgo, useNow } from "../lib/time.ts";
import { store } from "../store.ts";
import { canRestore, issuePath, restoreIssue } from "./issue-actions.ts";
import { ConfirmBar, DeleteButton } from "./settings-fields.tsx";
import { ProjectHeader } from "./project-header.tsx";
import { onRowMenu, RowMenuButton } from "./row-menu.tsx";
import { StateGlyph } from "./state-glyph.tsx";
import { Link } from "../link.tsx";

type Shelf = Exclude<IssueShelf, "live">;

export const ProjectArchive = observer(function ProjectArchive({ ws, project }: { ws: string; project: Project }) {
  const [shelf, setShelf] = useState<Shelf>("archived");
  const issues = store.issuesOf(project.id, shelf);
  const options = [
    { value: "archived" as const, label: `Archived ${store.issuesOf(project.id, "archived").length}` },
    { value: "deleted" as const, label: `Trash ${store.issuesOf(project.id, "deleted").length}` },
  ];
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
      <ProjectHeader ws={ws} project={project} page="Archive" />
      <div className="flex flex-wrap items-center gap-3 px-6 pt-5 pb-3 max-md:px-4">
        <Segmented label="Show" variant="quiet" options={options} value={shelf} onChange={setShelf} />
        <p className="text-caption text-ink-3">
          {shelf === "archived"
            ? "Completed and cancelled issues put away from the lists."
            : `Deleted issues. Their creator or an admin can restore them; after ${TRASH_DAYS} days they are deleted for good.`}
        </p>
      </div>
      {issues.length === 0 ? (
        <div className="px-6 py-4 text-ink-3 max-md:px-4">{shelf === "archived" ? "Nothing archived." : "The trash is empty."}</div>
      ) : (
        <ul className="m-0 list-none border-t p-0">
          {issues.map((i) => (
            <ShelvedRow key={i.id} issue={i} at={(shelf === "archived" ? i.archivedAt : i.deletedAt)!} />
          ))}
        </ul>
      )}
    </div>
  );
});

const ShelvedRow = observer(function ShelvedRow({ issue, at }: { issue: Issue; at: string }) {
  const now = useNow();
  const [purging, setPurging] = useState(false);
  const state = store.states.get(issue.stateId);
  const href = issuePath(issue);
  const key = store.issueKey(issue);
  const purgeable = !!issue.deletedAt && store.mayDelete(issue);
  return (
    <li data-issue={issue.id} onContextMenu={onRowMenu} className="border-b border-rule-soft">
      <div className="group/row flex h-9 items-center gap-2.5 px-6 hover:bg-row-hover max-md:h-auto max-md:min-h-14 max-md:py-2 max-md:pr-2 max-md:pl-4 max-md:select-none">
        {state && <StateGlyph state={state} />}
        <Link href={href} className="flex min-w-0 flex-1 items-center gap-2.5 outline-none focus-visible:underline max-md:flex-col max-md:items-start max-md:gap-0.5">
          <span className="shrink-0 font-mono text-caption text-ink-3 max-md:order-1 max-md:text-id">{key}</span>
          <span className="truncate max-md:w-full max-md:text-[15px]">{issue.title}</span>
        </Link>
        <time dateTime={at} title={exactTime(at)} className="shrink-0 text-caption text-ink-3">
          {timeAgo(at, now)}
        </time>
        {canRestore(issue) && (
          <Button variant="ghost" size="sm" onClick={() => restoreIssue(issue)}>
            <ArrowCounterClockwiseIcon />
            Restore
          </Button>
        )}
        {purgeable && <DeleteButton name={key} hint="Delete permanently" open={purging} onToggle={() => setPurging(!purging)} />}
        <RowMenuButton />
      </div>
      {purging && (
        <div className="px-6 pb-2.5 max-md:px-4">
          <ConfirmBar
            action="Delete permanently"
            onCancel={() => setPurging(false)}
            onConfirm={() => {
              setPurging(false);
              store.purgeIssue(issue.id);
            }}
          >
            {`${key} goes for good, with its description, comments, links and files. Nothing brings it back.`}
          </ConfirmBar>
        </div>
      )}
    </li>
  );
});
