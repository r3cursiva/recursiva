// A new issue from one line (PLNR-438): `c` on the list, `C` for a sub-issue of the issue under the cursor. The line is
// the query language with its short forms, read as Telegram's /new reads it (packages/query, issueFields): #PLNR the
// project, @ann an assignee, !high the priority, +bug a label, state: cycle: due: start: parent: agent:; the free text
// is the title. While it is typed the card under it, in one panel over the screen dimmed (RSVA-463), is the issue as it
// would be created, with up to three open issues that look like it, so nothing goes in that the person did not see.
//
// Considered: a form of fields as the web's create panel (more keys to learn, a field per property in 24 rows), and the
// person's $EDITOR on a template (a round trip for a one-line issue). One line keeps the TUI's keyboard pace and is the
// language the filter and the bot already speak; ⌃E opens the editor for a description when one is wanted.
import { similarIssues } from "@rsva/protocol/similar";
import { errorSentence, inProject, issueFields, parseQuery, type QueryContext } from "@rsva/query";
import { blankIssueFields, defaultState, TITLE_MAX, type Issue, type IssuePatch } from "@rsva/schema/models";
import type { Card } from "./home.ts";
import { cardOf, detailsOf, type HomeSource } from "./home-view.ts";
import type { IssueDetails } from "./issue.ts";
import { contextOf, type Source } from "./view.ts";

/** The line being typed, and what came with it: the parent of a sub-issue, a description from the editor. */
export interface Creating {
  text: string;
  /** The default project: the issue under the cursor's when `c` was pressed; #KEY in the line wins. */
  projectId: string | null;
  parentId: string | null;
  description: string;
  /** The completion picked, as the query field's. */
  completion: number;
}

export type CreateSource = Source & HomeSource;

/** What the line makes: where, with which fields, the title; the first reason it cannot be created yet, if any. */
export interface Draft {
  projectId: string | null;
  set: IssuePatch & { stateId?: string };
  title: string;
  error: string | null;
}

/** Up to how many similar open issues the card lists, from how many characters of title, as the web's create panel. */
const SIMILAR = 3;
const SIMILAR_FROM = 3;

/**
 * The project the line puts the issue in (#KEY, else the parent's, else the one `c` started in), and the names it reads
 * against: that project's states, labels and cycles, as the server reads them (inProject).
 */
export function lineContext(s: CreateSource, c: Creating): { ctx: QueryContext; projectId: string | null; projects: number } {
  const all = contextOf(s);
  const named = parseQuery(c.text, all).filter.project ?? [];
  const parent = c.parentId ? s.issues.get(c.parentId) : undefined;
  const projectId = named[0] ?? parent?.projectId ?? c.projectId;
  return { ctx: projectId ? inProject(all, projectId) : all, projectId, projects: named.length };
}

export function draftOf(s: CreateSource, c: Creating): Draft {
  const { ctx, projectId, projects } = lineContext(s, c);
  const { filter, errors } = parseQuery(c.text, ctx);
  let error = errors.length ? errorSentence(c.text, errors[0]!) : null;
  if (projects > 1) error ??= "One project only.";
  const parent = c.parentId ? s.issues.get(c.parentId) : undefined;
  if (!projectId) return { projectId: null, set: {}, title: "", error: error ?? "Which project? Name it with #, as #plnr." };
  const read = issueFields(filter, ctx, projectId);
  if ("error" in read) error ??= read.error;
  const set: Draft["set"] = { ...(parent ? { parentId: parent.id } : {}), ...("error" in read ? {} : read.set) };
  const fallback = defaultState(s.statesOf(projectId))?.id;
  if (!set.stateId && fallback) set.stateId = fallback;
  const title = ("error" in read ? (filter.text ?? "").trim() : read.title).slice(0, TITLE_MAX);
  return { projectId, set, title, error };
}

/** The draft as the issue it would be, for the card's painters: the row the engine shows until the server echoes it. */
function draftIssue(s: CreateSource, d: Draft & { projectId: string; set: { stateId: string } }, now: number): Issue {
  const at = new Date(now).toISOString();
  return { id: "", projectId: d.projectId, number: 0, ...blankIssueFields(), sortOrder: "", createdById: s.me?.id ?? null, createdAt: at, updatedAt: at, completedAt: null, archivedAt: null, deletedAt: null, formerKeys: [], ...d.set, title: d.title };
}

/** How to write the line: the card's text before a title, and the status line's at 80 columns, where the card is folded. */
export const HOW = "Type a title. #project @person !priority +label, and state: cycle: due: start: parent: agent: set the rest; Tab completes.";

/** The card under the line while it is typed: the new issue with its fields, the description, issues that look like it. */
export function draftCard(s: CreateSource, c: Creating, d: Draft, now: number): { card: Card; details: IssueDetails } | null {
  const { projectId, set } = d;
  if (!projectId || !set.stateId) return null;
  const issue = draftIssue(s, { ...d, projectId, set: { ...set, stateId: set.stateId } }, now);
  const similar =
    d.title.length >= SIMILAR_FROM ? similarIssues(d.title, s.issues.values(), (x) => s.states.get(x.stateId)?.group, { limit: SIMILAR, projectId }).map(({ issue: x }) => `- ${s.issueKey(x)} ${x.title}`) : [];
  const parts = [c.description.trim() || (d.title ? "" : HOW), similar.length ? `Open issues that look like it:\n\n${similar.join("\n")}` : ""].filter(Boolean);
  const key = s.projects.get(projectId)?.key ?? "?";
  const details = detailsOf(s, issue, now);
  return {
    card: { ...cardOf(s, issue, now, details), key: `New ${key} issue`, title: d.title || "Untitled", updated: null, description: parts.join("\n\n"), actions: [["↵", "create"]] },
    details: { ...details, draft: true },
  };
}
