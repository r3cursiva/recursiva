// An issue's fields in one line (PLNR-359, PLNR-438): the query language with its short forms on — #INFRA project,
// @me assignee, !high priority, +bug label — and its long keys (state:, cycle:, parent:, agent:, due:, start:). The free
// text is the title. Telegram's /new and the TUI's `c` read a line the same way: one function, here, beside the parser.
//
// A filter key that sets no field (author:, group:, is:, created:, updated:, a "-key:"), a list where a field takes one
// value, a range where it takes a day, and a name the parser does not know are errors: nothing is created then, and the
// error names the token with the parser's suggestions, written the way the person wrote the token.
import { cycleStatus, type IssuePatch, type Label, type WorkflowState } from "@rsva/schema/models";
import { todayOf } from "./dates.ts";
import type { DateRange, Filter, QueryContext } from "./index.ts";
import { SHORT_FORMS, type QueryError } from "./parse.ts";

/** What a line sets, only the fields it names, and its free text: the title. */
export interface IssueFields {
  set: IssuePatch;
  title: string;
}

/** What the caller does not let the line set (Telegram: a state or a label only people set); the error, or null. */
export interface FieldGuard {
  state?(s: WorkflowState): string | null;
  label?(l: Label): string | null;
}

/**
 * The names a line of `projectId` resolves against: its project's states, labels and cycles and the workspace's own.
 * Projects keep labels and states of the same name ("bug", "In Progress"): a name must find this project's.
 */
export function inProject(ctx: QueryContext, projectId: string): QueryContext {
  const own = <T extends { projectId: string | null }>(m: ReadonlyMap<string, T>) => new Map([...m].filter(([, v]) => v.projectId === null || v.projectId === projectId));
  return { ...ctx, states: own(ctx.states), labels: own(ctx.labels), ...(ctx.cycles ? { cycles: own(ctx.cycles) } : {}) };
}

/** Keys that narrow a list and set nothing, by the name the parser's Filter uses. */
const NOT_FIELDS: Partial<Record<keyof Filter, string>> = { stateGroup: "group:", createdBy: "author:", is: "is:", createdAt: "created:", updatedAt: "updated:", completedAt: "closed:", not: "-key:" };

/** The parser's error in a sentence; a suggestion is written with the sign (`!`) or key (`priority:`) the person typed. */
export function errorSentence(text: string, e: QueryError): string {
  const before = text.slice(0, e.start);
  const prefix = before.at(-1)! in SHORT_FORMS ? before.at(-1)! : (/-?[A-Za-z_]+:$/.exec(before)?.[0] ?? "");
  const tips = e.suggestions.slice(0, 3).map((s) => (s.endsWith(":") ? s : prefix + s));
  return `${e.message}.${tips.length ? ` Did you mean ${tips.join(" or ")}?` : ""}`;
}

/** One value where the field takes one; `what` names it in the error. */
function one<T>(xs: T[] | undefined, what: string): T | undefined {
  if (xs && xs.length > 1) throw new Error(`One ${what} only.`);
  return xs?.[0];
}

/** A range that is one day, as due: and start: set it; `none` takes the date off. */
function day(r: DateRange | undefined, key: string): string | null | undefined {
  if (!r) return undefined;
  if (r.none) return null;
  if (!r.from || r.from !== r.to) throw new Error(`"${key}" takes one day: today, tomorrow or 2026-11-20.`);
  return r.from;
}

/** The project's cycle that "active" or "next" means today, else the id the parser found. */
function cycleOf(v: string, ctx: QueryContext, projectId: string, today: string): string | null {
  if (v === "none") return null;
  if (v !== "active" && v !== "next") return v;
  const mine = [...(ctx.cycles?.values() ?? [])].filter((c) => c.projectId === projectId);
  const c = v === "active" ? mine.find((x) => cycleStatus(x, today) === "active") : mine.filter((x) => cycleStatus(x, today) === "upcoming").sort((a, b) => (a.startDate! < b.startDate! ? -1 : 1))[0];
  if (!c) throw new Error(`${ctx.projects?.get(projectId)?.key ?? "The project"} has no ${v === "active" ? "active" : "upcoming"} cycle.`);
  return c.id;
}

/**
 * The fields a parsed line sets on a new issue of `projectId`. `ctx.me` resolves @me; @none and label:none leave the list
 * empty. The free text is the title, its quotes taken off.
 */
export function issueFields(f: Filter, ctx: QueryContext, projectId: string, guard: FieldGuard = {}): IssueFields | { error: string } {
  try {
    for (const [k, name] of Object.entries(NOT_FIELDS)) if (f[k as keyof Filter] !== undefined) throw new Error(`"${name}" narrows a list; it sets no field.`);
    if (f.project?.some((id) => id !== projectId)) throw new Error("An issue stays in its project: create it there instead.");
    const set: IssuePatch = {};
    const state = one(f.state, "state");
    const s = state ? ctx.states.get(state) : undefined;
    const refused = s && guard.state?.(s);
    if (refused) throw new Error(refused);
    if (state) set.stateId = state;
    const priority = one(f.priority, "priority");
    if (priority !== undefined) set.priority = priority;
    const me = ctx.me;
    if (f.assignee) set.assigneeIds = f.assignee.includes("none") ? [] : [...new Set(f.assignee.flatMap((u) => (u !== "me" ? [u] : me ? [me] : [])))];
    for (const id of f.label ?? []) {
      const l = ctx.labels.get(id);
      const no = l && guard.label?.(l);
      if (no) throw new Error(no);
    }
    if (f.label) set.labelIds = f.label.includes("none") ? [] : f.label;
    const agent = one(f.delegate, "agent");
    if (agent === "any") throw new Error('"agent:any" narrows a list; name the agent.');
    if (agent) set.delegateId = agent === "none" ? null : agent === "me" ? me : agent;
    const cycle = one(f.cycle, "cycle");
    if (cycle) set.cycleId = cycleOf(cycle, ctx, projectId, todayOf(ctx));
    const parent = one(f.parent, "parent");
    if (parent === "any") throw new Error('"parent:any" narrows a list; name the parent: parent:PLNR-12.');
    if (parent) set.parentId = parent === "none" ? null : parent;
    const due = day(f.dueDate, "due:");
    if (due !== undefined) set.dueDate = due;
    const start = day(f.startDate, "start:");
    if (start !== undefined) set.startDate = start;
    return { set, title: (f.text ?? "").replace(/"([^"]*)"/g, "$1").replace(/\s+/g, " ").trim() };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
