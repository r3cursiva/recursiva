// runQuery: filter → order → group, in one pass each. Built for keystroke-level re-filtering of 10k issues:
//   - the filter is compiled once per call into a short list of checks over Sets and small arrays, so the per-issue
//     work is a few property reads and hash lookups, with no allocation;
//   - ordering reads each sort key once (decorate-sort-undecorate over an index array), because issues in the
//     browser are MobX proxies and a comparator that reads fields would do it n·log n times;
//   - the ordered rows are dealt into groups, so every group comes out ordered without a sort of its own.
// docs/research/query-2026-10-27.md compares this with a per-key closure filter and with bitset indexes.
import { PRIORITIES, STATE_GROUPS, cycleStatus, priorityName, type Cycle, type Issue, type Label, type Project, type StateGroup, type User, type WorkflowState } from "@rsva/schema/models";
import { addDays, dayStart } from "@rsva/schema/days";
import { currentRange, todayOf } from "./dates.ts";
import type { DateRange, DisplayOptions, Filter, GroupBy, IssueGroup, OrderBy, QueryContext } from "./index.ts";

export const STATE_GROUP_ORDER = STATE_GROUPS;
const STATE_GROUP_NAMES: Record<StateGroup, string> = {
  backlog: "Backlog",
  unstarted: "Unstarted",
  started: "Started",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** Priority codes in Plane's order: urgent, high, medium, low, none. */
export const PRIORITY_ORDER = PRIORITIES.map((p) => p.code);

// ── Filter ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Check = (i: Issue) => boolean;

/**
 * Timestamps arrive as "2026-10-25 21:30:34.01+00" from Postgres and "2026-10-25T21:30:34.010Z" from the client.
 * Both are UTC; compare their first 19 characters with T and space treated alike, without building a string.
 */
function cmpTs(a: string, b: string): number {
  for (let k = 0; k < 19; k++) {
    let x = a.charCodeAt(k);
    let y = b.charCodeAt(k);
    if (x === 84) x = 32;
    if (y === 84) y = 32;
    if (x !== y) return (x || 0) - (y || 0);
  }
  return 0;
}

/** Midnight of a day in `timeZone` (the runtime's when absent) as a UTC timestamp in the comparable form "YYYY-MM-DD HH:MM:SS". */
function midnightUtc(day: string, timeZone?: string): string {
  return dayStart(day, timeZone).toISOString().slice(0, 19).replace("T", " ");
}

function dayCheck(field: "startDate" | "dueDate", r: DateRange): Check | null {
  if (r.none) return (i) => i[field] === null;
  const { from, to } = r;
  if (from && to) return (i) => { const v = i[field]; return v !== null && v >= from && v <= to; };
  if (from) return (i) => { const v = i[field]; return v !== null && v >= from; };
  if (to) return (i) => { const v = i[field]; return v !== null && v <= to; };
  return null;
}

type TsField = "createdAt" | "updatedAt" | "completedAt";

/** A time in the range; an issue without the time (never closed) is in none, and is what `none` finds. */
function tsCheck(field: TsField, r: DateRange, timeZone?: string): Check | null {
  if (r.none) return (i) => i[field] === null;
  const within = tsRange(r, timeZone);
  return within && ((i) => { const v = i[field]; return v !== null && within(v); });
}

function tsRange(r: DateRange, timeZone?: string): ((v: string) => boolean) | null {
  // [midnight of `from`, midnight of the day after `to`), in the person's zone
  const lo = r.from ? midnightUtc(r.from, timeZone) : null;
  const hi = r.to ? midnightUtc(addDays(r.to, 1), timeZone) : null;
  if (lo && hi) return (v) => cmpTs(v, lo) >= 0 && cmpTs(v, hi) < 0;
  if (lo) return (v) => cmpTs(v, lo) >= 0;
  if (hi) return (v) => cmpTs(v, hi) < 0;
  return null;
}

/** "is any of" over an array field; `none` matches an empty array. */
function anyOf(field: "assigneeIds" | "labelIds", ids: Set<string>, none: boolean): Check {
  if (ids.size === 0) return none ? (i) => i[field].length === 0 : () => false;
  if (ids.size === 1 && !none) {
    const [only] = ids;
    return (i) => i[field].includes(only!);
  }
  return (i) => {
    const xs = i[field];
    if (xs.length === 0) return none;
    for (let k = 0; k < xs.length; k++) if (ids.has(xs[k]!)) return true;
    return false;
  };
}

/** "Is any of" over an optional reference: `none` is no value, `any` every value, the rest ids. */
function refCheck(field: "delegateId" | "parentId", values: readonly string[], me: string | null): Check {
  const any = values.includes("any");
  const { set, none } = resolveMe(values.filter((v) => v !== "any"), me);
  return (i) => {
    const v = i[field];
    return v === null ? none : any || set.has(v);
  };
}

function resolveMe(ids: readonly string[], me: string | null): { set: Set<string>; none: boolean } {
  const set = new Set<string>();
  let none = false;
  for (const id of ids) {
    if (id === "none") none = true;
    else if (id === "me") {
      if (me) set.add(me);
    } else set.add(id);
  }
  return { set, none };
}

/** Free-text terms: words, or "quoted phrases"; every term must match the title or the key. */
export function textTerms(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"?|(\S+)/g;
  for (let m; (m = re.exec(text)); ) {
    const t = (m[1] ?? m[2] ?? "").trim().toLowerCase();
    if (t) out.push(t);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function textCheck(text: string, ctx: QueryContext): Check | null {
  const terms = textTerms(text);
  if (terms.length === 0) return null;
  // A case-insensitive regexp per term: V8 matches it in place, where toLowerCase() would copy every title.
  const res = terms.map((t) => new RegExp(escapeRe(t), "i"));
  // Terms that look like a key ("infra-12", "12") are also tried against the issue key, built only for them.
  const keyish = terms.map((t) => /^[a-z][a-z0-9]*-\d*$|^\d+$/.test(t));
  return (i) => {
    for (let k = 0; k < res.length; k++) {
      if (res[k]!.test(i.title)) continue;
      if (keyish[k] && ctx.issueKey(i).toLowerCase().includes(terms[k]!)) continue;
      return false;
    }
    return true;
  };
}

/** The filter as a list of checks, cheapest first; null when it lets everything through. */
export function compileFilter(f: Filter, ctx: QueryContext, today: string): Check | null {
  const checks: Check[] = [];
  if (f.state && f.state.length) {
    const s = new Set(f.state);
    checks.push((i) => s.has(i.stateId));
  }
  if (f.stateGroup && f.stateGroup.length) {
    // Resolved to state ids once, so the per-issue check is a Set lookup instead of a state lookup.
    const groups = new Set<string>(f.stateGroup);
    const s = new Set<string>();
    for (const st of ctx.states.values()) if (groups.has(st.group)) s.add(st.id);
    checks.push((i) => s.has(i.stateId));
  }
  if (f.priority && f.priority.length) {
    const ok = new Uint8Array(8);
    for (const p of f.priority) if (p >= 0 && p < 8) ok[p] = 1;
    checks.push((i) => ok[i.priority] === 1);
  }
  if (f.assignee && f.assignee.length) {
    const { set, none } = resolveMe(f.assignee, ctx.me);
    checks.push(anyOf("assigneeIds", set, none));
  }
  if (f.label && f.label.length) {
    const { set, none } = resolveMe(f.label, null);
    checks.push(anyOf("labelIds", set, none));
  }
  if (f.createdBy && f.createdBy.length) {
    const { set } = resolveMe(f.createdBy, ctx.me);
    checks.push((i) => i.createdById !== null && set.has(i.createdById));
  }
  if (f.delegate && f.delegate.length) checks.push(refCheck("delegateId", f.delegate, ctx.me));
  if (f.parent && f.parent.length) checks.push(refCheck("parentId", f.parent, null));
  if (f.project && f.project.length) {
    const set = new Set(f.project);
    checks.push((i) => set.has(i.projectId));
  }
  if (f.cycle && f.cycle.length) {
    // "active" and "next" become the ids they mean today, so the per-issue check is a Set lookup.
    const set = new Set<string>();
    const none = f.cycle.includes("none");
    const cycles = [...(ctx.cycles?.values() ?? [])];
    if (f.cycle.includes("active")) for (const c of cycles) if (cycleStatus(c, today) === "active") set.add(c.id);
    if (f.cycle.includes("next")) {
      const next = new Map<string, Cycle>();
      for (const c of cycles) {
        if (cycleStatus(c, today) !== "upcoming") continue;
        const at = next.get(c.projectId);
        if (!at || c.startDate! < at.startDate!) next.set(c.projectId, c);
      }
      for (const c of next.values()) set.add(c.id);
    }
    for (const v of f.cycle) if (v !== "none" && v !== "active" && v !== "next") set.add(v);
    checks.push((i) => (i.cycleId === null ? none : set.has(i.cycleId)));
  }
  if (f.is && f.is.length) {
    const index = ctx.issues;
    const blocked = f.is.includes("blocked");
    const blocking = f.is.includes("blocking");
    // A field of the issue itself: no index needed, so `is:duplicate` alone loads nothing (needsIssueIndex).
    const duplicate = f.is.includes("duplicate");
    checks.push((i) => (duplicate && i.duplicateOfId !== null) || (!!index && ((blocked && index.isBlocked(i)) || (blocking && index.isBlocking(i)))));
  }
  if (f.has && f.has.length) {
    const index = ctx.issues;
    checks.push((i) => !!index && index.hasLink(i));
  }
  const dates: [keyof Filter & ("startDate" | "dueDate" | TsField), boolean][] = [
    ["startDate", false],
    ["dueDate", false],
    ["createdAt", true],
    ["updatedAt", true],
    ["completedAt", true],
  ];
  for (const [field, isTs] of dates) {
    const r = f[field];
    if (!r) continue;
    const range = currentRange(r, today, ctx.weekStart);
    const c = isTs ? tsCheck(field as TsField, range, ctx.timeZone) : dayCheck(field as "startDate" | "dueDate", range);
    if (c) checks.push(c);
  }
  const text = f.text ? textCheck(f.text, ctx) : null;
  if (text) checks.push(text);
  // "Is not": each negated key is the positive check turned around, so both read a value the same way.
  for (const [key, values] of Object.entries(f.not ?? {})) {
    if (!values?.length) continue;
    const c = compileFilter({ [key]: values }, ctx, today);
    if (c) checks.push((i) => !c(i));
  }

  if (checks.length === 0) return null;
  if (checks.length === 1) return checks[0]!;
  if (checks.length === 2) {
    const [a, b] = checks as [Check, Check];
    return (i) => a(i) && b(i);
  }
  return (i) => {
    for (let k = 0; k < checks.length; k++) if (!checks[k]!(i)) return false;
    return true;
  };
}

// ── Order ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Plain code-unit comparison: Postgres sorts sortOrder with COLLATE "C", and so must we. */
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Sorts in place by `orderBy`; ties fall back to manual order, then id. Each key is read once per issue.
 *   manual        sortOrder ascending
 *   createdAt     newest first (Plane's "Last created")
 *   updatedAt     newest first (Plane's "Last updated")
 *   startDate     earliest first, issues without a date last
 *   dueDate       earliest first, issues without a date last
 *   priority      urgent, high, medium, low, none
 */
export function sortIssues(rows: Issue[], orderBy: OrderBy): void {
  const n = rows.length;
  if (n < 2) return;
  const order = new Array<string>(n);
  const ids = new Array<string>(n);
  for (let k = 0; k < n; k++) {
    order[k] = rows[k]!.sortOrder;
    ids[k] = rows[k]!.id;
  }
  const idx = new Uint32Array(n);
  for (let k = 0; k < n; k++) idx[k] = k;
  const tie = (a: number, b: number) => cmpStr(order[a]!, order[b]!) || cmpStr(ids[a]!, ids[b]!);

  if (orderBy === "priority") {
    const rank = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const p = rows[k]!.priority;
      rank[k] = p === 0 ? 5 : p;
    }
    idx.sort((a, b) => rank[a]! - rank[b]! || tie(a, b));
  } else if (orderBy === "startDate" || orderBy === "dueDate") {
    const key = new Array<string | null>(n);
    for (let k = 0; k < n; k++) key[k] = rows[k]![orderBy];
    idx.sort((a, b) => {
      const x = key[a]!;
      const y = key[b]!;
      if (x === y) return tie(a, b);
      if (x === null) return 1;
      if (y === null) return -1;
      return x < y ? -1 : 1;
    });
  } else if (orderBy === "createdAt" || orderBy === "updatedAt") {
    const key = new Array<string>(n);
    for (let k = 0; k < n; k++) key[k] = rows[k]![orderBy];
    idx.sort((a, b) => cmpTs(key[b]!, key[a]!) || tie(a, b));
  } else {
    // Rows usually arrive in manual order already (the store keeps them so); then there is nothing to do.
    let sorted = true;
    for (let k = 1; k < n && sorted; k++) if (tie(k - 1, k) > 0) sorted = false;
    if (sorted) return;
    idx.sort(tie);
  }
  const copy = rows.slice();
  for (let k = 0; k < n; k++) rows[k] = copy[idx[k]!]!;
}

// ── Group ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Ref = IssueGroup["ref"];

interface GroupDef {
  key: string;
  name: string;
  ref: Ref;
}

const byName = (a: User, b: User) => a.name.localeCompare(b.name) || cmpStr(a.id, b.id);
const byPosition = (a: { position: number; id: string }, b: { position: number; id: string }) => a.position - b.position || cmpStr(a.id, b.id);
const stateRank = (s: WorkflowState) => {
  const r = STATE_GROUP_ORDER.indexOf(s.group as StateGroup);
  return r < 0 ? STATE_GROUP_ORDER.length : r;
};

export function sortedStates(states: Iterable<WorkflowState>): WorkflowState[] {
  return [...states].sort((a, b) => stateRank(a) - stateRank(b) || byPosition(a, b));
}

/**
 * Cycles in time order (PLNR-63): dated ones by start, then drafts by number; completed ones are left out unless `all`.
 * The Cycle picker, grouping by cycle and the Cycles page read this order.
 */
export function sortedCycles(cycles: Iterable<Cycle>, all = false): Cycle[] {
  return [...cycles]
    .filter((c) => all || !c.completedAt)
    .sort((a, b) => (a.startDate && b.startDate ? cmpStr(a.startDate, b.startDate) : a.startDate ? -1 : b.startDate ? 1 : 0) || a.number - b.number || cmpStr(a.id, b.id));
}

/** The cycles a cycle's open issues can move on to on `today`: not completed, not over, in time order. The first with dates is the next one. */
export function cyclesAhead(cycles: Iterable<Cycle>, self: string, today: string): Cycle[] {
  return sortedCycles(cycles).filter((c) => c.id !== self && cycleStatus(c, today) !== "ended");
}

/**
 * How one group-by option sorts issues into buckets: the bucket values of an issue (several for labels and
 * assignees) and every possible group in display order. Bucket values are raw ids; group keys add the prefix.
 */
interface Grouping {
  /** Calls `add` with each bucket value of the issue. */
  assign(i: Issue, add: (value: string) => void): void;
  /** All groups in display order, for "show empty groups" and for ordering the non-empty ones; `present` is the values rows gave. */
  all(present: Iterable<string>): GroupDef[];
  /** A group for a value missing from all(): a deleted label, a user not in the workspace. */
  unknown(value: string): GroupDef;
}

const NONE = "none";

function grouping(by: GroupBy, ctx: QueryContext): Grouping {
  switch (by) {
    case "state": {
      // Across projects (a workspace view) states that share a name are one group, under the first of them in display
      // order: "In Review" of every project together. Within a project names are unique, so nothing merges there.
      const sorted = sortedStates(ctx.states.values());
      const first = new Map<string, WorkflowState>();
      const as = new Map<string, string>();
      for (const s of sorted) {
        const name = s.name.toLowerCase();
        if (!first.has(name)) first.set(name, s);
        as.set(s.id, first.get(name)!.id);
      }
      return {
        assign: (i, add) => add(as.get(i.stateId) ?? i.stateId),
        all: () => [...first.values()].map((state) => ({ key: `state:${state.id}`, name: state.name, ref: { state } })),
        unknown: (v) => ({ key: `state:${v}`, name: "Unknown state", ref: null }),
      };
    }
    case "stateGroup":
      return {
        assign: (i, add) => add(ctx.states.get(i.stateId)?.group ?? NONE),
        all: () => STATE_GROUP_ORDER.map((g) => ({ key: `stateGroup:${g}`, name: STATE_GROUP_NAMES[g], ref: { stateGroup: g } })),
        unknown: (v) => ({ key: `stateGroup:${v}`, name: "Unknown state", ref: null }),
      };
    case "priority":
      return {
        assign: (i, add) => add(String(i.priority)),
        all: () => PRIORITY_ORDER.map((p) => ({ key: `priority:${p}`, name: priorityName(p), ref: { priority: p } })),
        unknown: (v) => ({ key: `priority:${v}`, name: `Priority ${v}`, ref: { priority: Number(v) } }),
      };
    case "assignee":
    case "label": {
      const field = by === "assignee" ? "assigneeIds" : "labelIds";
      const known: ReadonlyMap<string, unknown> = by === "assignee" ? ctx.users : ctx.labels;
      const noneName = by === "assignee" ? "No assignees" : "No labels";
      return {
        // An issue with two labels lands in both groups, as in Plane; ids we do not know count as no value.
        assign: (i, add) => {
          const xs = i[field];
          let any = false;
          for (let k = 0; k < xs.length; k++) {
            if (known.has(xs[k]!)) {
              add(xs[k]!);
              any = true;
            }
          }
          if (!any) add(NONE);
        },
        all: () => [
          ...(by === "assignee"
            ? [...ctx.users.values()].sort(byName).map((user) => ({ key: `assignee:${user.id}`, name: user.name, ref: { user } }))
            : [...ctx.labels.values()].sort(byPosition).map((label: Label) => ({ key: `label:${label.id}`, name: label.name, ref: { label } }))),
          { key: `${by}:${NONE}`, name: noneName, ref: null },
        ],
        unknown: (v) => ({ key: `${by}:${v}`, name: v === NONE ? noneName : "Unknown", ref: null }),
      };
    }
    case "createdBy":
      return {
        assign: (i, add) => add(i.createdById ?? NONE),
        all: () => [...ctx.users.values()].sort(byName).map((user) => ({ key: `createdBy:${user.id}`, name: user.name, ref: { user } })),
        unknown: (v) => ({ key: `createdBy:${v}`, name: v === NONE ? "No author" : "Unknown author", ref: null }),
      };
    case "delegate":
      return {
        assign: (i, add) => add(i.delegateId ?? NONE),
        // The workspace's agents, then issues without one; a person delegated to by hand gets a group of their own.
        all: () => [
          ...[...ctx.users.values()].filter((u) => u.kind === "agent").sort(byName).map((user) => ({ key: `delegate:${user.id}`, name: user.name, ref: { user } })),
          { key: `delegate:${NONE}`, name: "No agent", ref: null },
        ],
        unknown: (v) => {
          const user = ctx.users.get(v);
          return { key: `delegate:${v}`, name: user?.name ?? "Unknown agent", ref: user ? { user } : null };
        },
      };
    case "project":
      return {
        assign: (i, add) => add(i.projectId),
        all: () =>
          [...(ctx.projects?.values() ?? [])]
            .sort((a: Project, b: Project) => cmpStr(a.key, b.key))
            .map((project) => ({ key: `project:${project.id}`, name: project.name, ref: { project } })),
        unknown: (v) => ({ key: `project:${v}`, name: "Unknown project", ref: null }),
      };
    case "cycle": {
      // Across projects (a workspace view) cycles share names ("Cycle 12" in each): the project's key tells them apart.
      const many = new Set([...(ctx.cycles?.values() ?? [])].map((c) => c.projectId)).size > 1;
      const name = (c: Cycle) => (many ? `${ctx.projects?.get(c.projectId)?.key ?? "?"} · ${c.name}` : c.name);
      return {
        assign: (i, add) => add(i.cycleId ?? NONE),
        // Completed cycles take no new issues: they get a group only when an issue still sits in one.
        all: () => [
          ...sortedCycles(ctx.cycles?.values() ?? []).map((cycle) => ({ key: `cycle:${cycle.id}`, name: name(cycle), ref: { cycle } })),
          { key: `cycle:${NONE}`, name: "No cycle", ref: null },
        ],
        unknown: (v) => {
          const cycle = ctx.cycles?.get(v);
          return { key: `cycle:${v}`, name: cycle ? name(cycle) : "Unknown cycle", ref: cycle ? { cycle } : null };
        },
      };
    }
    case "parent": {
      // Parents are too many to list: only those with rows get a group, in their manual order, so ranking epics ranks the
      // groups. A deleted parent counts as none: its sub-issues are no one's now.
      const parent = (id: string) => ctx.issues?.get(id);
      const none = { key: `parent:${NONE}`, name: "No parent", ref: null };
      return {
        assign: (i, add) => add(i.parentId !== null && parent(i.parentId) ? i.parentId : NONE),
        all: (present) => [
          ...[...present]
            .flatMap((id) => parent(id) ?? [])
            .sort((a, b) => cmpStr(a.sortOrder, b.sortOrder) || cmpStr(a.id, b.id))
            .map((issue) => ({ key: `parent:${issue.id}`, name: `${ctx.issueKey(issue)} ${issue.title}`, ref: { parent: issue } })),
          none,
        ],
        unknown: () => none,
      };
    }
    case "none":
      return {
        assign: (_i, add) => add("all"),
        all: () => [{ key: "all", name: "All issues", ref: null }],
        unknown: () => ({ key: "all", name: "All issues", ref: null }),
      };
  }
}

/** Deals ordered rows into groups; each group keeps the order of `rows`. */
export function groupIssues(rows: readonly Issue[], by: GroupBy, showEmpty: boolean, ctx: QueryContext): IssueGroup[] {
  const g = grouping(by, ctx);
  const buckets = new Map<string, Issue[]>();
  let current: Issue;
  const add = (v: string) => {
    let b = buckets.get(v);
    if (!b) buckets.set(v, (b = []));
    b.push(current);
  };
  for (let k = 0; k < rows.length; k++) {
    current = rows[k]!;
    g.assign(current, add);
  }
  const prefix = by === "none" ? "" : `${by}:`;
  const out: IssueGroup[] = [];
  const seen = new Set<string>();
  for (const def of g.all(buckets.keys())) {
    const value = by === "none" ? "all" : def.key.slice(prefix.length);
    seen.add(value);
    const issues = buckets.get(value);
    if (issues || showEmpty) out.push({ key: def.key, groupBy: by, name: def.name, ref: def.ref, issues: issues ?? [] });
  }
  for (const [value, issues] of buckets) {
    if (seen.has(value)) continue;
    const def = g.unknown(value);
    out.push({ key: def.key, groupBy: by, name: def.name, ref: def.ref, issues });
  }
  // Issues without an agent go after every agent, people delegated to by hand included; without a cycle, after every cycle.
  const none = by === "delegate" || by === "cycle" ? out.findIndex((x) => x.key === `${by}:${NONE}`) : -1;
  if (none >= 0) out.push(out.splice(none, 1)[0]!);
  return out;
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Filters, orders and groups. The filtered, ordered rows are also returned for flat consumers (counts, ↑/↓). */
export function runQueryRows(issues: readonly Issue[], filter: Filter, display: DisplayOptions, ctx: QueryContext): Issue[] {
  const today = todayOf(ctx);
  const check = compileFilter(filter, ctx, today);
  // A list by parent is about sub-issues, whatever the switch says.
  const skipSubs = !display.showSubIssues && display.groupBy !== "parent" && display.subGroupBy !== "parent" && !filter.parent?.length;
  const rows: Issue[] = [];
  for (let k = 0; k < issues.length; k++) {
    const i = issues[k]!;
    if (skipSubs && i.parentId !== null) continue;
    if (check && !check(i)) continue;
    rows.push(i);
  }
  sortIssues(rows, display.orderBy);
  return rows;
}

export function runQueryImpl(issues: readonly Issue[], filter: Filter, display: DisplayOptions, ctx: QueryContext): IssueGroup[] {
  const rows = runQueryRows(issues, filter, display, ctx);
  const groups = groupIssues(rows, display.groupBy, display.showEmptyGroups, ctx);
  const sub = display.subGroupBy;
  if (sub && sub !== "none" && sub !== display.groupBy) {
    for (const group of groups) group.subGroups = groupIssues(group.issues, sub, display.showEmptyGroups, ctx);
  }
  return groups;
}
