// Filters, grouping and ordering of issues: one implementation for the browser, the server, the REST API and MCP
// (docs/plan.html, "one code for filters"). Pure functions over plain rows; no MobX, no DOM, no I/O. The UI calls
// them inside MobX computeds, so a view recomputes only when the rows or options it read change.
//
// CONTRACT (2026-10-27): the types and the signature of runQuery are what the screens code against. Changes since are
// additive only: DateRange.preset and .none, QueryContext.today, .weekStart and .timeZone, and the extra exports at the end of this file.
import type { Cycle, Issue, Label, Project, User, WorkflowState } from "@rsva/schema/models";
import { runQueryImpl } from "./run.ts";

/**
 * Plane's group-by options; `none` is one flat group. `project` and `delegate` (the agent an issue is delegated to) were
 * added for views across projects (PLNR-74).
 */
export type GroupBy = "state" | "stateGroup" | "priority" | "assignee" | "label" | "createdBy" | "project" | "delegate" | "cycle" | "parent" | "none";

/** Plane's order-by options; `manual` is the fractional sortOrder (drag and drop). */
export type OrderBy = "manual" | "createdAt" | "updatedAt" | "startDate" | "dueDate" | "priority";

/** Properties a list row or board card may show (Plane's "display properties"). */
export type DisplayProperty =
  | "key"
  | "state"
  | "priority"
  | "assignees"
  | "labels"
  | "startDate"
  | "dueDate"
  | "cycle"
  | "subIssueCount"
  | "createdAt"
  | "updatedAt";

export interface DisplayOptions {
  groupBy: GroupBy;
  /** Board only: rows of the board. */
  subGroupBy: GroupBy | null;
  orderBy: OrderBy;
  showEmptyGroups: boolean;
  /** Show sub-issues as separate rows (Plane's "show sub-issues"). */
  showSubIssues: boolean;
  properties: DisplayProperty[];
}

export const DEFAULT_DISPLAY: DisplayOptions = {
  groupBy: "state",
  subGroupBy: null,
  orderBy: "manual",
  showEmptyGroups: true,
  showSubIssues: true,
  properties: ["key", "state", "priority", "assignees", "labels", "cycle", "dueDate"],
};

/** Inclusive date range as YYYY-MM-DD; either side may be open. Relative presets resolve to this before running. */
export interface DateRange {
  from?: string;
  to?: string;
  /**
   * The relative expression the range came from ("last-7-days", "<today"). When set, runQuery re-resolves it for the
   * current day, so a saved or shared filter stays relative; from/to are its value on the day it was parsed.
   */
  preset?: string;
  /** The issue has no such date: `due:none`, `start:none` (RSVA-13). from, to and preset are absent then. */
  none?: true;
}

/**
 * A filter: AND across keys, OR within a key (Plane's "is any of"). An absent key does not filter.
 * Ids are our UUIDs; "me" and "none" are allowed where they make sense.
 */
export interface Filter {
  state?: string[];
  stateGroup?: WorkflowState["group"][];
  priority?: number[];
  assignee?: (string | "me" | "none")[];
  label?: (string | "none")[];
  createdBy?: (string | "me")[];
  /** The agent the issue is delegated to; "any" is every delegated issue, "none" those that are not (PLNR-74). */
  delegate?: (string | "me" | "none" | "any")[];
  /**
   * Cycle ids (PLNR-63); "none" is no cycle, "active" each project's cycle in progress today, "next" each project's
   * nearest upcoming one: a saved view of "the active cycle" moves on with the calendar.
   */
  cycle?: (string | "none" | "active" | "next")[];
  /** Project ids: a view across projects narrowed to some of them (PLNR-74). */
  project?: string[];
  /** The parent issue's id, direct children only (PLNR-173); "none" is top-level issues, "any" every sub-issue. */
  parent?: (string | "none" | "any")[];
  /**
   * What the issue's relations say (PLNR-51): `blocked` waits on an open issue, `blocking` an open issue waits on it,
   * `duplicate` it is marked a duplicate of another issue (RSVA-174).
   */
  is?: ("blocked" | "blocking" | "duplicate")[];
  /** What the issue carries (RSVA-174): `link` a link, a pull request or a commit attached to it; an uploaded file is not one. */
  has?: "link"[];
  startDate?: DateRange;
  dueDate?: DateRange;
  createdAt?: DateRange;
  updatedAt?: DateRange;
  /** When it was closed (RSVA-576): `closed:2026-10-21`. A cancelled issue has the time too: `group:completed` leaves those out. */
  completedAt?: DateRange;
  /** Case-insensitive match on title and key. */
  text?: string;
  /** "Is not" (PLNR-74): issues matching any of these values are left out; `-label:proposed` in the query. */
  not?: NegatedFilter;
}

/** The list keys a filter can negate: an issue with any of the values does not pass. */
export type NegatedFilter = Partial<Pick<Filter, "project" | "state" | "stateGroup" | "priority" | "assignee" | "label" | "createdBy" | "delegate" | "cycle" | "parent" | "is" | "has">>;

/**
 * Other issues of the workspace, whatever the list's scope: a parent or a blocker may sit in another project. The browser
 * answers from the pool, the API from rows it loads only for a query that needs them (needsIssueIndex).
 */
export interface IssueIndex {
  /** Deleted issues are left out, archived ones stay. */
  get(id: string): Issue | undefined;
  /** By "INFRA-12", in capitals; the same issues as `get`. */
  byKey(key: string): Issue | undefined;
  /** One of its blockers is live and open: what the mark on a row shows. */
  isBlocked(issue: Issue): boolean;
  /** It is live and open, and a live open issue waits on it. */
  isBlocking(issue: Issue): boolean;
  /** A link, a pull request or a commit is attached to it (isLinkKind of @rsva/schema): what `has:link` asks. */
  hasLink(issue: Issue): boolean;
}

/** What the query needs besides the issues: lookups and the current user. */
export interface QueryContext {
  states: ReadonlyMap<string, WorkflowState>;
  labels: ReadonlyMap<string, Label>;
  users: ReadonlyMap<string, User>;
  /** Cycles in scope, for `cycle:` and grouping by cycle (PLNR-63); absent where there are none. */
  cycles?: ReadonlyMap<string, Cycle>;
  /** The projects in scope, for `project:` and grouping by project; absent in a project's own view. */
  projects?: ReadonlyMap<string, Project>;
  /** For `parent:`, `is:` and grouping by parent; without it they find nothing. */
  issues?: IssueIndex;
  me: string | null;
  /** "PLANE-60" for text search. */
  issueKey(issue: Issue): string;
  /** YYYY-MM-DD the relative dates resolve against; today in `timeZone` when absent. Tests and the server pass it. */
  today?: string;
  /** First day of the week for this-week and its kin, as getDay counts (the Profile's, RSVA-13); Monday when absent. */
  weekStart?: number;
  /**
   * The person's IANA zone (the Profile's): what today is and where created/updated days start. Absent: the runtime's
   * zone, which in the browser is the person's own; the server passes the Profile's (RSVA-13).
   */
  timeZone?: string;
}

/** One group of the result. `key` is stable across recomputations (used as a React key and for collapsed state). */
export interface IssueGroup {
  key: string;
  groupBy: GroupBy;
  /** Display name: state name, "High", a person's name, "No labels"… */
  name: string;
  /** The object the group stands for, for icons and colors; null for "none" buckets. */
  ref: { state: WorkflowState } | { stateGroup: WorkflowState["group"] } | { priority: number } | { user: User } | { label: Label } | { project: Project } | { cycle: Cycle } | { parent: Issue } | null;
  issues: Issue[];
  /** Board only: sub-groups when subGroupBy is set. */
  subGroups?: IssueGroup[];
}

/**
 * Filters, groups and orders `issues` (already scoped to a project or workspace by the caller). `ctx.states` and
 * `ctx.labels` are the ones in scope: they name the groups shown with `showEmptyGroups`. Pure; see run.ts.
 */
export function runQuery(issues: readonly Issue[], filter: Filter, display: DisplayOptions, ctx: QueryContext): IssueGroup[] {
  return runQueryImpl(issues, filter, display, ctx);
}

export { runQueryRows, sortIssues, groupIssues, compileFilter, textTerms, sortedStates, sortedCycles, cyclesAhead, STATE_GROUP_ORDER, PRIORITY_ORDER } from "./run.ts";
export { parseQuery, formatQuery, isEmptyFilter, needsIssueIndex, namesOrder, withOrder, suggest, formatValue, QUERY_KEYS, ORDER_KEYS, ORDER_BYS, ORDER_WORDS, PRIORITY_KEYWORDS, SHORT_FORMS, type ParsedQuery, type QueryError } from "./parse.ts";
export { resolveDateExpr, formatDateRange, describeDateRange, currentRange, localToday, DATE_PRESETS } from "./dates.ts";
export { GROUP_BY_OPTIONS, ORDER_BY_OPTIONS, DISPLAY_PROPERTY_OPTIONS } from "./options.ts";
export { issueView, type ViewNames } from "./view.ts";
export { issueFields, errorSentence, inProject, type IssueFields, type FieldGuard } from "./fields.ts";
