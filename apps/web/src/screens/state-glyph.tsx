// A workflow state's glyph: the started group's stage (progress, review, approved) comes from the state's position
// (startedStage in packages/schema, PLNR-24).
import { startedStage, type Issue, type StartedStage, type WorkflowState } from "@rsva/schema/models";
import { StateIcon } from "@rsva/ui/components/state-icon";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { store } from "../store.ts";

function stateStage(state: WorkflowState): StartedStage | undefined {
  if (state.group !== "started") return undefined;
  return startedStage(store.statesOf(state.projectId), state.id) ?? "progress";
}

export function StateGlyph({ state, className }: { state: WorkflowState; className?: string }) {
  const stage = stateStage(state);
  return <StateIcon group={state.group} {...(stage ? { stage } : {})} {...(className ? { className } : {})} />;
}

/** The glyph of the state an issue is in. */
export function IssueStateGlyph({ issue }: { issue: Issue }) {
  const state = store.states.get(issue.stateId);
  return state ? <StateGlyph state={state} /> : null;
}

/** An issue as a line of a cycle's lists: its state's glyph, key and title. */
export const IssueLine = observer(function IssueLine({ issue, titleClassName }: { issue: Issue; titleClassName?: string }) {
  return (
    <>
      <IssueStateGlyph issue={issue} />
      <span className="font-mono text-meta text-ink-3">{store.issueKey(issue)}</span>
      <span className={cn("truncate", titleClassName)}>{issue.title}</span>
    </>
  );
});
