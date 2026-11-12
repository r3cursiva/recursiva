// The issue's key in a header, as a button that copies it (PLNR-73): the same action as "Copy key" in the menu and ⌘.,
// with the same toast. A plain button rather than a hover-only copy icon beside the key: nothing in the header shifts.
import type { Issue } from "@rsva/schema/models";
import { Button } from "@rsva/ui/components/button";
import { Hint } from "@rsva/ui/components/tooltip";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { store } from "../store.ts";
import { copyIssueKey, copyKeyHint } from "./issue-actions.ts";

export const CopyKeyButton = observer(function CopyKeyButton({ issue, className }: { issue: Issue; className?: string }) {
  const key = store.issueKey(issue);
  // An issue the server has not numbered yet has no key to copy; it stays readable, as "Saving…" already says why.
  return (
    <Hint label={`Copy key (${copyKeyHint})`}>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Copy key ${key}`}
        disabled={issue.number === 0}
        onClick={() => copyIssueKey(issue)}
        className={cn("-mx-1.5 px-1.5 font-mono disabled:opacity-100", className)}
      >
        {key}
      </Button>
    </Hint>
  );
});
