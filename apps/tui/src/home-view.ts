// The home screen's view from the copy: what home.ts paints, worded and coloured as the design canvas has it. Text
// from the server is cleaned here (`plain`), as the CLI cleans the server's answer, before it reaches a cell.
import { similarIssues } from "@rsva/protocol/similar";
import { stateGlyph } from "@rsva/terminal/issues";
import { plain } from "@rsva/terminal/text";
import type { DocNode } from "@rsva/editor/doc";
import { toMarkdown } from "@rsva/editor/markdown";
import { priorityName, pullUrl, SHA_SHOWN, startedStage, type GithubEvent, type Issue, type WorkflowState } from "@rsva/schema/models";
import type { Comment, HistoryEntry, IssueFeed, SyncStore } from "@rsva/sync";
import type { AgentMark, Card, Field, Group, Row } from "./home.ts";
import { clicking, type LabelMark, type Priority, type Seg, type StateMark } from "./widgets.ts";
import { groupBy } from "@rsva/schema/util";
import type { ActivityRow, CommentView, IssueDetails, IssueView } from "./issue.ts";
import { TILE, type Token } from "./theme.ts";
import { tileTone } from "@rsva/display/tile";
import { avatarTone, initials } from "@rsva/display/avatar";
import { clockOrDate, clockTime, compactAge, dayRange, shortDate } from "@rsva/display/time";
import { byTime, commentCount, layOut } from "@rsva/display/activity-rows";
import { checksName, githubWords, pullLive } from "@rsva/display/github";
import { foldParts, historyEvents, REMOVED, viaWords, type HistoryEvent, type HistoryIcon, type HistoryPart } from "@rsva/display/history";
import type { Item } from "./view.ts";

export type HomeSource = Pick<
  SyncStore,
  "me" | "issues" | "states" | "labels" | "users" | "cycles" | "projects" | "issueKey" | "relationsOf" | "attachmentsOf" | "description" | "statesOf" | "githubOf"
>;

// The app's six colours (ADR 0008): a group's, or a started state's by its stage. Anything else is in progress.
const TONE: Record<string, Token> = {
  backlog: "status-backlog",
  unstarted: "status-todo",
  completed: "status-done",
  cancelled: "status-canceled",
  progress: "status-progress",
  review: "status-review",
  approved: "status-approved",
};

/** The CLI's glyph by group; the colour by the state's place in the app's six: started ones by their order. */
export function stateMark(s: Pick<HomeSource, "statesOf">, st: WorkflowState): StateMark {
  const key = startedStage(s.statesOf(st.projectId), st.id) ?? st.group;
  return { name: plain(st.name), glyph: stateGlyph(st.group), tone: Object.hasOwn(TONE, key) ? TONE[key]! : "status-progress" };
}

/** "Nov 3 – 16" in one month, "Oct 28 – Nov 3" across two. */
const dates = (start: string | null, end: string | null) => (start && end ? dayRange(start, end, true) : "");

/** "4m", "3h", "2d": how long ago, as the canvas writes it. */
export const ago = (iso: string, now: number): string => compactAge(now - Date.parse(iso));

/** An issue's labels with their swatches, as the row and the card show them; a label the store lost is left out. */
const labelsOf = (s: Pick<HomeSource, "labels">, i: Issue) =>
  i.labelIds.flatMap((id) => {
    const l = s.labels.get(id);
    return l ? [{ name: plain(l.name), swatch: swatch(l.color) }] : [];
  });

/** A person's name as the issue screen shows it: the name, else the email, else "?". */
const nameOf = (u: { name?: string; email?: string } | undefined) => plain(u?.name || u?.email || "?");

const email = (s: Pick<HomeSource, "users">, id: string | null) => (id ? plain(s.users.get(id)?.email ?? "?") : null);


/** A link's site, named as people say it: Figma, GitHub; any other by its host. */
const site = (url: string) => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return ({ "figma.com": "Figma", "github.com": "GitHub", "linear.app": "Linear", "notion.so": "Notion" } as Record<string, string>)[host] ?? host;
  } catch {
    return url;
  }
};

/** An issue's relations by kind, in the order the panel and the card name them. */
function relationsByKind(s: Pick<HomeSource, "relationsOf">, i: Issue): [string, Issue[]][] {
  const rel = s.relationsOf(i.id);
  return [
    ["blocked by", rel.blockedBy],
    ["blocks", rel.blocks],
    ["related", rel.related],
    ["duplicate of", rel.duplicateOf ? [rel.duplicateOf] : []],
    ["duplicates", rel.duplicates],
  ];
}

/** How many open issues the queue's card lists as similar to a proposal. */
const SIMILAR_SHOWN = 3;

/**
 * The card's `similar` field for a proposal (PLNR-295): up to three other open issues of the workspace whose titles look like
 * its own, best first, as the web's create panel and the API score them. Null when there are none.
 */
export function similarField(s: Pick<HomeSource, "issues" | "states" | "issueKey">, i: Issue): Field | null {
  const found = similarIssues(i.title, s.issues.values(), (x) => s.states.get(x.stateId)?.group, { limit: SIMILAR_SHOWN, exclude: i.id, projectId: i.projectId });
  if (!found.length) return null;
  return { label: "similar", lines: found.map(({ issue }): Seg[] => clicking([[plain(s.issueKey(issue)), { fg: "ink-2" }], [`  ${plain(issue.title)}`, { fg: "ink-3" }]], `issue:${plain(s.issueKey(issue))}`)) };
}

/** The card's fields, said from the properties panel's content: an empty one is left out, but the delegate (PLNR-398). */
function fieldsOf(d: IssueDetails, labels: LabelMark[]): Field[] {
  const out: Field[] = [];
  if (labels.length) out.push({ label: "labels", lines: [labels.flatMap((l, n): Seg[] => [["▪", { fg: l.swatch }], [` ${l.name}${n < labels.length - 1 ? "  " : ""}`, { fg: "ink-2" }]])] });
  if (d.assignees.length) out.push({ label: "assignees", lines: [[[d.assignees.map((a) => a.email).join(", "), { fg: "ink" }]]] });
  // The delegate's empty line says how to dispatch.
  out.push({ label: "delegate", lines: [d.delegate ? [[d.delegate.email, { fg: "ink" }]] : [["—", { fg: "faint" }], ["   d dispatches to an agent", { fg: "ink-3" }]]] });
  // A click on an issue's key opens it, on a link or a pull request the browser (RSVA-479).
  if (d.parent) out.push({ label: "parent", lines: [clicking([[d.parent.key, { fg: "ink-3" }], [`  ${d.parent.title}`, { fg: "ink" }]], `issue:${d.parent.key}`)] });
  const relSegs = [...groupBy(d.relations, (r) => r.kind)].flatMap(([name, list], n): Seg[] => [[`${n ? "  " : ""}${name} `, { fg: "ink-3" }], ...list.map((x, i): Seg => [`${i ? " " : ""}${x.key}`, { fg: "ink-2", click: `issue:${x.key}` }])]);
  if (relSegs.length) out.push({ label: "relations", lines: [relSegs] });
  if (d.links.length) out.push({ label: "links", lines: d.links.map((l): Seg[] => clicking([[l.site, { fg: "ink", at: "U" }], ...(l.title ? [[`  ${l.title}`, { fg: "ink-3" }] as Seg] : [])], `open:${l.url}`)) });
  if (d.pulls.length)
    out.push({
      label: "pull requests",
      lines: d.pulls.flatMap((p): Seg[][] => {
        const checks: Seg[] = p.checks === "pass" ? [["✓", { fg: "success" }], [` ${checksName("pass", 0).full}`, { fg: "ink-3" }]] : p.checks === "fail" ? [["✗", { fg: "error" }], [` ${checksName("fail", p.failing).full}`, { fg: "ink-3" }]] : p.checks ? [["◌", { fg: "faint" }], [` ${checksName("run", 0).full}`, { fg: "ink-3" }]] : [];
        const lines: Seg[][] = [[[`#${p.number}`, { fg: "ink-2" }], [` ${p.title}`, { fg: "ink" }], [`  ${p.state}`, { fg: "ink-3" }]], ...(checks.length ? [checks] : [])];
        return lines.map((l) => clicking(l, `open:${p.url}`));
      }),
    });
  if (d.project) out.push({ label: "project", lines: [[[d.project.key, { fg: "ink-2" }], ...(d.project.name !== d.project.key ? [[`  ${d.project.name}`, { fg: "ink-3" }] as Seg] : [])]] });
  out.push({ label: "created", lines: [[[d.created.day, { fg: "ink-2" }], ...(d.created.by ? [[`  by ${d.created.by}`, { fg: "ink-3" }] as Seg] : [])]] });
  return out;
}

const swatch = (color: string) => (color.startsWith("#") ? (color as `#${string}`) : ("ink-3" as const));

/** The card's line under its title, from the same content: the first assignee, the first pull request, how many relations. */
function briefOf(d: IssueDetails, labels: LabelMark[]): Card["brief"] {
  const pr = d.pulls[0];
  return {
    labels,
    assignee: d.assignees[0]?.email ?? null,
    pr: pr ? { number: pr.number, state: pr.state, checks: pr.checks } : null,
    parent: d.parent?.key ?? null,
    relations: d.relations.length,
  };
}

/** The properties panel's content (issue.ts, IssueDetails): what the card's fields say, laid out as the TuiIssue artboards. */
export function detailsOf(s: HomeSource, i: Issue, now: number): IssueDetails {
  const project = s.projects.get(i.projectId);
  const parent = i.parentId ? s.issues.get(i.parentId) : undefined;
  const cycle = i.cycleId ? s.cycles.get(i.cycleId) : undefined;
  const inCycle = cycle ? [...s.issues.values()].filter((x) => x.cycleId === cycle.id && !x.deletedAt) : [];
  const kinds = relationsByKind(s, i);
  const person = (id: string) => {
    const u = s.users.get(id);
    const name = nameOf(u);
    return { email: plain(u?.email ?? "?"), initials: initials(name), tone: avatarTone(name) };
  };
  const delegate = i.delegateId ? s.users.get(i.delegateId) : undefined;
  return {
    project: project ? { key: plain(project.key), name: plain(project.name), tile: TILE[project.color ?? tileTone(project.key)] ?? TILE.ink } : null,
    parent: parent ? { key: s.issueKey(parent), title: plain(parent.title) } : null,
    assignees: i.assigneeIds.map(person),
    delegate: i.delegateId ? { email: plain(delegate?.email ?? "?"), agent: delegate?.kind === "agent" } : null,
    cycle: cycle ? { name: `C${cycle.number}`, dates: dates(cycle.startDate, cycle.endDate), done: inCycle.filter((x) => s.states.get(x.stateId)?.group === "completed").length, total: inCycle.length } : null,
    relations: kinds.flatMap(([kind, list]) => list.map((x) => ({ kind, key: s.issueKey(x), mark: stateMark(s, s.states.get(x.stateId)!) }))),
    pulls: s
      .githubOf(i.id)
      .filter((g) => g.kind === "pull" && g.number !== null)
      .map((p) => ({ number: p.number!, title: plain(p.title), state: p.state ?? "", checks: pullLive(p.state) ? p.checks : null, failing: p.failing ?? 0, url: pullUrl(p) })),
    links: s.attachmentsOf(i.id).filter((a) => a.kind === "link").map((l) => ({ site: site(l.url), title: plain(l.title ?? ""), url: l.url })),
    children: [...s.issues.values()]
      .filter((x) => x.parentId === i.id && !x.deletedAt && !x.archivedAt)
      .sort((a, b) => a.number - b.number)
      .map((x) => {
        const st = s.states.get(x.stateId)!;
        const agent = x.delegateId ? s.users.get(x.delegateId)?.kind === "agent" : false;
        const first = x.assigneeIds[0];
        const at = x.completedAt ?? x.updatedAt;
        return {
          key: s.issueKey(x),
          title: plain(x.title),
          mark: stateMark(s, st),
          done: st.group === "completed" || st.group === "cancelled",
          who: agent ? ("agent" as const) : first ? (({ email: _, ...face }) => face)(person(first)) : null,
          when: clockOrDate(at, now),
        };
      }),
    // A moment, in this Mac's zone as the feed has it: `day` reads a date, and a moment's date in UTC may be the day before.
    created: { day: shortDate(i.createdAt), by: email(s, i.createdById) },
    updated: `${ago(i.updatedAt, now)} ago`.replace("now ago", "just now"),
  };
}

/** The card; `details` are the issue's properties when the caller has them already, computed once for both. */
export function cardOf(s: HomeSource, i: Issue, now: number, details = detailsOf(s, i, now)): Card {
  const st = s.states.get(i.stateId)!;
  const cycle = i.cycleId ? s.cycles.get(i.cycleId) : undefined;
  const doc = s.description(i.id)?.doc;
  const labels = labelsOf(s, i);
  return {
    key: s.issueKey(i),
    title: plain(i.title),
    state: stateMark(s, st),
    priority: i.priority as Priority,
    cycle: cycle ? { name: `C${cycle.number}`, dates: dates(cycle.startDate, cycle.endDate) } : null,
    updated: `updated ${ago(i.updatedAt, now)} ago`.replace("updated now ago", "updated just now"),
    fields: fieldsOf(details, labels),
    brief: briefOf(details, labels),
    description: doc ? plain(toMarkdown(doc as DocNode)).replace(/\u0000/g, "") : "",
  };
}

/** What the TUI knows about an agent on an issue: its run and Claude's state. */
export interface AgentOn {
  state: AgentMark["state"];
  model: string;
  startedAt: string;
}

function agentMark(a: AgentOn, now: number): AgentMark {
  if (a.state === "waits") return { state: "waits", text: "waits for you", short: "waits" };
  const word = { running: a.model, idle: "idle", done: "done", failed: "failed" }[a.state];
  return { state: a.state, text: `${word} ${ago(a.startedAt, now)}`, short: a.state === "running" ? ago(a.startedAt, now) : a.state };
}

export function rowsOf(s: HomeSource, items: Item[], agents: ReadonlyMap<string, AgentOn>, now: number): Group[] {
  const groups: Group[] = [];
  for (const { issue, row } of items) {
    const st = s.states.get(issue.stateId)!;
    let g = groups.at(-1);
    if (!g || g.state.name !== plain(st.name)) groups.push((g = { state: stateMark(s, st), rows: [] }));
    const cycle = issue.cycleId ? s.cycles.get(issue.cycleId) : undefined;
    const a = agents.get(row.key);
    const r: Row = {
      key: row.key,
      priority: issue.priority as Priority,
      cycle: cycle ? `C${cycle.number}` : null,
      title: row.title,
      labels: labelsOf(s, issue),
      agent: a ? agentMark(a, now) : null,
    };
    g.rows.push(r);
  }
  return groups;
}

/** A comment as the issue screen shows it: cleaned, by email with the web's avatar; a deleted one kept for its replies. */
function commentView(s: Pick<SyncStore, "users">, feed: IssueFeed, c: Comment): CommentView {
  const u = c.authorId ? s.users.get(c.authorId) : undefined;
  const name = c.authorId ? nameOf(u) : "Imported";
  return {
    author: c.authorId ?? "",
    name,
    initials: initials(name),
    tone: avatarTone(name),
    agent: u?.kind === "agent",
    at: c.createdAt,
    time: clockTime(c.createdAt),
    edited: !!c.editedAt,
    via: viaWords(c.via),
    deleted: !!c.deletedAt,
    body: c.deletedAt ? "" : plain(c.body).replace(/\u0000/g, ""),
    reactions: c.deletedAt ? [] : feed.reactions(c.id).map((g) => ({ emoji: plain(g.emoji), count: g.userIds.length })),
  };
}

const QUIET = { fg: "ink-3" } as const;
const SAID = { fg: "ink-2" } as const;
const DOT: Seg = ["·", { fg: "faint" }];

/** A person in the history, by email as the TUI names people; one the store does not have, as the web says it. */
const someone = (s: Pick<HomeSource, "users">, id: unknown) => {
  const u = typeof id === "string" ? s.users.get(id) : undefined;
  return u ? plain(u.name || u.email) : REMOVED.user;
};

/** A part of a shared history sentence (packages/display history.ts) in cells: words quiet, what changed in ink-2, a state with its glyph, a label with its swatch. */
function partSegs(s: HomeSource, p: HistoryPart): Seg[] {
  if (typeof p === "string") return [[p, QUIET]];
  if ("em" in p) return [[plain(p.em), SAID]];
  if ("aside" in p) return [[p.aside, QUIET]];
  if ("state" in p) {
    const st = typeof p.state === "string" ? s.states.get(p.state) : undefined;
    if (!st) return [[REMOVED.state, SAID]];
    const m = stateMark(s, st);
    return [[`${m.glyph} `, { fg: m.tone }], [m.name, SAID]];
  }
  if ("label" in p) {
    const l = s.labels.get(p.label);
    return l ? [["▪", { fg: swatch(l.color) }], [` ${plain(l.name)}`, SAID]] : [[REMOVED.label, SAID]];
  }
  if ("user" in p) return [[someone(s, p.user), SAID]];
  if ("issue" in p) {
    const i = typeof p.issue === "string" ? s.issues.get(p.issue) : undefined;
    return i ? [[s.issueKey(i), QUIET], [` ${plain(i.title)}`, SAID]] : [[REMOVED.issue, SAID]];
  }
  if ("cycle" in p) return [[typeof p.cycle === "string" ? plain(s.cycles.get(p.cycle)?.name ?? REMOVED.cycle) : "", SAID]];
  if ("project" in p) {
    const pr = typeof p.project === "string" ? s.projects.get(p.project) : undefined;
    return [[pr ? plain(pr.name) : REMOVED.project, SAID]];
  }
  return [[priorityName(p.priority), SAID]];
}

const sentence = (s: HomeSource, parts: readonly HistoryPart[]) => parts.flatMap((p) => partSegs(s, p));

/** A line's one-cell mark: a state change's new state, its glyph in its tone; anything else a quiet dot. */
function markOf(s: HomeSource, icon: HistoryIcon): Seg {
  const st = icon.kind === "state" && typeof icon.state === "string" ? s.states.get(icon.state) : undefined;
  if (!st) return DOT;
  const m = stateMark(s, st);
  return [m.glyph, { fg: m.tone }];
}

/** What GitHub did, in the web's words (githubWords) without its chips: "GitHub moved it from ◐ In Progress to ● Done · #412 Title merged by dan". */
function githubRow(s: HomeSource, e: HistoryEntry, gh: GithubEvent): Pick<Extract<ActivityRow, { kind: "event" }>, "mark" | "who" | "text"> {
  const { line, who, verb, stays } = githubWords(gh, !!e.d.stateId);
  const title: Seg = [` ${plain(gh.title)}`, QUIET];
  const subject: Seg[] = gh.number !== null ? [[`#${gh.number}`, SAID], title] : gh.sha ? [[gh.sha.slice(0, SHA_SHOWN), SAID], title] : [["branch ", QUIET], [plain(gh.title), SAID]];
  if (line === "pushed") return { mark: DOT, who, text: [["pushed ", QUIET], ...subject] };
  const said: Seg[] = [...subject, [` ${verb} by `, QUIET], [plain(gh.by), SAID], ...(stays ? [[". It is linked, so the state stays.", QUIET] as Seg] : [])];
  if (line === "merged") return { mark: ["·", { fg: "status-done" }], who, text: said };
  return { mark: markOf(s, { kind: "state", state: e.d.stateId }), who, text: [...sentence(s, ["moved it from ", { state: e.p.stateId, glyph: true }, " to ", { state: e.d.stateId, glyph: true }, " · "]), ...said] };
}

type Thread = IssueFeed["threads"][number];

/**
 * An issue's activity as the issue screen shows it, as the web's (issue-activity.tsx): its history and its comment
 * threads in time order, with the same words (packages/display history.ts) and the same day marks and folded runs
 * (lib/activity-rows.ts); its creation once the first page is in.
 */
export function activityOf(s: HomeSource & Pick<SyncStore, "feed">, issue: Issue, now: number): IssueView["activity"] {
  const feed = s.feed(issue.id);
  const items: (HistoryEvent<HistoryEntry> | { kind: "thread"; at: string; by: string | null; thread: Thread })[] = [
    ...historyEvents(issue, feed.history, !feed.hasOlder),
    ...feed.threads.map((thread) => ({ kind: "thread" as const, at: thread.comment.createdAt, by: thread.comment.authorId, thread })),
  ].sort(byTime);
  const event = (e: HistoryEvent<HistoryEntry>, line: Pick<Extract<ActivityRow, { kind: "event" }>, "mark" | "who" | "text">): ActivityRow => ({ kind: "event", ...line, when: clockTime(e.at) });
  const rows = layOut(items, now, null, s.me?.id).flatMap((r): ActivityRow[] => {
    if (r.kind === "day") return [{ kind: "day", label: r.label }];
    if (r.kind === "new") return [];
    if (r.kind === "fold") {
      const run = r.items as HistoryEvent<HistoryEntry>[];
      const last = run.at(-1)!;
      return [event(last, { mark: markOf(s, { kind: "state", state: last.move?.to }), who: someone(s, last.by), text: sentence(s, foldParts(run)) })];
    }
    const it = r.item;
    if (it.kind === "thread") return [{ kind: "thread", thread: { ...commentView(s, feed, it.thread.comment), replies: it.thread.replies.map((c) => commentView(s, feed, c)) } }];
    const gh = it.line.github?.gh;
    return [event(it, gh ? githubRow(s, it.line.github!, gh) : { mark: markOf(s, it.line.icon), who: someone(s, it.by), text: sentence(s, it.line.parts) })];
  });
  return { status: feed.status, comments: commentCount(feed.threads), older: feed.hasOlder, rows };
}
