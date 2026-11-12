// The bar of a bulk action (PLNR-294): over the list or board while issues are marked, after Linear's. One picker per
// property, each opened by its button or its key (S, P, A, L, C), Parent (RSVA-303), Move to another project (M,
// PLNR-448), and the marked issues' Archive and Delete. A value only some of them have shows a dash in its picker
// (RSVA-303). Every act is one write (store.updateIssues) and one Undo; a list picker's ticks while it is open are one act.
import { ArchiveIcon, DotsThreeIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { isLiveIssue, type Issue } from "@rsva/schema/models";
import type { IssueChange } from "@rsva/sync";
import { Button } from "@rsva/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { KeyHint } from "@rsva/ui/components/kbd";
import { Hint } from "@rsva/ui/components/tooltip";
import { keys } from "@rsva/ui/lib/keys";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { changeLists, mixedList, mixedOne, onAll, setAll, shared, undoOf, type ListField, type OneField } from "../lib/bulk.ts";
import { subtree } from "../lib/issue-tree.ts";
import { store } from "../store.ts";
import { canArchive, moveHint, showMove } from "./issue-actions.ts";
import { ignoredKey, listView } from "./list-view.ts";
import { notice } from "./notice.ts";
import { AssigneesPicker, CyclePicker, IssuePicker, LabelsPicker, PriorityPicker, StatePicker } from "./pickers.tsx";
import { plural } from "@rsva/schema/util";

type Kind = "state" | "priority" | "assignees" | "labels" | "cycle" | "parent";
const KEYS: Record<string, Kind> = { s: "state", p: "priority", a: "assignees", l: "labels", c: "cycle" };
const FIELD: Record<Kind, OneField | ListField> = { state: "stateId", priority: "priority", assignees: "assigneeIds", labels: "labelIds", cycle: "cycleId", parent: "parentId" };

const items = (n: number) => plural(n, "issue");

/** The marked issues that are still in the lists: one deleted or archived meanwhile drops out. */
function markedIssues(): Issue[] {
  const out: Issue[] = [];
  for (const id of listView.marked) {
    const i = store.issues.get(id);
    if (i && isLiveIssue(i)) out.push(i);
  }
  return out;
}

/** Writes `changes` and offers to put back what `undo` holds. */
function act(text: string, changes: IssueChange[], undo: IssueChange[]): void {
  if (!changes.length) return;
  store.updateIssues(changes);
  notice.show(text, () => store.updateIssues(undo));
}

function archiveMarked(): void {
  const issues = markedIssues();
  const ok = issues.filter(canArchive);
  if (!ok.length) return notice.show("Only completed or cancelled issues can be archived");
  const at = new Date().toISOString();
  const changes = ok.map((i) => ({ id: i.id, patch: { archivedAt: at } }));
  act(ok.length === issues.length ? `${items(ok.length)} archived` : `${ok.length} of ${items(issues.length)} archived: only completed or cancelled ones are`, changes, undoOf(ok, changes));
  listView.clearMarks();
}

export function deleteMarked(): void {
  const issues = markedIssues();
  const ok = issues.filter((i) => store.mayDelete(i));
  if (!ok.length) return notice.show("Only the creator or an admin can delete these issues");
  const at = new Date().toISOString();
  const changes = ok.map((i) => ({ id: i.id, patch: { deletedAt: at } }));
  act(ok.length === issues.length ? `${items(ok.length)} moved to the trash` : `${ok.length} of ${items(issues.length)} moved to the trash: the rest are not yours to delete`, changes, undoOf(ok, changes));
  listView.clearMarks();
}

export const BulkBar = observer(function BulkBar() {
  const issues = markedIssues();
  const [open, setOpen] = useState<Kind | null>(null);
  // What the open picker's field was when it opened: Undo puts that back, however many ticks there were.
  const before = useRef<IssueChange[]>([]);
  const projects = new Set(issues.map((i) => i.projectId));
  // States, labels and cycles belong to a project: across projects those pickers have nothing to offer.
  const projectId = projects.size === 1 ? [...projects][0]! : null;

  const show = (kind: Kind | null) => {
    if (kind) {
      const field = FIELD[kind];
      before.current = issues.map((i) => ({ id: i.id, patch: { [field]: Array.isArray(i[field]) ? [...(i[field] as string[])] : i[field] } }));
    }
    setOpen(kind);
  };
  const shell = (kind: Kind, label: string, key?: string) => {
    const off = kind !== "priority" && kind !== "assignees" && !projectId;
    const field = FIELD[kind];
    return {
      open: open === kind,
      onOpenChange: (o: boolean) => show(o ? kind : null),
      // Only while open: the bar re-renders on every change to a marked issue.
      ...(open === kind ? { mixed: field === "labelIds" || field === "assigneeIds" ? mixedList(issues, field) : mixedOne(issues, field) } : {}),
      trigger: (
        <Button variant="ghost" size="sm" disabled={off} title={off ? `${label}: the issues are in several projects` : key ? `${label} (${key})` : label}>
          {label}
        </Button>
      ),
    };
  };
  const one = <F extends OneField>(field: F, what: string) => (value: Issue[F]) => {
    act(`${what} of ${items(issues.length)} changed`, setAll(issues, field, value), before.current);
    setOpen(null);
  };
  const list = (field: ListField, what: string) => (after: string[]) => act(`${what} of ${items(issues.length)} changed`, changeLists(issues, field, onAll(issues, field), after), before.current);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || ignoredKey(e) || open) return;
      if (e.key === "Escape") listView.clearMarks();
      else if (!e.shiftKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === "m") showMove(issues);
      else if (!e.shiftKey && KEYS[e.key.toLowerCase()] && (projectId || ["p", "a"].includes(e.key.toLowerCase()))) show(KEYS[e.key.toLowerCase()]!);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  if (!issues.length) return null;
  return (
    <div
      role="toolbar"
      aria-label="Bulk actions"
      className="fixed bottom-16 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-(--float-radius) border bg-panel p-1 shadow-toast no-scrollbar animate-in fade-in-0 slide-in-from-bottom-2 max-md:right-4 max-md:left-4 max-md:translate-x-0 max-md:bottom-[calc(var(--tabbar)+var(--safe-bottom)+64px)]"
    >
      <span className="px-2 text-label whitespace-nowrap tabular-nums">{issues.length} selected</span>
      <Hint label={<KeyHint label="Clear the selection" keys="Esc" />}>
        <Button variant="ghost" size="icon-sm" aria-label="Clear the selection" onClick={() => listView.clearMarks()}>
          <XIcon />
        </Button>
      </Hint>
      <span className="mx-1 h-5 w-px bg-rule" />
      {projectId ? (
        <StatePicker {...shell("state", "Status", "S")} projectId={projectId} value={shared(issues, "stateId") ?? null} onChange={one("stateId", "State")} />
      ) : (
        shell("state", "Status", "S").trigger
      )}
      <PriorityPicker {...shell("priority", "Priority", "P")} value={shared(issues, "priority") ?? -1} onChange={one("priority", "Priority")} />
      <AssigneesPicker {...shell("assignees", "Assignees", "A")} value={onAll(issues, "assigneeIds")} onChange={list("assigneeIds", "Assignees")} />
      {projectId ? (
        <>
          <LabelsPicker {...shell("labels", "Labels", "L")} projectId={projectId} value={onAll(issues, "labelIds")} onChange={list("labelIds", "Labels")} />
          <CyclePicker {...shell("cycle", "Cycle", "C")} projectId={projectId} value={shared(issues, "cycleId") ?? null} onChange={one("cycleId", "Cycle")} />
          {/* A parent of the same project, as in the issue pane; never one of the marked issues or below them. */}
          <IssuePicker
            {...shell("parent", "Parent")}
            projectId={projectId}
            exclude={() => new Set(issues.flatMap((i) => [...subtree(i.id, (id) => store.subIssuesOf(id, true))]))}
            value={shared(issues, "parentId") ?? null}
            onChange={(id) => one("parentId", "Parent")(id || null)}
            placeholder="Set parent…"
            clear="No parent"
          />
        </>
      ) : (
        <>
          {shell("labels", "Labels", "L").trigger}
          {shell("cycle", "Cycle", "C").trigger}
          {shell("parent", "Parent").trigger}
        </>
      )}
      {/* To another project (PLNR-448): the palette's project page, which asks about sub-issues left out. */}
      <Button variant="ghost" size="sm" title={`Move to project (M, ${moveHint})`} onClick={() => showMove(issues)}>
        Move
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More bulk actions" />}>
          <DotsThreeIcon weight="bold" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={archiveMarked}>
            <ArchiveIcon />
            Archive
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={deleteMarked}>
            <TrashIcon />
            Delete
            <DropdownMenuShortcut>{keys("mod", "⌫")}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});
