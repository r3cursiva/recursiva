// The quick-add title field (quick-add.tsx opens it). Lazy, with the sort keys: the startup JS has only the button.
import { TITLE_MAX, cleanName, type Issue } from "@rsva/schema/models";
import { cn } from "@rsva/ui/lib/utils";
import { useState } from "react";
import { presetFor, type GroupTarget } from "../lib/group-patch.ts";
import { keyForPosition } from "../lib/sort-keys.ts";
import { store } from "../store.ts";

export interface QuickAddProps {
  projectId: string;
  /** The group, plus the swimlane on a sub-grouped board; the new issue gets the values of all of them. */
  targets: readonly GroupTarget[];
  /** The group's last issue: the new one goes right after it, where the field is. */
  last: Issue | undefined;
  variant?: "row" | "card";
}

export function QuickAddForm({ projectId, targets, last, variant = "row", onClose }: QuickAddProps & { onClose: () => void }) {
  const [title, setTitle] = useState("");

  const submit = () => {
    const t = cleanName(title);
    if (!t) return;
    const { stateId, ...preset } = presetFor(targets, store.statesOf(projectId));
    if (!stateId) return;
    const sortOrder = keyForPosition(
      store.issuesOf(projectId).map((i) => i.sortOrder),
      last?.sortOrder || null,
      null,
    );
    store.createIssue(projectId, { ...preset, stateId, title: t, sortOrder });
    setTitle("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={cn(
        "flex items-center gap-2",
        variant === "row" ? "list-row h-(--row) bg-row-selected pr-6 pl-[30px]" : "rounded-md border border-rule-strong bg-panel p-2.5",
      )}
    >
      <input
        autoFocus
        aria-label="New issue title"
        placeholder="Issue title"
        value={title}
        maxLength={TITLE_MAX}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
        onBlur={() => !cleanName(title) && onClose()}
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink-3"
      />
      <span className="shrink-0 font-mono text-meta text-ink-3">⏎ to add</span>
    </form>
  );
}
