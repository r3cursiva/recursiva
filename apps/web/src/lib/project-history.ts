// The project's Timeline (PLNR-71, PLNR-120), folded: the steps of the loaded history (creations from the issues, changes
// and comments from the feed) grouped by local day, newest first. At "outcomes" and "steps" an issue's day is one story,
// the chain of states it went through with its steps under it, closed and open by default; an issue with one step that
// day reads as that step. "everything" is the plain log, with the project's own changes (its states and labels) among the
// issues'. Each day carries a summary of what agents and people did. Pure: the screen passes what it reads from the store.
import type { HistoryLevel, ProjectComment, ProjectHistoryEntry, ProjectSettingEntry } from "@rsva/protocol";
import { localDay } from "@rsva/schema/days";
import { groupBy } from "@rsva/schema/util";
import { plural } from "@rsva/schema/util";

export type Who = "all" | "agents" | "people";

/** One thing that happened to an issue. A creation says what the issue started with when its log action came (`with`). */
export type Step =
  | { kind: "created"; at: string; by: string | null; issueId: string; with?: Record<string, unknown> }
  | { kind: "entry"; at: string; by: string | null; issueId: string; entry: ProjectHistoryEntry }
  | { kind: "comment"; at: string; by: string | null; issueId: string; comment: ProjectComment };

/** A link of a story's chain: the issue's creation or a state it was in. */
export type ChainLink = { kind: "created" } | { kind: "state"; stateId: string };

export type Row =
  /** An issue's day: how its state went, by whom, its pull requests, from the first step to the last. */
  | { kind: "story"; key: string; issueId: string; from: string; to: string; by: string[]; chain: ChainLink[]; pulls: Pull[]; steps: Step[] }
  | { kind: "step"; key: string; step: Step }
  /** A change of the project's own: a state or a label. */
  | { kind: "setting"; key: string; entry: ProjectSettingEntry };

/** A pull request in a story, and whether the day merged it. */
export interface Pull {
  number: number;
  merged: boolean;
}

/** What one side did in a day. */
export interface Tally {
  created: number;
  review: number;
  approved: number;
  done: number;
  canceled: number;
  merged: number;
  opened: number;
  comments: number;
}

export interface Day {
  /** Local date, YYYY-MM-DD. */
  key: string;
  rows: Row[];
  agents: Tally;
  people: Tally;
}

/** What a state means for the summary: the issue was finished or dropped, asked for review or approved. */
export type StateKind = "done" | "canceled" | "review" | "approved" | "other";

export interface FoldContext {
  level: HistoryLevel;
  who: Who;
  isAgent(userId: string | null): boolean;
  stateKind(stateId: string): StateKind;
}

const time = (iso: string) => Date.parse(iso);

/** The local day of a time, YYYY-MM-DD. */
export const dayKey = (iso: string): string => localDay(new Date(time(iso)));

/**
 * Every step of the loaded history, oldest first. Creations count only after `since`, where the loaded history starts; an
 * issue's I entry is not a step of its own, it says what the creation started with.
 */
export function stepsOf(
  issues: Iterable<{ id: string; createdAt: string; createdById: string | null }>,
  entries: readonly ProjectHistoryEntry[],
  comments: readonly ProjectComment[],
  since: string | null,
): Step[] {
  const from = since === null ? -Infinity : time(since);
  const out: Step[] = [];
  const started = new Map<string, Record<string, unknown>>();
  for (const e of entries) {
    if (e.a === "I") started.set(e.i, e.d);
    else out.push({ kind: "entry", at: e.at, by: e.by, issueId: e.i, entry: e });
  }
  for (const i of issues) {
    if (time(i.createdAt) <= from) continue;
    const d = started.get(i.id);
    out.push({ kind: "created", at: i.createdAt, by: i.createdById, issueId: i.id, ...(d && { with: d }) });
  }
  for (const c of comments) out.push({ kind: "comment", at: c.at, by: c.by, issueId: c.i, comment: c });
  return out.sort((a, b) => time(a.at) - time(b.at));
}

const emptyTally = (): Tally => ({ created: 0, review: 0, approved: 0, done: 0, canceled: 0, merged: 0, opened: 0, comments: 0 });

function count(t: Tally, s: Step, ctx: FoldContext): void {
  if (s.kind === "created") t.created++;
  else if (s.kind === "comment") t.comments++;
  else {
    // A move to another project (PLNR-448) maps the state it had: no step of its work.
    if (typeof s.entry.d.stateId === "string" && !("projectId" in s.entry.d)) {
      const k = ctx.stateKind(s.entry.d.stateId);
      if (k !== "other") t[k]++;
    }
    const gh = s.entry.gh;
    if (gh?.number != null && gh.verb === "merged") t.merged++;
    if (gh?.number != null && gh.verb === "opened") t.opened++;
  }
}

/** The pull requests GitHub reported in the steps, in order; a merged one stays merged. */
export function pullsOf(steps: readonly Step[]): Pull[] {
  const pulls = new Map<number, boolean>();
  for (const s of steps) {
    const gh = s.kind === "entry" ? s.entry.gh : undefined;
    if (gh?.number != null) pulls.set(gh.number, !!pulls.get(gh.number) || gh.verb === "merged");
  }
  return [...pulls].map(([number, merged]) => ({ number, merged }));
}

const stepKey = (s: Step) => (s.kind === "created" ? `c:${s.issueId}` : s.kind === "entry" ? `e:${s.entry.id}` : `m:${s.comment.id}`);

const stepRow = (step: Step): Row => ({ kind: "step", key: stepKey(step), step });

function story(issueId: string, day: string, steps: Step[]): Row {
  if (steps.length === 1) return stepRow(steps[0]!);
  const chain: ChainLink[] = [];
  for (const s of steps) {
    if (s.kind === "created") chain.push({ kind: "created" });
    else if (s.kind === "entry" && typeof s.entry.d.stateId === "string" && !("projectId" in s.entry.d)) {
      // The state it started the day in, when the day did not begin with its creation.
      if (!chain.length && typeof s.entry.p.stateId === "string") chain.push({ kind: "state", stateId: s.entry.p.stateId });
      chain.push({ kind: "state", stateId: s.entry.d.stateId });
    }
  }
  const by = [...new Set(steps.map((s) => s.by).filter((x): x is string => !!x))];
  return { kind: "story", key: `${day}:${issueId}`, issueId, from: steps[0]!.at, to: steps.at(-1)!.at, by, chain, pulls: pullsOf(steps), steps };
}

/** The loaded history as days, newest first; within a day, the latest story or step first. `settings` count at "everything". */
export function foldHistory(steps: readonly Step[], ctx: FoldContext, settings: readonly ProjectSettingEntry[] = []): Day[] {
  const days = groupBy(steps, (s) => dayKey(s.at));
  const shown = (s: { by: string | null }) => ctx.who === "all" || (ctx.who === "agents") === ctx.isAgent(s.by);
  const changes = new Map<string, Row[]>();
  if (ctx.level === "everything") {
    for (const e of settings) {
      if (!shown(e)) continue;
      const k = dayKey(e.at);
      const row: Row = { kind: "setting", key: `s:${e.id}`, entry: e };
      const list = changes.get(k);
      if (list) list.push(row);
      else changes.set(k, [row]);
      if (!days.has(k)) days.set(k, []);
    }
  }
  const out: Day[] = [];
  for (const [key, all] of days) {
    const day: Day = { key, rows: [], agents: emptyTally(), people: emptyTally() };
    for (const s of all) count(ctx.isAgent(s.by) ? day.agents : day.people, s, ctx);
    const mine = all.filter(shown);
    if (ctx.level !== "everything") {
      day.rows = [...groupBy(mine, (s) => s.issueId)].map(([issueId, list]) => story(issueId, key, list));
    } else {
      day.rows = [...mine.map(stepRow), ...(changes.get(key) ?? [])];
    }
    day.rows.sort((a, b) => time(lastAt(b)) - time(lastAt(a)));
    out.push(day);
  }
  return out.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

const lastAt = (r: Row) => (r.kind === "story" ? r.to : r.kind === "setting" ? r.entry.at : r.step.at);


/** One figure of a day's header: its words with the total, and how agents and people split it. */
export interface Total {
  kind: keyof Tally;
  text: string;
  agents: number;
  people: number;
}

/** The header's figures in the order they read, with the noun a count of pull requests takes. */
const TOTALS: readonly (readonly [keyof Tally, string, string?])[] = [
  ["done", "closed"],
  ["merged", "merged", "PR"],
  ["opened", "opened", "PR"],
  ["review", "to review"],
  ["approved", "approved"],
  ["created", "created"],
  ["canceled", "canceled"],
];

/**
 * "39 closed", "84 PRs merged", "48 created": what the day got done, both sides together; empty when nothing happened.
 * Comments are the work, not its result: they count only on a day with nothing else.
 */
export function dayTotals(agents: Tally, people: Tally): Total[] {
  const total = (kind: keyof Tally, word: (n: number) => string): Total => ({ kind, text: word(agents[kind] + people[kind]), agents: agents[kind], people: people[kind] });
  const out = TOTALS.filter(([k]) => agents[k] + people[k] > 0).map(([k, word, noun]) => total(k, (n) => `${noun ? plural(n, noun) : n} ${word}`));
  if (out.length || agents.comments + people.comments === 0) return out;
  return [total("comments", (n) => plural(n, "comment"))];
}

/** How long a story took: "40m", "2h 10m", "1d 3h"; nothing for less than a minute. */
export function span(from: string, to: string): string {
  const m = Math.round((time(to) - time(from)) / 60_000);
  if (m < 1) return "";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

/**
 * A comment's start as one line of plain text: mentions and links read as their labels, Markdown marks and escapes go.
 * `name` reads a mention Plane wrote as `@[<user id>]`; one of nobody we know says nothing and leaves the line.
 */
export function oneLine(md: string, name: (userId: string) => string | undefined = () => undefined): string {
  return md
    .replace(/\\\n/g, " ")
    .replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, "$1")
    .replace(/@\[([0-9a-f-]{36})\]/g, (_, id: string) => { const n = name(id); return n ? `@${n}` : ""; })
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
