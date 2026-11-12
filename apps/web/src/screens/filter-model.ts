// The Filter as the View panel shows it: which keys filter, value names, the due-date presets.
import type { Filter, QueryContext } from "@rsva/query";
import { priorityName } from "@rsva/schema/models";

export type ListKey = "project" | "state" | "stateGroup" | "priority" | "assignee" | "label" | "createdBy" | "delegate" | "parent" | "is" | "has";
export type DateKey = "startDate" | "dueDate" | "createdAt" | "updatedAt" | "completedAt";
export type FilterKey = ListKey | DateKey;

/** Menu order, as in Plane's filter list. */
const MENU_KEYS: readonly FilterKey[] = ["project", "priority", "state", "stateGroup", "assignee", "createdBy", "delegate", "label", "parent", "is", "has", "startDate", "dueDate", "createdAt", "updatedAt", "completedAt"];
const LIST_KEYS = new Set<FilterKey>(["project", "state", "stateGroup", "priority", "assignee", "label", "createdBy", "delegate", "parent", "is", "has"]);
const isListKey = (k: FilterKey): k is ListKey => LIST_KEYS.has(k);

/** Date presets each date filter offers in the menu; anything else is typed as a query (due:2026-10-01..2026-10-31). */
export const DATE_MENU: Record<DateKey, readonly string[]> = {
  dueDate: ["<today", "today", "next-7-days", "next-2-weeks", "next-30-days", "this-month", "none"],
  startDate: ["today", "last-7-days", "next-7-days", "next-2-weeks", "none"],
  createdAt: ["today", "yesterday", "last-7-days", "last-30-days"],
  updatedAt: ["today", "yesterday", "last-7-days", "last-30-days"],
  completedAt: ["today", "yesterday", "last-7-days", "last-30-days"],
};

export const STATE_GROUP_LABELS: Record<string, string> = {
  backlog: "Backlog",
  unstarted: "Unstarted",
  started: "Started",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** A value of a list key as people read it. */
export function valueName(key: ListKey, v: string | number, ctx: QueryContext): string {
  switch (key) {
    case "project":
      return ctx.projects?.get(v as string)?.name ?? "Unknown project";
    case "priority":
      return priorityName(v as number);
    case "stateGroup":
      return STATE_GROUP_LABELS[v as string] ?? String(v);
    case "state":
      return ctx.states.get(v as string)?.name ?? "Unknown state";
    case "label":
      return v === "none" ? "No labels" : (ctx.labels.get(v as string)?.name ?? "Unknown label");
    case "assignee":
    case "createdBy":
      if (v === "me") return "Me";
      if (v === "none") return "No assignees";
      return ctx.users.get(v as string)?.name ?? "Unknown";
    case "delegate":
      if (v === "any") return "Any agent";
      if (v === "none") return "No agent";
      if (v === "me") return "Me";
      return ctx.users.get(v as string)?.name ?? "Unknown agent";
    case "parent": {
      if (v === "any") return "Any parent";
      if (v === "none") return "No parent";
      const parent = ctx.issues?.get(v as string);
      return parent ? `${ctx.issueKey(parent)} ${parent.title}` : "Unknown issue";
    }
    case "is":
      return v === "blocked" ? "Blocked" : v === "blocking" ? "Blocking" : "Duplicate";
    case "has":
      return "Has a link";
  }
}

/** The keys that filter, in menu order. */
export function activeKeys(f: Filter): FilterKey[] {
  return MENU_KEYS.filter((k) => {
    const v = f[k];
    return (Array.isArray(v) ? v.length > 0 : !!v) || (isListKey(k) && (f.not?.[k]?.length ?? 0) > 0);
  });
}
