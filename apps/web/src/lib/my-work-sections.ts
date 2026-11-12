// My work's groups as the screen lays them out: which are folded, kept in the account settings (`myWork`), the same on
// every device (@rsva/protocol/my-work). The viewer's own sections and Customize went (owner 2026-11-11).
import { DEFAULT_FOLDED, GROUPS, myWorkFolds, type GroupId, type MyWorkSection } from "@rsva/protocol/my-work";
import { account } from "../account.ts";

const folded = (): GroupId[] => myWorkFolds(account.settings.myWork ?? null);

/** The groups in their order, as saved. */
export const groupSections = (): MyWorkSection[] => {
  const set = new Set(folded());
  return GROUPS.map((g) => ({ id: g.id, kind: g.id, title: "", folded: set.has(g.id) }));
};

/** Folds or unfolds a group: written at once, as the viewer expects it on their other devices; a refusal says why. */
export function toggleFolded(id: string, failed: (e: unknown) => void, fold?: boolean): void {
  const now = new Set(folded());
  const was = now.has(id as GroupId);
  if (!GROUPS.some((g) => g.id === id) || (fold !== undefined && was === fold)) return;
  if (fold ?? !was) now.add(id as GroupId);
  else now.delete(id as GroupId);
  const next = GROUPS.map((g) => g.id).filter((g) => now.has(g));
  const same = next.length === DEFAULT_FOLDED.length && DEFAULT_FOLDED.every((g) => now.has(g));
  account.update({ myWork: same ? null : next }).catch(failed);
}
