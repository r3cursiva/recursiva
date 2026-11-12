// The inbox screen's rules, apart from its markup: the filter and display options, the line that says why, groups,
// snooze times and the actions a notification offers (PLNR-26; header and filters after Linear's inbox, 2026-10-29).
import type { InboxEvent, InboxKind, InboxRow } from "@rsva/sync";
import type { StateGroup } from "@rsva/schema/models";
import { daysToNext } from "@rsva/display/date-presets";
import { clockTime, shortDate } from "@rsva/display/time";

export { inboxActions, type InboxAction } from "@rsva/protocol";

/** Notification types as the filter names them. */
export const KIND_LABELS: Record<InboxKind, string> = {
  assigned: "Assigned to you",
  review: "Review requested",
  approved: "Approved",
  state: "Status changed",
  mention: "Mentions",
  reply: "Replies to you",
  comment: "Comments",
};

/** Every list holds ids, an empty or missing list does not filter. A row matches when each list has one of its values. */
export interface InboxFilter {
  kind?: InboxKind[];
  /** Who acted: any event of the row since the archive. */
  from?: string[];
  project?: string[];
  /** Workspace slugs (RSVA-613). */
  workspace?: string[];
  priority?: number[];
  stateGroup?: StateGroup[];
}

export type InboxGroupBy = "none" | "day" | "project";
export type InboxOrder = "newest" | "oldest" | "priority";

export interface InboxDisplay {
  groupBy: InboxGroupBy;
  orderBy: InboxOrder;
  showSnoozed: boolean;
  unreadFirst: boolean;
}

/** Days marked from the start (RSVA-571): Today, Yesterday, Earlier. */
export const DEFAULT_INBOX_DISPLAY: InboxDisplay = { groupBy: "day", orderBy: "newest", showSnoozed: false, unreadFirst: false };

export const INBOX_GROUP_OPTIONS: readonly { value: InboxGroupBy; label: string }[] = [
  { value: "none", label: "No grouping" },
  { value: "day", label: "Day" },
  { value: "project", label: "Project" },
];

export const INBOX_ORDER_OPTIONS: readonly { value: InboxOrder; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "priority", label: "Priority" },
];

const some = <T>(list: readonly T[] | undefined, has: (v: T) => boolean) => !list?.length || list.some(has);

/** A notification of one of the viewer's workspaces: the inbox lists them all (RSVA-613). */
export type WsRow = InboxRow & { ws: string };

export function matches(row: WsRow, f: InboxFilter, stateGroup: (stateId: string) => string | undefined): boolean {
  const { issue } = row;
  return (
    some(f.kind, (k) => row.kinds.has(k)) &&
    some(f.from, (u) => row.events.some((e) => e.by === u)) &&
    some(f.project, (p) => issue.projectId === p) &&
    some(f.workspace, (w) => row.ws === w) &&
    some(f.priority, (p) => issue.priority === p) &&
    some(f.stateGroup, (g) => stateGroup(issue.stateId) === g)
  );
}

export const filterCount = (f: InboxFilter): number => Object.values(f).reduce((n, v: unknown[] | undefined) => n + (v?.length ?? 0), 0);

/**
 * "requested your review", "moved it to Done": after the actor's name. A comment says how it starts (RSVA-571): that it
 * was written says nothing. One read off the log before events carried their line says the kind.
 */
export function reason(e: InboxEvent, stateName: (id: string) => string | undefined): string {
  if (e.text) return e.kind === "comment" ? `· ${e.text}` : `${e.kind === "reply" ? "replied" : "mentioned you"} · ${e.text}`;
  switch (e.kind) {
    case "assigned":
      return "assigned you";
    case "review":
      return "requested your review";
    case "approved":
      return "approved shipping";
    case "mention":
      return e.commentId ? "mentioned you in a comment" : "mentioned you in the description";
    case "reply":
      return "replied to your comment";
    case "comment":
      return "commented";
    case "state":
      return `moved it to ${(e.stateId && stateName(e.stateId)) ?? "another state"}`;
  }
}

const startOfDay = (t: number) => new Date(t).setHours(0, 0, 0, 0);

export type DayGroup = "Today" | "Yesterday" | "Earlier";

export function dayGroup(at: string, now: number): DayGroup {
  const day = startOfDay(Date.parse(at));
  const today = startOfDay(now);
  if (day >= today) return "Today";
  return day >= startOfDay(today - 1) ? "Yesterday" : "Earlier";
}

/** "Tomorrow, 09:00": when a snoozed notification comes back. */
export function untilLabel(at: string, now: number): string {
  const t = Date.parse(at);
  const day = startOfDay(t);
  const today = startOfDay(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const prefix = day === today ? "Today" : day === tomorrow.getTime() ? "Tomorrow" : shortDate(at);
  return `${prefix}, ${clockTime(at)}`;
}

export interface SnoozeOption {
  label: string;
  hint: string;
  at: Date;
}

/** Later today (only while it is before 17:00), tomorrow, next Monday and a week from now, at 18:00 or 09:00. */
export function snoozeOptions(now: number): SnoozeOption[] {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const out: SnoozeOption[] = [];
  if (new Date(now).getHours() < 17) out.push({ label: "Later today", hint: "18:00", at: at(0, 18) });
  out.push({ label: "Tomorrow", hint: "09:00", at: at(1, 9) });
  const monday = daysToNext(new Date(now).getDay(), 1);
  out.push({ label: "Next Monday", hint: shortDate(at(monday, 9).toISOString()), at: at(monday, 9) });
  out.push({ label: "In a week", hint: shortDate(at(7, 9).toISOString()), at: at(7, 9) });
  return out;
}

// Urgent first, no priority last, as in the issue lists.
const priorityRank = (p: number) => (p === 0 ? 5 : p);

/**
 * The rows in display order and groups. Groups keep the order of their first row; with no grouping there is one group
 * with an empty name.
 */
export function arrange<R extends InboxRow>(rows: readonly R[], d: InboxDisplay, now: number, projectName: (id: string) => string): { name: string; rows: R[] }[] {
  const at = (r: R) => Date.parse(r.latest.at);
  const sorted = [...rows].sort(
    (a, b) =>
      (d.unreadFirst ? Number(b.unread) - Number(a.unread) : 0) ||
      (d.orderBy === "priority" ? priorityRank(a.issue.priority) - priorityRank(b.issue.priority) : 0) ||
      (d.orderBy === "oldest" ? at(a) - at(b) : at(b) - at(a)),
  );
  const name = (r: R) => (d.groupBy === "day" ? dayGroup(r.latest.at, now) : d.groupBy === "project" ? projectName(r.issue.projectId) : "");
  const groups = new Map<string, R[]>();
  for (const r of sorted) {
    const n = name(r);
    const g = groups.get(n);
    if (g) g.push(r);
    else groups.set(n, [r]);
  }
  return [...groups].map(([name, rows]) => ({ name, rows }));
}
