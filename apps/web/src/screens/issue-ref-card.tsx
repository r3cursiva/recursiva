// The card of an issue key under the pointer (issue-ref.ts): state, key and title, as Plane shows on hovering an issue
// link. It reads the local store, so it opens without a request.
import { priorityName } from "@rsva/schema/models";
import { PriorityIcon } from "@rsva/ui/components/priority-icon";
import { PreviewCard, PreviewCardContent } from "@rsva/ui/components/preview-card";
import { UserAvatarStack } from "@rsva/ui/components/user-avatar";
import { faceOf } from "../lib/face.ts";
import { observer } from "mobx-react-lite";
import { store } from "../store.ts";
import { holdIssueCard, issueRefHover, releaseIssueCard } from "./issue-ref.ts";
import { StateGlyph } from "./state-glyph.tsx";

const onOpenChange = (open: boolean) => {
  if (!open) issueRefHover.close();
};

export const IssueRefCard = observer(function IssueRefCard() {
  const cur = issueRefHover.current;
  const issue = cur ? store.issueByKey(cur.key) : undefined;
  if (!cur || !issue) return null;
  const state = store.states.get(issue.stateId);
  const assignees = issue.assigneeIds.map((id) => faceOf(id));
  return (
    <PreviewCard open onOpenChange={onOpenChange}>
      <PreviewCardContent
        anchor={cur.anchor}
        className="flex flex-col gap-1.5"
        onPointerEnter={holdIssueCard}
        onPointerLeave={releaseIssueCard}
      >
        <div className="flex items-center gap-1.5 text-ink-3">
          {state && <StateGlyph state={state} />}
          <span className="font-mono text-meta">{store.issueKey(issue)}</span>
          {state && <span className="truncate text-meta">{state.name}</span>}
        </div>
        <div className="line-clamp-3 text-label font-medium text-ink">{issue.title}</div>
        {(issue.priority > 0 || assignees.length > 0) && (
          <div className="flex items-center gap-1.5 text-ink-3">
            {issue.priority > 0 && (
              <>
                <PriorityIcon priority={issue.priority} />
                <span className="text-meta">{priorityName(issue.priority)}</span>
              </>
            )}
            {assignees.length > 0 && (
              <span className="ml-auto">
                <UserAvatarStack people={assignees} />
              </span>
            )}
          </div>
        )}
      </PreviewCardContent>
    </PreviewCard>
  );
});
