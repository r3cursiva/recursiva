// What a bulk action writes (PLNR-294): one change made to many issues, and what puts them back. Pure, so the bar
// (screens/bulk-bar.tsx) and its tests share it.
import type { IssueChange } from "@rsva/sync";
import type { Issue, IssueUpdate } from "@rsva/schema/models";

/** The fields a bulk action changes one value of. */
export type OneField = "stateId" | "priority" | "cycleId" | "parentId";
/** The lists it adds to and takes from. */
export type ListField = "labelIds" | "assigneeIds";

/** The value every issue has, or undefined when they differ: the picker then shows none as current. */
export function shared<F extends OneField>(issues: readonly Issue[], field: F): Issue[F] | undefined {
  const first = issues[0]?.[field];
  return issues.every((i) => i[field] === first) ? first : undefined;
}

/**
 * The values some issues have and others not (RSVA-303), as a picker's option values ("" for none): the picker marks them
 * with a dash. Empty when they all agree.
 */
export function mixedOne(issues: readonly Issue[], field: OneField): Set<string> {
  const values = new Set(issues.map((i) => String(i[field] ?? "")));
  return values.size > 1 ? values : new Set();
}

/** The items on some issue's list but not on every one's. */
export function mixedList(issues: readonly Issue[], field: ListField): Set<string> {
  const all = new Set(onAll(issues, field));
  return new Set(issues.flatMap((i) => i[field].filter((id) => !all.has(id))));
}

/** The items on every issue's list: the ones a list picker shows as checked. */
export function onAll(issues: readonly Issue[], field: ListField): string[] {
  const [head, ...rest] = issues;
  return head ? head[field].filter((id) => rest.every((i) => i[field].includes(id))) : [];
}

/** One value for all of them; the issues that have it already are left out. */
export function setAll<F extends OneField>(issues: readonly Issue[], field: F, value: Issue[F]): IssueChange[] {
  return issues.filter((i) => i[field] !== value).map((i) => ({ id: i.id, patch: { [field]: value } as IssueUpdate }));
}

/**
 * A list picker went from `before` (what onAll showed) to `after`: what was ticked is added to every issue, what was
 * unticked is taken off every issue, and each keeps the rest of its own list.
 */
export function changeLists(issues: readonly Issue[], field: ListField, before: readonly string[], after: readonly string[]): IssueChange[] {
  const added = after.filter((id) => !before.includes(id));
  const removed = new Set(before.filter((id) => !after.includes(id)));
  const out: IssueChange[] = [];
  for (const i of issues) {
    const list = [...i[field].filter((id) => !removed.has(id)), ...added.filter((id) => !i[field].includes(id))];
    if (list.length !== i[field].length || list.some((id, n) => id !== i[field][n])) out.push({ id: i.id, patch: { [field]: list } });
  }
  return out;
}

/** The fields of `changes` as each issue has them now: written back, they undo the act. */
export function undoOf(issues: readonly Issue[], changes: readonly IssueChange[]): IssueChange[] {
  const byId = new Map(issues.map((i) => [i.id, i]));
  return changes.flatMap(({ id, patch }) => {
    const issue = byId.get(id);
    if (!issue) return [];
    const back: Record<string, unknown> = {};
    for (const k of Object.keys(patch) as (keyof IssueUpdate)[]) {
      const v = issue[k as keyof Issue];
      back[k] = Array.isArray(v) ? [...v] : (v ?? null);
    }
    return [{ id, patch: back as IssueUpdate }];
  });
}
