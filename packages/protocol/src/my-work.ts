// My work (PLNR-41, "My work · A — stacked queue"): the viewer's issues, in six groups by whose move it is. The browser
// runs these rules over each workspace's engine; the server runs the same over the database for the bot's /my
// (PLNR-205), so the chat and the screen list the same issues in the same order. A subpath of its own
// (`@rsva/protocol/my-work`): through the package's index it would ride in the browser's startup chunk.
//
// Owner's decisions (2026-10-29): every workspace at once; "asked you" rows are unread mentions of the viewer (PLNR-27)
// and replies to their comments; agent rows show the state and the time since the issue last changed.
// RSVA-612 (owner 2026-11-11): every open issue assigned to the viewer is in one of the groups. Their backlog, kept out
// of Up next so that it stays what to start, is Later, folded; an assignment not yet read is new at the top of its group.
// Owner 2026-11-11: My work is what is assigned to the viewer. An assignment in Backlog that they have not read is to
// decide (Todo, start, keep, drop) and waits on them; reviews, mentions and proposals that are not theirs live in the
// inbox and in Triage, and come in here only when `others` asks for them (project homes, the review queue, the bot).
import { isProposalLabel, mayManage } from "@rsva/policy";
import { isLiveIssue, startedStage, type Issue, type WorkflowState } from "@rsva/schema/models";
import { isReviewer, type InboxEvent } from "./inbox.ts";

export type GroupId = "wait" | "doing" | "agents" | "next" | "later" | "done";
/**
 * Why an issue waits on the viewer: a review of their issue (or an agent's, for owners and admins), a proposal to triage,
 * a mention of them, a reply to their comment, a new assignment in Backlog to decide on.
 */
export type Ask = "review" | "proposed" | "mention" | "reply" | "decide";

export const GROUPS: readonly { id: GroupId; name: string; keys: string }[] = [
  { id: "wait", name: "Waiting on you", keys: "↵ review · A accept · D decline · R reply" },
  { id: "doing", name: "You’re doing", keys: "↵ open" },
  { id: "agents", name: "Agents on your behalf", keys: "↵ open" },
  { id: "next", name: "Up next", keys: "S start" },
  { id: "later", name: "Later", keys: "S start" },
  { id: "done", name: "Done this week", keys: "⇧D show or hide" },
];

export const ASK_LABELS: Record<Ask, string> = { review: "Review requested", proposed: "Proposal to triage", mention: "Mentioned you", reply: "Replied to you", decide: "Assigned to you" };

/** One line of the viewer's inbox, as much of it as My work reads. */
export interface WorkInboxRow {
  issue: { id: string };
  /** Oldest first. */
  events: readonly InboxEvent[];
  latest: InboxEvent;
  unread: boolean;
  snoozedUntil: string | null;
}

/** What My work reads of a workspace: the browser's engine has this shape, the server builds it from the database. */
export interface WorkSource {
  me: { id: string } | null;
  role: string | null;
  /** Who triages (the workspace's `triagers`); none known or an empty list: every owner and admin. */
  workspace?: { triagers: readonly string[] } | null;
  issues: { values(): Iterable<Issue> };
  states: { get(id: string): WorkflowState | undefined };
  statesOf(projectId: string): readonly WorkflowState[];
  /** The workspace's projects, archived ones too: an archived project's issues are nobody's work (RSVA-572). */
  projects: { get(id: string): { archivedAt: unknown } | undefined };
  labels: { values(): Iterable<{ id: string; name: string }> };
  users: { get(id: string): { kind: string } | undefined };
  inbox: { rows: readonly WorkInboxRow[] };
}

export interface WorkItem {
  /** The workspace's slug. */
  ws: string;
  issue: Issue;
  group: GroupId;
  ask?: Ask;
  /** Who asks (wait), the agent at work (agents, done). */
  from: string | null;
  /** Since when it waits (wait), when it last changed (doing, agents), when it was done (done). */
  since: string;
  /** The reply to answer: its comment id. */
  replyTo?: string;
  /** Assigned to the viewer, and the assignment is unread in their inbox: `from` assigned it, `since` is when. */
  fresh?: true;
}

/**
 * One rule for "waits on you" on every screen (RSVA-572). What waits on the viewer asks them something: a review, a
 * reply, a mention. A proposal is in the same group, since it is the viewer's move too, but it is a pile to triage, not
 * a question to answer: it is counted and shown apart, and never under this name. Before, My work's Home counted the
 * asks, the project home's widget the proposals too (57 against 0 on one page), and the queue's section both.
 */
export const asksViewer = (x: Pick<WorkItem, "group" | "ask">): boolean => x.group === "wait" && x.ask !== "proposed";
/** A proposal waiting to be triaged. */
export const toTriage = (x: Pick<WorkItem, "group" | "ask">): boolean => x.group === "wait" && x.ask === "proposed";

/**
 * What Triage lists, among `collect(…, { others: true })`: a proposal, or the review of an issue that is not the viewer's
 * own (an agent's). Their own review is in My work.
 */
export const forTriage = (x: Pick<WorkItem, "group" | "ask" | "issue">, me: string | undefined): boolean =>
  x.group === "wait" && (x.ask === "proposed" || (x.ask === "review" && x.issue.createdById !== me));

type ReviewSource = Pick<WorkSource, "statesOf" | "users">;

/** In review, and the review is the viewer's. An agent's work waits on whoever triages, as its proposals do: agents do not approve. */
function reviewWaits(s: ReviewSource, me: string, triages: boolean, issue: Issue): boolean {
  if (startedStage(s.statesOf(issue.projectId), issue.stateId) !== "review") return false;
  return isReviewer(me, triages, issue.createdById, !!issue.createdById && s.users.get(issue.createdById)?.kind === "agent");
}

/** Who asks for the review (the agent at work, else an assignee other than the viewer) and since when: the move to review. */
export function reviewAsk(s: Pick<WorkSource, "inbox">, me: string, issue: Issue): { from: string | null; since: string } {
  const since = s.inbox.rows.find((r) => r.issue.id === issue.id)?.events.findLast((e) => e.kind === "review")?.at ?? issue.updatedAt;
  return { from: issue.delegateId ?? issue.assigneeIds.find((id) => id !== me) ?? null, since };
}

/**
 * Whether the open issue waits on the viewer's review: the rule My work's rows follow, for one issue, so the issue's
 * review bar (RSVA-597) does not walk the workspace to learn it.
 */
export function waitsOnReview(s: ReviewSource & Pick<WorkSource, "me" | "role" | "projects" | "workspace">, issue: Issue): boolean {
  const me = s.me?.id;
  if (!me || !isLiveIssue(issue) || s.projects.get(issue.projectId)?.archivedAt) return false;
  return reviewWaits(s, me, canTriage(s), issue);
}

/** An agent that has not touched its issue for this long is idle. */
const IDLE_MS = 48 * 3_600_000;
const WEEK_MS = 7 * 86_400_000;

/** The workspace's `proposed` labels: a proposal carries one. */
export function proposedLabels(s: Pick<WorkSource, "labels">): Set<string> {
  return new Set([...s.labels.values()].filter((l) => isProposalLabel(l.name)).map((l) => l.id));
}

/**
 * Whether the viewer triages in this workspace: the people the workspace named (owner 2026-11-11), else every owner and
 * admin. The proposals and the agents' reviews are theirs; for anybody else they are no one's work to see.
 */
export const canTriage = (s: Pick<WorkSource, "me" | "role" | "workspace">): boolean => {
  const named = s.workspace?.triagers;
  return named?.length ? !!s.me && named.includes(s.me.id) : mayManage(s.role);
};

/** What `collect` reads besides the viewer's own issues. */
export interface CollectOptions {
  /**
   * Also what is not assigned to the viewer: reviews of an agent's issues (owners and admins), proposals to triage,
   * mentions and replies, issues they created that agents work. Off: My work, assigned issues only.
   */
  others?: boolean;
}

/**
 * One workspace's items, unsorted. The first rule that fits wins, in the order of the groups: what waits on the viewer,
 * then what was done this week, what agents do for them, what they do, what they start next.
 */
export function collect(ws: string, s: WorkSource, now: number, { others = false }: CollectOptions = {}): WorkItem[] {
  const me = s.me?.id;
  if (!me) return [];
  const proposed = proposedLabels(s);
  const triages = canTriage(s);
  const asks = new Map<string, WorkInboxRow>();
  const assigned = new Map<string, WorkInboxRow>();
  for (const r of s.inbox.rows) {
    if (!r.unread || r.snoozedUntil) continue;
    if (r.latest.kind === "mention" || r.latest.kind === "reply") asks.set(r.issue.id, r);
    else if (r.latest.kind === "assigned") assigned.set(r.issue.id, r);
  }
  const out: WorkItem[] = [];
  for (const issue of s.issues.values()) {
    // An archived project is put away with what was open in it: its proposals are not to triage, its reviews do not
    // wait. The projects' rows left it out already, so Home counted 207 proposals where the queue held 223.
    if (!isLiveIssue(issue) || s.projects.get(issue.projectId)?.archivedAt) continue;
    const state = s.states.get(issue.stateId);
    if (!state || state.group === "cancelled") continue;
    const mine = issue.assigneeIds.includes(me);
    const item = (group: GroupId, from: string | null, since: string, extra?: Partial<WorkItem>) => out.push({ ws, issue, group, from, since, ...extra });
    // The viewer's own work, new while its assignment is unread: who assigned it and when, instead of the last change.
    const own = (group: GroupId) => {
      const a = mine ? assigned.get(issue.id) : undefined;
      if (a) item(group, a.latest.by, a.latest.at, { fresh: true });
      else item(group, null, issue.updatedAt);
    };
    const asked = others ? asks.get(issue.id) : undefined;
    const given = mine && state.group === "backlog" ? assigned.get(issue.id) : undefined;
    if (reviewWaits(s, me, others ? triages : false, issue)) {
      const r = reviewAsk(s, me, issue);
      item("wait", r.from, r.since, { ask: "review" });
    } else if (others && triages && state.group === "backlog" && issue.labelIds.some((id) => proposed.has(id))) {
      item("wait", issue.createdById, issue.createdAt, { ask: "proposed" });
    } else if (given) {
      item("wait", given.latest.by, given.latest.at, { ask: "decide", fresh: true });
    } else if (asked) {
      const ask = asked.latest.kind === "mention" ? "mention" : "reply";
      item("wait", asked.latest.by, asked.latest.at, { ask, ...(asked.latest.commentId ? { replyTo: asked.latest.commentId } : {}) });
    } else if (state.group === "completed") {
      if ((mine || (others && issue.delegateId && issue.createdById === me)) && issue.completedAt && now - Date.parse(issue.completedAt) < WEEK_MS)
        item("done", issue.delegateId, issue.completedAt);
    } else if (issue.delegateId && (mine || (others && issue.createdById === me))) {
      item("agents", issue.delegateId, issue.updatedAt);
    } else if (mine && state.group === "started") {
      own("doing");
    } else if (mine && state.group === "unstarted") {
      own("next");
    } else if (mine) {
      own("later");
    }
  }
  return out;
}

// Urgent first, no priority last, as in the issue lists.
const rank = (p: number) => (p === 0 ? 5 : p);
const byDue = (a: Issue, b: Issue) => (a.dueDate ?? "9999") < (b.dueDate ?? "9999") ? -1 : (a.dueDate ?? "9999") > (b.dueDate ?? "9999") ? 1 : 0;
/** An agent's issue that has not changed for IDLE_MS. */
export const isIdle = (x: WorkItem, now: number): boolean => now - Date.parse(x.since) >= IDLE_MS;

const byPlan = (a: WorkItem, b: WorkItem) => rank(a.issue.priority) - rank(b.issue.priority) || byDue(a.issue, b.issue);

/**
 * A group's order: waiting longest first; due first; idle agents first; priority first; latest done first. New
 * assignments come before the rest of their group, the latest first.
 */
export function sortGroup(id: GroupId, items: WorkItem[], now: number): WorkItem[] {
  const cmp: Record<GroupId, (a: WorkItem, b: WorkItem) => number> = {
    wait: (a, b) => rank(a.issue.priority) - rank(b.issue.priority) || a.since.localeCompare(b.since),
    doing: (a, b) => byDue(a.issue, b.issue) || rank(a.issue.priority) - rank(b.issue.priority),
    agents: (a, b) => Number(isIdle(b, now)) - Number(isIdle(a, now)) || b.since.localeCompare(a.since),
    next: byPlan,
    later: byPlan,
    done: (a, b) => b.since.localeCompare(a.since),
  };
  const fresh = (a: WorkItem, b: WorkItem) => Number(!!b.fresh) - Number(!!a.fresh) || (a.fresh && b.fresh ? b.since.localeCompare(a.since) : 0);
  return items.sort((a, b) => fresh(a, b) || cmp[id](a, b));
}

// ── The groups as the screen lays them out ────────────────────────────────────────────────────────────────

/**
 * One block of the list: a group, or a lane of another grouping, or a section of Triage. The viewer's own sections and
 * Customize went (owner 2026-11-11): only which groups are folded is theirs, kept in their account settings (`myWork`),
 * the same on every device.
 */
export interface MyWorkSection {
  id: string;
  kind: GroupId | "lane";
  /** Empty: the group's name. */
  title: string;
  folded: boolean;
}

/** The groups folded until the viewer opens them: Later and Done this week (Done as on the artboard). */
export const DEFAULT_FOLDED: readonly GroupId[] = ["later", "done"];

const GROUP_IDS = new Set<string>(GROUPS.map((g) => g.id));

/**
 * The folded groups as stored, read back: unknown ids dropped, each once. Null or nonsense: the defaults. A list from
 * before the sections went (objects with a `kind` and `folded`) is read for the groups it folded.
 */
export function myWorkFolds(raw: unknown): GroupId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_FOLDED];
  const out = new Set<GroupId>();
  for (const r of raw) {
    const id = typeof r === "string" ? r : r && typeof r === "object" && (r as { folded?: unknown }).folded === true ? (r as { kind?: unknown }).kind : null;
    if (typeof id === "string" && GROUP_IDS.has(id)) out.add(id as GroupId);
  }
  return GROUPS.map((g) => g.id).filter((id) => out.has(id));
}

/** A section's name as shown. */
export const sectionTitle = (s: Pick<MyWorkSection, "kind" | "title">): string => s.title || (GROUPS.find((g) => g.id === s.kind)?.name ?? "");
