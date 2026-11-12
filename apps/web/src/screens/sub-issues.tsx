// The issue panel's sub-issues, as in Plane: progress, one row per sub-issue (open it, change its state, take it off),
// "+" to create one with the parent preset or to adopt an existing issue of the project.
import { isClosedGroup, type Issue } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { observer } from "mobx-react-lite";
import { useRef, useState, type ReactElement } from "react";
import { lineage } from "../lib/issue-tree.ts";
import { store } from "../store.ts";
import { createIssue } from "./create-state.ts";
import { notice } from "./notice.ts";
import { LinkedIssueRow, PanelList, PanelPlus, PanelSection } from "./panel-section.tsx";
import { IssuePicker } from "./pickers.tsx";

/** On a phone a longer list shows this many, then "N more". */
const PHONE_SHOWN = 2;

/** "Create new" or "Add existing" under `trigger`, wherever that stands; the picker opens at it. */
export function AddSubIssue({ issue, trigger, align }: { issue: Issue; trigger: ReactElement; align: "start" | "end" }) {
  const [adding, setAdding] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger ref={anchor} render={trigger} />
        <DropdownMenuContent align={align} className="w-44">
          <DropdownMenuItem onClick={() => createIssue.show({ parentId: issue.id }, issue.projectId)}>Create new</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setAdding(true)}>Add existing</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* The menu closes as the picker opens; the picker is placed at the button it came from. */}
      {adding && (
        <IssuePicker
          open
          onOpenChange={(o) => !o && setAdding(false)}
          anchor={anchor}
          projectId={issue.projectId}
          // Not the issue, its parents (a loop) or the ones already under it.
          exclude={() => new Set([...lineage(issue.id, (id) => store.issues.get(id)), ...store.subIssuesOf(issue.id).map((s) => s.id)])}
          value={null}
          onChange={(id) => {
            store.updateIssue(id, { parentId: issue.id });
            setAdding(false);
          }}
          placeholder="Add an existing issue…"
        />
      )}
    </>
  );
}

export const SubIssues = observer(function SubIssues({ issue }: { issue: Issue }) {
  const subs = store.subIssuesOf(issue.id);
  const [all, setAll] = useState(false);
  const done = subs.filter((s) => isClosedGroup(store.states.get(s.stateId)?.group)).length;
  const started = subs.filter((s) => store.states.get(s.stateId)?.group === "started").length;
  const folded = !all && subs.length > PHONE_SHOWN + 1 ? subs.length - PHONE_SHOWN : 0;
  return (
    <PanelSection
      label="Sub-issues"
      empty={subs.length === 0}
      count={subs.length > 0 ? { text: `${done} / ${subs.length}`, title: `${done} of ${subs.length} done` } : null}
      after={
        subs.length > 0 && (
          <span aria-hidden className="flex h-[5px] w-[72px] gap-px overflow-hidden rounded-[3px] bg-rule-soft">
            <span className="bg-status-done" style={{ width: `${(done / subs.length) * 100}%` }} />
            <span className="bg-status-progress" style={{ width: `${(started / subs.length) * 100}%` }} />
          </span>
        )
      }
      action={<AddSubIssue issue={issue} align="end" trigger={<PanelPlus label="Add sub-issue" />} />}
    >
      {subs.length > 0 && (
        <PanelList>
          {subs.map((s, i) => (
            <LinkedIssueRow
              key={s.id}
              issue={s}
              removeLabel={(key) => `Remove ${key} from the sub-issues`}
              onRemove={() => {
                store.updateIssue(s.id, { parentId: null });
                notice.show(`${store.issueKey(s)} removed from the sub-issues`, () => store.updateIssue(s.id, { parentId: issue.id }));
              }}
              className={folded && i >= PHONE_SHOWN ? "max-md:hidden" : undefined}
            />
          ))}
        </PanelList>
      )}
      {folded > 0 && (
        <Button type="button" variant="ghost" className="self-start border-0 font-normal text-ink-3 max-md:h-8 max-md:px-0 max-md:text-[13px] md:hidden" onClick={() => setAll(true)}>
          {folded} more
        </Button>
      )}
    </PanelSection>
  );
});
