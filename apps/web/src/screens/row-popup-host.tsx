// The one popup of the list and the board (see row-popup.ts): the picker of the clicked chip, or the row menu.
import type { Issue } from "@rsva/schema/models";
import { DropdownMenu, DropdownMenuContent } from "@rsva/ui/components/dropdown-menu";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { finishDate } from "../lib/date-write.ts";
import { store } from "../store.ts";
import { IssueMenuItems } from "./issue-menu.tsx";
import { DatePopup, DatePresetMenu } from "./date-calendar.tsx";
import { AssigneesPicker, CyclePicker, LabelsPicker, PriorityPicker, StatePicker } from "./pickers.tsx";
import { rowPopup, type RowPopupState } from "./row-popup.ts";

const onOpenChange = (open: boolean) => {
  if (!open) rowPopup.close();
};

export const RowPopupHost = observer(function RowPopupHost() {
  const p = rowPopup.current;
  const issue = p ? store.issues.get(p.issueId) : undefined;
  if (!p || !issue) return null;
  return <Popup key={`${p.kind}:${p.issueId}`} p={p} issue={issue} />;
});

const Popup = observer(function Popup({ p, issue }: { p: RowPopupState; issue: Issue }) {
  const shell = { open: true, onOpenChange, anchor: p.anchor };
  const id = issue.id;
  switch (p.kind) {
    case "state":
      return <StatePicker {...shell} projectId={issue.projectId} value={issue.stateId} onChange={(stateId) => store.updateIssue(id, { stateId })} />;
    case "priority":
      return <PriorityPicker {...shell} value={issue.priority} onChange={(priority) => store.updateIssue(id, { priority })} />;
    case "assignees":
      return <AssigneesPicker {...shell} value={issue.assigneeIds} onChange={(assigneeIds) => store.updateIssue(id, { assigneeIds })} />;
    case "labels":
      return (
        <LabelsPicker {...shell} projectId={issue.projectId} value={issue.labelIds} onChange={(labelIds) => store.updateIssue(id, { labelIds })} />
      );
    case "cycle":
      return <CyclePicker {...shell} projectId={issue.projectId} value={issue.cycleId} onChange={(cycleId) => store.updateIssue(id, { cycleId })} />;
    case "startDate":
    case "dueDate":
      return <DateCellPopup issue={issue} field={p.kind} anchor={p.anchor} />;
    case "menu":
      return <IssueMenu issue={issue} anchor={p.anchor} />;
  }
});

/**
 * A date cell's popup: the calendar, or for a due date the quick dates of the issue panel's chip first (PLNR-340), whose
 * Pick a date turns the popup into the calendar at the same cell.
 */
const DateCellPopup = observer(function DateCellPopup({ issue, field, anchor }: { issue: Issue; field: "startDate" | "dueDate"; anchor: RowPopupState["anchor"] }) {
  const [calendar, setCalendar] = useState(field === "startDate");
  const close = () => rowPopup.close();
  const write = (day: string | null) => store.updateIssue(issue.id, { [field]: day });
  if (calendar) return <DatePopup name={field === "startDate" ? "Start date" : "Due date"} anchor={anchor} value={issue[field]} onChange={write} onClose={close} />;
  return <DatePresetMenu projectId={issue.projectId} cycleId={issue.cycleId} anchor={anchor} onClose={close} onPick={(day) => finishDate(issue[field], day, close, write)} onCalendar={() => setCalendar(true)} />;
});

/** Plane's row menu: open, copy, archive, delete (issue-menu.tsx). */
function IssueMenu({ issue, anchor }: { issue: Issue; anchor: RowPopupState["anchor"] }) {
  return (
    <DropdownMenu open onOpenChange={onOpenChange}>
      <DropdownMenuContent anchor={anchor} className="w-52">
        <IssueMenuItems issue={issue} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
