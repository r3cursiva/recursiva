// The create modal's draft ("draft saved" on the LedgerNewIssue artboard): one per workspace, kept in localStorage, so closing
// the panel by accident, or reloading, loses nothing. The last text typed wins. Signing out wipes it with the other
// `rsva:` keys (auth.ts).
import type { DocJSON, IssuePatch } from "@rsva/schema/models";
import { readLocal, removeLocal, writeLocal } from "../lib/local-storage.ts";
import type { Uploaded } from "../lib/upload.ts";
import { store } from "../store.ts";

export interface SavedDraft {
  projectId: string;
  title: string;
  description: DocJSON | null;
  fields: IssuePatch;
  files: Uploaded[];
}

const draftKey = (): string => `rsva:new-issue:${store.workspace?.slug ?? ""}`;

export const saveDraft = (draft: SavedDraft): void => writeLocal(draftKey(), draft);

export const dropDraft = (): void => removeLocal(draftKey());

/** The saved draft, without what has gone since it was written: a state, labels, a cycle or a parent that no longer exist. */
export function loadDraft(): SavedDraft | null {
  const draft = readLocal(draftKey()) as SavedDraft | null;
  if (!draft || !store.projects.get(draft.projectId)) return null;
  const { stateId, labelIds, cycleId, parentId, ...rest } = draft.fields;
  return {
    ...draft,
    fields: {
      ...rest,
      ...(stateId && store.states.get(stateId) ? { stateId } : {}),
      labelIds: (labelIds ?? []).filter((id) => store.labels.get(id)),
      cycleId: cycleId && store.cycles.get(cycleId) ? cycleId : null,
      parentId: parentId && store.issues.get(parentId) ? parentId : null,
    },
  };
}
