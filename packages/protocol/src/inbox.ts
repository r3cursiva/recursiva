// The inbox (PLNR-26): notifications are not stored, they are read off the log. One function decides whether a log
// action concerns a person and how; the server runs it over the log for the first answer, the client over every delta
// after that, so both sides agree and nothing is fanned out per recipient at write time.
//
// Who hears about what (owner's decisions, 2026-10-28): the people involved in an issue, automatically: its creator,
// assignees and commenters. A move into the review state asks the issue's creator for a review;
// a move into an approved state tells its assignees. A mention (PLNR-27) reaches the person mentioned whether or not
// they are involved: the server puts the people newly mentioned by a comment or a description into the action
// (`mentionIds`), so the classifier never reads the text and the log scan stays small.
//
// Subscriptions (PLNR-28) change only that general traffic, state changes and new comments: Subscribe brings it to
// someone who is not involved, Unsubscribe stops it for someone who is. What is addressed to the person (an assignment,
// a review to approve, an approval, a mention, a reply in their thread) comes either way. The choice holds from the log
// number it was made at, so both sides classify an action the same however late they see it, and unsubscribing keeps
// the notifications already there.
import { startedStage, type Issue, type StartedStage, type StateGroup, type WorkflowState } from "@rsva/schema/models";
import type { Action } from "./index.ts";
import { groupBy } from "@rsva/schema/util";

/** Why an event is in someone's inbox. */
export type InboxKind =
  /** Assigned to the issue by someone else. */
  | "assigned"
  /** The issue they created moved into review: they approve it or send it back. */
  | "review"
  /** An issue assigned to them moved into an approved state. */
  | "approved"
  /** Any other state change of an issue they are involved in. */
  | "state"
  /** Mentioned in a comment (new or edited) or in the description. */
  | "mention"
  /** A reply in a thread they wrote in. */
  | "reply"
  /** A new comment on an issue they are involved in. */
  | "comment";

/** One notification: a log action and the reason it concerns the viewer. */
export interface InboxEvent {
  /** Log number of the action. */
  id: number;
  issueId: string;
  kind: InboxKind;
  by: string;
  at: string;
  /** The state the issue moved into (review, approved, state). */
  stateId?: string;
  /** The comment (reply, comment, a mention in a comment). */
  commentId?: string;
  /** How the comment starts, as one plain line (RSVA-571): what the inbox's row says instead of "commented". */
  text?: string;
}

/** A mention as its name: `[@Ann](mention:…)` reads "@Ann". */
export const plainMentions = (md: string): string => md.replace(/\[(@[^\]]+)\]\(mention:[^)]+\)/g, "$1");

/** The longest line of a comment an inbox event carries. */
export const INBOX_TEXT_MAX = 140;

/**
 * A comment's Markdown as one plain line, cut to INBOX_TEXT_MAX: mentions and links as their text, pictures and code
 * fences' marks dropped, the marks of headings, quotes, lists and emphasis taken off, the lines joined.
 */
export function commentLine(body: string): string {
  const line = plainMentions(body)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(```.*|#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > INBOX_TEXT_MAX ? `${line.slice(0, INBOX_TEXT_MAX - 1).trimEnd()}…` : line;
}

/**
 * The viewer's marks on one issue's notifications, as log numbers: everything up to `readId` is read, up to
 * `archivedId` archived. `snoozedUntil` hides the issue until then, unless an event newer than `snoozedId` arrives.
 * `subscribed`, when the viewer chose, holds for actions after `subscribedId`; both are left out when they did not.
 */
export interface InboxMark {
  issueId: string;
  readId: number;
  archivedId: number;
  snoozedId: number;
  snoozedUntil: string | null;
  subscribed?: boolean;
  subscribedId?: number;
}

/** No marks yet: nothing read, archived or snoozed. */
export const blankMark = (issueId: string): InboxMark => ({ issueId, readId: 0, archivedId: 0, snoozedId: 0, snoozedUntil: null });

/** Read up to the latest notification, or unread: back to just before it, so that the next one is new as well. */
export const markRead = (m: InboxMark, latestId: number, read = true): InboxMark => ({ ...m, readId: read ? Math.max(m.readId, latestId) : Math.min(m.readId, latestId - 1) });

/** Out of the inbox until a newer notification arrives, and read. */
export const markArchived = (m: InboxMark, latestId: number): InboxMark => ({ ...m, readId: latestId, archivedId: latestId });

/** One issue's line in the inbox. */
export interface InboxGroup {
  issueId: string;
  /** What is left after the archive mark, oldest first. */
  events: InboxEvent[];
  latest: InboxEvent;
  unread: boolean;
  /** Set while the line is snoozed: when it comes back. */
  snoozedUntil: string | null;
}

/**
 * The inbox's lines, newest first: events grouped by issue, those up to its archive mark left out. `keep` drops issues
 * the viewer no longer sees (deleted, archived). The browser draws these, and the agent API answers with them.
 */
export function inboxGroups(events: readonly InboxEvent[], markOf: (issueId: string) => InboxMark | undefined, now: number, keep: (issueId: string) => boolean): InboxGroup[] {
  const byIssue = groupBy(events, (e) => e.issueId);
  const groups: InboxGroup[] = [];
  for (const [issueId, all] of byIssue) {
    if (!keep(issueId)) continue;
    const m = markOf(issueId) ?? blankMark(issueId);
    const kept = all.filter((e) => e.id > m.archivedId);
    const latest = kept.at(-1);
    if (!latest) continue;
    const snoozedUntil = m.snoozedUntil !== null && Date.parse(m.snoozedUntil) > now && latest.id <= m.snoozedId ? m.snoozedUntil : null;
    groups.push({ issueId, events: kept, latest, unread: latest.id > m.readId, snoozedUntil });
  }
  return groups.sort((a, b) => b.latest.id - a.latest.id);
}

export interface InboxAction {
  label: string;
  stateId: string;
  /** The primary one (⌘↵). */
  primary: boolean;
}

/**
 * What the notification asks of the viewer, as state moves: a review request offers approve or send back while the
 * issue is still in review; a new assignment, start or backlog while it has not started; an approval, done. The
 * buttons of a notification, no more: what "waits on you" is My work's rule (asksViewer, RSVA-572), on every screen,
 * in the bot and in the digest.
 */
export function inboxActions(row: { kinds: ReadonlySet<InboxKind>; issue: Pick<Issue, "stateId" | "createdById" | "assigneeIds"> }, states: readonly WorkflowState[], me: string): InboxAction[] {
  const { issue } = row;
  const current = states.find((s) => s.id === issue.stateId);
  if (!current) return [];
  const first = (group: StateGroup) => states.find((s) => s.group === group);
  const started = states.filter((s) => s.group === "started");
  const stage = startedStage(states, issue.stateId);
  const action = (label: string, s: WorkflowState | undefined, primary = false) => (s ? [{ label, stateId: s.id, primary }] : []);
  if (row.kinds.has("review") && stage === "review" && issue.createdById === me) {
    return [...action("Request changes", started[0]), ...action("Approve", started[2], true)];
  }
  if (row.kinds.has("approved") && stage === "approved" && issue.assigneeIds.includes(me)) {
    return action("Mark done", first("completed"), true);
  }
  if (row.kinds.has("assigned") && (current.group === "unstarted" || current.group === "backlog") && issue.assigneeIds.includes(me)) {
    return [...(current.group === "backlog" ? [] : action("Move to backlog", first("backlog"))), ...action("Start working", started[0], true)];
  }
  return [];
}

/** Whether the viewer hears an issue's general traffic at log number `id`: their choice after it was made, else involvement. */
export function follows(mark: Pick<InboxMark, "subscribed" | "subscribedId"> | undefined, id: number, involved: boolean): boolean {
  return mark?.subscribed !== undefined && id > (mark.subscribedId ?? 0) ? mark.subscribed : involved;
}

/** What the classifier needs to know beyond the action, from the server's tables or the client's pool. */
export interface InboxContext {
  me: string;
  /** The issue as it is now. */
  issue(id: string): { createdById: string | null; assigneeIds: readonly string[] } | undefined;
  /** The started stage of a state, undefined for other groups. */
  stage(stateId: string): StartedStage | undefined;
  /** The group of a state: backlog, unstarted, started, completed, cancelled. */
  group(stateId: string): string | undefined;
  /** The viewer is who reviews the issue (`isReviewer`). */
  reviews(issueId: string): boolean;
  /** The viewer has commented on the issue. */
  commented(issueId: string): boolean;
  /** The viewer wrote in the thread that starts with this comment. */
  inThread(rootId: string): boolean;
  /** The viewer's mark on the issue, for their subscription choice. */
  mark(issueId: string): InboxMark | undefined;
}

/**
 * Who reviews an issue: who created it, or, for an agent's issue, whoever manages the workspace (agents do not approve).
 * My work puts its review on them; the inbox spares them the news of what they decided.
 */
export const isReviewer = (me: string, manages: boolean, createdById: string | null, byAgent: boolean): boolean => createdById === me || (manages && !!createdById && byAgent);

/** How long notifications are kept in the inbox, and how many at most: older ones are not read off the log. */
export const INBOX_DAYS = 60;
export const INBOX_MAX = 500;

/**
 * The notification an action makes for the viewer, or null. `prevAssignees` are the issue's assignees before an Issue
 * update (the stored `prev` on the server, the pool row on the client). Imports (no actor) and the viewer's own actions
 * make none. `prevStateId` is the state before an Issue update that changed it.
 *
 * Done is not always news (RSVA-574). Out of an approved state it was announced when it was approved, and it is what
 * the approval was for. Out of review, the one who reviews chose it: merging the pull request they looked at told them
 * "GitHub moved it to Done". Neither makes a notification; a close that went past the review still does.
 */
export function inboxEvent(a: Action, prevAssignees: readonly string[] | undefined, at: string, ctx: InboxContext, prevStateId?: string | null): InboxEvent | null {
  if (!a.by || a.by === ctx.me) return null;
  const d = a.d ?? {};
  const base = { id: a.id, by: a.by, at };
  if (a.m === "Issue" && (a.a === "I" || a.a === "U")) {
    const assignees = d.assigneeIds as string[] | undefined;
    if (assignees?.includes(ctx.me) && !(a.a === "U" && prevAssignees?.includes(ctx.me))) return { ...base, issueId: a.mid, kind: "assigned" };
    // A move to another project (PLNR-448) maps the state it had: no step of the work, no "review" or "approved" to act on.
    if (a.a !== "U" || typeof d.stateId !== "string" || "projectId" in d) return null;
    const issue = ctx.issue(a.mid);
    if (!issue) return null;
    const creator = issue.createdById === ctx.me;
    const assignee = issue.assigneeIds.includes(ctx.me);
    const stage = ctx.stage(d.stateId);
    const event = { ...base, issueId: a.mid, stateId: d.stateId };
    if (stage === "review" && creator) return { ...event, kind: "review" };
    if (stage === "approved" && assignee) return { ...event, kind: "approved" };
    const was = prevStateId ? ctx.stage(prevStateId) : undefined;
    if (ctx.group(d.stateId) === "completed" && (was === "approved" || (was === "review" && ctx.reviews(a.mid)))) return null;
    if (follows(ctx.mark(a.mid), a.id, creator || assignee || ctx.commented(a.mid))) return { ...event, kind: "state" };
    return null;
  }
  const mentioned = Array.isArray(d.mentionIds) && d.mentionIds.includes(ctx.me);
  if (a.m === "Document" && a.a === "U") return mentioned ? { ...base, issueId: a.mid, kind: "mention" } : null;
  // The comment's first line rides with the event: the pool holds a comment only once its issue was opened.
  const line = a.m === "Comment" && typeof d.body === "string" ? commentLine(d.body) : "";
  const text = line ? { text: line } : {};
  if (a.m === "Comment" && (a.a === "I" || a.a === "U") && mentioned) return { ...base, issueId: d.issueId as string, commentId: a.mid, kind: "mention", ...text };
  if (a.m === "Comment" && a.a === "I") {
    const issueId = d.issueId as string;
    const event = { ...base, issueId, commentId: a.mid, ...text };
    const parentId = d.parentId as string | null | undefined;
    if (parentId && ctx.inThread(parentId)) return { ...event, kind: "reply" };
    const issue = ctx.issue(issueId);
    if (!issue) return null;
    if (follows(ctx.mark(issueId), a.id, issue.createdById === ctx.me || issue.assigneeIds.includes(ctx.me) || ctx.commented(issueId))) return { ...event, kind: "comment" };
  }
  return null;
}

// ── WebSocket frames ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Client → server, after `sub`. Without `at`: send the whole inbox. With `at` (the time of the last marks it has): the
 * client already has the events, since it classifies the deltas itself; send only marks changed after `at`, if any.
 */
export interface InboxRequestFrame {
  t: "inbox";
  at?: string;
}

/** Client → server: set the viewer's marks on these issues. */
export interface MarkFrame {
  t: "mark";
  m: InboxMark[];
}

/** Server → client: the whole inbox, read at log number `s`; the client keeps its own events after `s`. */
export interface InboxFrame {
  t: "inbox";
  s: number;
  e: InboxEvent[];
  m: InboxMark[];
  /** Issues the viewer commented on, and the threads (top comments) they wrote in: the classifier's context. */
  c: string[];
  th: string[];
  /** Server time of the latest mark: the next request's `at`. */
  at: string | null;
}

/** Server → client: marks changed (by this tab, another tab or another device of the viewer). */
export interface MarksFrame {
  t: "marks";
  m: InboxMark[];
  at: string;
}
