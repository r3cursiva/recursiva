// An issue's history as words, for every screen that shows it: the web's activity and Timeline, and the TUI's issue
// screen, so they say the same thing (PLNR-332). A line is an icon's kind and a list of parts: plain words, an emphasised
// string, and references by id that each screen resolves from its own store (a state with its glyph, a label with its
// colour, a person by name or by email). Names come from the store, so a renamed state reads with its current name; one
// the store no longer has reads as REMOVED says. What GitHub did stays an entry: each screen draws it with its own chips.
import type { HistoryEntry } from "@rsva/protocol";
import { foldEdits, joinActs, type Edit } from "./activity-rows.ts";
import { formatDate } from "./time.ts";

/** How the history and a comment say where they were made (PLNR-369); a source it does not know says nothing. */
export const viaWords = (via: string | null | undefined): string | null => (via === "telegram" ? "from Telegram" : via === "email" ? "from Email" : null);

/**
 * A piece of a sentence. A string is plain words; `em` words that stand out (a title, a date); `aside` words a narrow
 * screen may leave out. The rest are ids: `state` (`glyph`: with its glyph, else the name alone), `label`, `user`,
 * `issue` (its key and title), `cycle`, `project` (its name), and `priority` by its number.
 */
export type HistoryPart =
  | string
  | { em: string }
  | { aside: string }
  | { state: unknown; glyph?: boolean }
  | { label: string }
  | { user: unknown }
  | { issue: unknown }
  | { cycle: unknown }
  | { project: unknown }
  | { priority: number };

/** How a reference the store does not have reads. A cycle that is not an id reads as nothing. */
export const REMOVED = { state: "a removed state", label: "a removed label", user: "someone", issue: "a removed issue", cycle: "a removed cycle", project: "a removed project" } as const;

/** The icon of a line: a kind each screen draws its own way; a state change's is the new state, one person's is their face. */
export type HistoryIcon =
  | { kind: "title" | "description" | "assignees" | "labels" | "blockers" | "related" | "duplicate" | "delegate" | "parent" | "start" | "due" | "cycle" | "archive" | "delete" | "move" | "github" }
  | { kind: "state"; state: unknown }
  | { kind: "priority"; priority: number }
  | { kind: "person"; user: string | null };

/** One line of the history: its icon and its sentence after the actor's name. `github`: the entry of what GitHub did, which each screen words itself. */
export interface HistoryLine<E extends HistoryEntry = HistoryEntry> {
  key: string;
  icon: HistoryIcon;
  parts: HistoryPart[];
  github?: E;
}

/** Parts joined with commas and "and": "bug, ui and api". */
export function list(xs: readonly HistoryPart[][]): HistoryPart[] {
  return xs.flatMap((x, i) => (i === 0 ? x : [i === xs.length - 1 ? " and " : ", ", ...x]));
}

function diff(before: unknown, after: unknown): { added: string[]; removed: string[] } {
  const b = new Set(Array.isArray(before) ? (before as string[]) : []);
  const a = new Set(Array.isArray(after) ? (after as string[]) : []);
  return { added: [...a].filter((x) => !b.has(x)), removed: [...b].filter((x) => !a.has(x)) };
}

/** The fields that hold a set: the noun of one item, its icon, and how an item reads. */
const SETS: Record<string, { noun: string; icon: HistoryIcon; part: (id: string) => HistoryPart }> = {
  assigneeIds: { noun: "assignee", icon: { kind: "assignees" }, part: (id) => ({ user: id }) },
  labelIds: { noun: "label", icon: { kind: "labels" }, part: (id) => ({ label: id }) },
  blockedByIds: { noun: "blocker", icon: { kind: "blockers" }, part: (id) => ({ issue: id }) },
  relatedIds: { noun: "related issue", icon: { kind: "related" }, part: (id) => ({ issue: id }) },
};

/** "added labels bug and ui and removed label api"; null when the sets are equal. One assignee added shows their face. */
function setChange(field: string, before: unknown, after: unknown): { icon: HistoryIcon; parts: HistoryPart[] } | null {
  const set = SETS[field]!;
  const { added, removed } = diff(before, after);
  const some = (ids: string[]) => [`${set.noun}${ids.length > 1 ? "s" : ""} `, ...list(ids.map((id) => [set.part(id)]))];
  const parts: HistoryPart[] = [];
  if (added.length) parts.push("added ", ...some(added));
  if (removed.length) parts.push(added.length ? " and removed " : "removed ", ...some(removed));
  if (!parts.length) return null;
  const one = field === "assigneeIds" && added.length === 1 && !removed.length;
  return { icon: one ? { kind: "person", user: added[0]! } : set.icon, parts };
}

/** What one field's change says, with its icon; null for a change that says nothing (equal sets, a field it does not know). */
function describe(field: string, before: unknown, after: unknown): { icon: HistoryIcon; parts: HistoryPart[] } | null {
  switch (field) {
    case "title":
      return { icon: { kind: "title" }, parts: ["renamed the issue to ", { em: String(after) }] };
    case "description":
      return { icon: { kind: "description" }, parts: ["updated the description"] };
    case "stateId":
      return { icon: { kind: "state", state: after }, parts: before ? ["moved from ", { state: before }, " to ", { state: after }] : ["moved to ", { state: after }] };
    case "priority":
      return { icon: { kind: "priority", priority: after as number }, parts: after ? ["set the priority to ", { priority: after as number }] : ["removed the priority"] };
    case "assigneeIds":
    case "labelIds":
    case "blockedByIds":
    case "relatedIds":
      return setChange(field, before, after);
    case "duplicateOfId":
      return { icon: { kind: "duplicate" }, parts: after ? ["marked the issue a duplicate of ", { issue: after }] : ["unmarked the issue as a duplicate"] };
    case "delegateId":
      return { icon: { kind: "delegate" }, parts: after ? ["delegated the issue to ", { user: after }] : ["removed the delegate"] };
    case "parentId":
      return { icon: { kind: "parent" }, parts: after ? ["set the parent to ", { issue: after }] : ["removed the parent"] };
    case "startDate":
    case "dueDate": {
      const what = field === "startDate" ? "start date" : "due date";
      const icon: HistoryIcon = { kind: field === "startDate" ? "start" : "due" };
      if (!after) return { icon, parts: [`removed the ${what}`] };
      const to = { em: formatDate(after as string) };
      return { icon, parts: before ? [`changed the ${what} from `, { em: formatDate(before as string) }, " to ", to] : [`set the ${what} to `, to] };
    }
    case "cycleId":
      if (!after) return { icon: { kind: "cycle" }, parts: ["removed the issue from ", { cycle: before }] };
      return { icon: { kind: "cycle" }, parts: before ? ["moved the issue from ", { cycle: before }, " to ", { cycle: after }] : ["added the issue to ", { cycle: after }] };
    case "archivedAt":
      return { icon: { kind: "archive" }, parts: [after ? "archived the issue" : "restored the issue"] };
    case "deletedAt":
      return { icon: { kind: "delete" }, parts: [after ? "deleted the issue" : "restored the issue from the trash"] };
  }
  return null;
}

/** The line of one field's change from `before` to `after`; null for a change that says nothing. */
export function fieldLine<E extends HistoryEntry = HistoryEntry>(key: string, field: string, before: unknown, after: unknown): HistoryLine<E> | null {
  const s = describe(field, before, after);
  return s && { key, ...s };
}

/**
 * A move to another project (PLNR-448) as one line: "moved the issue from Sites to Dromo (was RSVA-3), dropping label ui
 * and out of Cycle 4". The state and labels it mapped are part of it, not lines of their own; a project's name is the
 * screen's, the old key the entry's own text.
 */
function moveLine<E extends HistoryEntry>(e: E): HistoryLine<E> {
  const parts: HistoryPart[] = ["moved the issue from ", { project: e.p.projectId }, " to ", { project: e.d.projectId }];
  if (e.was) parts.push(` (was ${e.was})`);
  if (e.dropped?.length) parts.push(`, dropping label${e.dropped.length > 1 ? "s" : ""} `, ...list(e.dropped.map((id) => [{ label: id }])));
  if (e.p.cycleId && !e.d.cycleId) parts.push(e.dropped?.length ? " and out of " : ", out of ", { cycle: e.p.cycleId });
  return { key: `${e.id}:projectId`, icon: { kind: "move" }, parts };
}

/** The lines of one entry, one per changed field; what GitHub did is one line, carrying the entry. A move is one line. */
export function historyLines<E extends HistoryEntry>(e: E): HistoryLine<E>[] {
  if (e.gh) return [{ key: `${e.id}:github`, icon: { kind: "github" }, parts: [], github: e }];
  if (e.a === "A") return [{ key: `${e.id}`, icon: { kind: "archive" }, parts: ["archived the issue"] }];
  if ("projectId" in e.d) return [moveLine(e)];
  const out: HistoryLine<E>[] = [];
  for (const [k, after] of Object.entries(e.d)) {
    const line = fieldLine<E>(`${e.id}:${k}`, k, e.p[k], after);
    if (line) out.push(line);
  }
  return out;
}

/** What an issue started with, after "created": " in Backlog · security, proposed · for Robin · High". Empty when it started with nothing set. */
export function createdWith(d: Record<string, unknown>): HistoryPart[] {
  const groups: HistoryPart[][] = [];
  if (typeof d.stateId === "string") groups.push(["in ", { state: d.stateId, glyph: true }]);
  if (Array.isArray(d.labelIds) && d.labelIds.length) groups.push(list((d.labelIds as string[]).map((id) => [{ label: id }])));
  if (Array.isArray(d.assigneeIds) && d.assigneeIds.length) groups.push(["for ", ...list((d.assigneeIds as string[]).map((id) => [{ user: id }]))]);
  if (typeof d.delegateId === "string") groups.push(["delegated to ", { user: d.delegateId }]);
  if (typeof d.priority === "number" && d.priority) groups.push([{ priority: d.priority }]);
  return groups.flatMap((g, i) => [i === 0 ? " " : " · ", ...g]);
}

/** One event of the activity: a line with its time and actor. */
export interface HistoryEvent<E extends HistoryEntry = HistoryEntry> {
  kind: "event";
  at: string;
  by: string | null;
  line: HistoryLine<E>;
  /** The states of a state change, for a folded run. */
  move?: { from: string | null; to: string | null };
  /** A change of one single-value field, for a folded run of corrections. */
  edit?: Edit;
  /** Where it was made when not in the app or the API: the line ends with it. */
  via?: string;
}

/** Saves of the description by one person within this long read as one line. */
const DESCRIPTION_MERGE_MS = 60 * 60 * 1000;
/** Fields one act joins into a line. A state change folds its own way, a description merges by the hour. */
const JOINS = /:(title|priority|assigneeIds|labelIds|blockedByIds|relatedIds|duplicateOfId|delegateId|parentId|startDate|dueDate|cycleId)$/;
/** Fields with one value, so a run of changes has a first and a last. Assignees, labels and relations add and remove. */
const FOLDS = new Set(["title", "priority", "startDate", "dueDate", "cycleId", "parentId", "delegateId"]);

/**
 * The issue's history as the activity shows it, oldest first: its creation when `created` (the first page is in; drawn
 * from the issue, so imported issues have it too), a description's autosaves as one line per sitting, corrections of one
 * field as their result, and the changes of one act as one line.
 */
export function historyEvents<E extends HistoryEntry>(issue: { createdAt: string; createdById: string | null }, history: readonly E[], created: boolean): HistoryEvent<E>[] {
  const out: HistoryEvent<E>[] = created ? [{ kind: "event", at: issue.createdAt, by: issue.createdById, line: { key: "created", icon: { kind: "person", user: issue.createdById }, parts: ["created the issue"] } }] : [];
  for (const e of history) {
    for (const line of historyLines(e)) {
      const last = out.at(-1);
      // Autosave writes the description many times a minute: one line per sitting.
      if (last && line.key.endsWith(":description") && last.line.key.endsWith(":description") && last.by === e.by && Date.parse(e.at) - Date.parse(last.at) < DESCRIPTION_MERGE_MS) {
        last.at = e.at;
        continue;
      }
      const field = line.key.slice(line.key.indexOf(":") + 1);
      out.push({
        kind: "event",
        at: e.at,
        by: e.by,
        line,
        ...(e.via ? { via: e.via } : {}),
        ...(field === "stateId" ? { move: { from: e.p.stateId as string | null, to: e.d.stateId as string | null } } : {}),
        ...(FOLDS.has(field) ? { edit: { field, from: e.p[field], to: e.d[field] } } : {}),
      });
    }
  }
  return joinActs(
    foldEdits(out, (first, edit) => ({ ...first, line: fieldLine<E>(first.line.key, edit.field, edit.from, edit.to) ?? first.line })),
    (e) => JOINS.test(e.line.key),
    (run) => ({ ...run[0]!, at: run.at(-1)!.at, line: { ...run[0]!.line, parts: list(run.map((e) => e.line.parts)) } }),
  ).map((e) => {
    const words = viaWords(e.via);
    return words ? { ...e, line: { ...e.line, parts: [...e.line.parts, ` · ${words}`] } } : e;
  });
}

/** A folded run of state changes after the actor's name: "changed the state 8 times in 4 min: Backlog → In review". */
export function foldParts(run: readonly { at: string; move?: { from: string | null; to: string | null } }[]): HistoryPart[] {
  const took = Math.round((Date.parse(run.at(-1)!.at) - Date.parse(run[0]!.at)) / 60_000);
  return ["changed the state ", { em: `${run.length} times` }, ...(took > 0 ? [{ aside: ` in ${took} min` }] : []), ": ", { state: run[0]!.move!.from, glyph: true }, " → ", { state: run.at(-1)!.move!.to, glyph: true }];
}
