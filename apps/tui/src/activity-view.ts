// The Activity screen's view (RSVA-643): the workspace's latest across every project, as the web's project History
// folds it (packages/display project-history.ts) at Steps, made from the engine's copy and its live history of the whole
// workspace (projectHistory(null)). An issue's day is one row: what it went through, or its one step in the issue
// screen's words; an open issue that waits on open ones says on which.
//
// Considered: the Inbox (what is addressed to the viewer, not everything), the issue's own activity across issues (a
// request per issue), a log kept in the TUI from deltas only (nothing from before it started). The server's project
// history read for the whole workspace gives the past in pages and the deltas the present, with the web's folding.
import { dayTotals, foldHistory, isAgentIn, oneLine, stateKindIn, stepsOf, type Day, type Row, type Step } from "@rsva/display/project-history";
import { createdWith, historyLines } from "@rsva/display/history";
import { clockTime, dayLabel } from "@rsva/display/time";
import type { Issue } from "@rsva/schema/models";
import type { ProjectHistoryFeed, SyncStore } from "@rsva/sync";
import { plain } from "@rsva/terminal/text";
import { DOT, githubRow, markOf, QUIET, SAID, sentence, someone, stateMark, type HomeSource } from "./home-view.ts";
import type { Seg } from "./widgets.ts";

/** The level the screen reads: every move, assignment, comment and merge, an issue's day folded into one row. */
export const ACTIVITY_LEVEL = "steps";

/** One row: an issue's day, or one change of it. */
export interface ActivityItem {
  /** The row's own key, the same while it stays: the cursor keeps its row as new ones come above it. */
  id: string;
  issueId: string;
  /** The clock time of its last step. */
  when: string;
  mark: Seg;
  key: string;
  title: string;
  /** What happened, in the issue screen's words. */
  what: Seg[];
  who: string;
  /** What an open issue waits on now: "waiting · needs RSVA-640 ◐ In Review", on its newest row only; null when it waits on nothing. */
  waiting: Seg[] | null;
}

interface ActivityDay {
  label: string;
  /** "3 closed · 2 PRs merged": what the day got done. */
  totals: string;
  items: ActivityItem[];
}

export interface ActivityView {
  workspace: string;
  status: ProjectHistoryFeed["status"];
  /** More history before the loaded pages; `loadingOlder` while one is asked for. */
  older: boolean;
  loadingOlder: boolean;
  days: ActivityDay[];
}

type Source = HomeSource & Pick<SyncStore, "projectHistory">;

/** An issue's open blockers, at most three named: "waiting · needs RSVA-640 ◐ In Review, DROMO-3 ○ Todo +1". */
function waitingOf(s: HomeSource, issue: Issue): Seg[] | null {
  const open = (i: Issue) => {
    const g = s.states.get(i.stateId)?.group;
    return !i.deletedAt && !i.archivedAt && g !== "completed" && g !== "cancelled";
  };
  if (!open(issue)) return null;
  const blockers = s.relationsOf(issue.id).blockedBy.filter(open);
  if (!blockers.length) return null;
  const named = blockers.slice(0, 3).flatMap((b, i): Seg[] => {
    const st = s.states.get(b.stateId);
    const m = st && stateMark(s, st);
    return [...(i ? [[", ", QUIET] as Seg] : []), [s.issueKey(b), SAID], ...(m ? ([[` ${m.glyph} `, { fg: m.tone }], [m.name, QUIET]] as Seg[]) : [])];
  });
  const more = blockers.length > 3 ? [[` +${blockers.length - 3}`, QUIET] as Seg] : [];
  return [["◌ ", { fg: "ink-3" }], ["waiting", QUIET], [" · needs ", QUIET], ...named, ...more];
}

/** One step in the issue screen's words, with its mark. */
function stepLine(s: HomeSource, step: Step): { mark: Seg; text: Seg[] } {
  if (step.kind === "created") {
    const with_ = step.with ? sentence(s, createdWith(step.with)) : [];
    return { mark: ["+", { fg: "ink-3" }], text: [["created", QUIET], ...with_] };
  }
  if (step.kind === "comment") {
    const line = oneLine(step.comment.x, (id) => s.users.get(id)?.email);
    return { mark: ["“", { fg: "ink-3" }], text: [["commented ", QUIET], [plain(line), SAID]] };
  }
  const e = step.entry;
  if (e.gh) {
    const row = githubRow(s, e, e.gh);
    return { mark: row.mark, text: row.text };
  }
  const lines = historyLines(e);
  const first = lines[0];
  if (!first) return { mark: DOT, text: [] };
  return { mark: markOf(s, first.icon), text: lines.flatMap((l, i) => [...(i ? [[" · ", QUIET] as Seg] : []), ...sentence(s, l.parts)]) };
}

/** A row of the folded history as a line: a story by the states it went through and how many steps; a step in its words. */
function itemOf(s: HomeSource, row: Exclude<Row, { kind: "setting" }>): ActivityItem | null {
  const issueId = row.kind === "story" ? row.issueId : row.step.issueId;
  const issue = s.issues.get(issueId);
  if (!issue || issue.deletedAt) return null;
  const base = { id: row.key, issueId, key: s.issueKey(issue), title: plain(issue.title), waiting: waitingOf(s, issue) };
  if (row.kind === "step") {
    const { mark, text } = stepLine(s, row.step);
    return { ...base, when: clockTime(row.step.at), mark, what: text, who: someone(s, row.step.by) };
  }
  const states = row.chain.flatMap((l): Seg[] => {
    if (l.kind === "created") return [["+", { fg: "ink-3" }]];
    const st = s.states.get(l.stateId);
    if (!st) return [];
    const m = stateMark(s, st);
    return [[m.glyph, { fg: m.tone }]];
  });
  const chain = states.flatMap((seg, i): Seg[] => (i ? [[" → ", { fg: "faint" }], seg] : [seg]));
  // A day of no moves (comments, assignments) says its last step.
  const what = chain.length > 1 ? chain : stepLine(s, row.steps.at(-1)!).text;
  const pulls = row.pulls.map((p): Seg => [` #${p.number}`, { fg: p.merged ? "status-done" : "ink-2" }]);
  // The state it ended the day in; a day of no moves, the state it is in now.
  const ended = [...row.chain].reverse().find((l) => l.kind === "state");
  const st = s.states.get(ended?.kind === "state" ? ended.stateId : issue.stateId);
  const mark: Seg = st ? [stateMark(s, st).glyph, { fg: stateMark(s, st).tone }] : DOT;
  return {
    ...base,
    when: clockTime(row.to),
    mark,
    what: [...what, ...pulls, [` · ${row.steps.length} steps`, QUIET]],
    who: row.by.map((id) => someone(s, id)).join(", "),
  };
}

/** A day of the folded history as the screen shows it; the workspace's own changes (states, labels) are not issues' and stay out. */
function dayOf(s: HomeSource, d: Day, now: number): ActivityDay {
  const items = d.rows.flatMap((r) => (r.kind === "setting" ? [] : (itemOf(s, r) ?? [])));
  return { label: dayLabel(`${d.key}T12:00:00`, now), totals: dayTotals(d.agents, d.people).map((t) => t.text).join(" · "), items };
}

/** The screen's view now: the live history of the whole workspace, folded into days. Reading it asks for the history once. */
export function activityView(s: Source, workspace: string, now: number): ActivityView {
  const feed = s.projectHistory(null, ACTIVITY_LEVEL);
  const issues = [...s.issues.values()].filter((i) => !i.deletedAt);
  const steps = stepsOf(issues, feed.entries, feed.comments, feed.older);
  const days = foldHistory(steps, { level: ACTIVITY_LEVEL, who: "all", isAgent: (id) => isAgentIn(s, id), stateKind: (id) => stateKindIn(s, id) })
    .map((d) => dayOf(s, d, now))
    .filter((d) => d.items.length);
  // What an issue waits on is now: said once, on its newest row.
  const said = new Set<string>();
  for (const d of days) for (const it of d.items) if (said.has(it.issueId)) it.waiting = null; else said.add(it.issueId);
  return { workspace, status: feed.status, older: feed.hasOlder, loadingOlder: feed.loadingOlder, days };
}
