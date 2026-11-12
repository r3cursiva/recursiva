// Rows of Plane's database (read.ts) → an import bundle (packages/schema/src/bundle.ts). Pure: no I/O, so the mapping
// is tested on synthetic rows. External ids are Plane's UUIDs with source "plane", the same as the API connector
// (connectors/plane), so importing over a workspace that came through the API updates its rows instead of doubling them.
//
// Plane's traps handled here (docs/research/plane-backend.md, "What the Plane connector needs to take into account"):
// - soft delete everywhere: only rows with deletedAt null move. Assignee and label links are soft-deleted and recreated
//   on every edit, so an issue's set is its live link rows, never the row ids;
// - Issue.archived_at is a date (Django's timezone.now().date(), UTC): the exact time comes from the issue's activity
//   when it has one, otherwise 00:00 UTC of that date;
// - our fork's comment replies (IssueComment.parent): one level here, so a reply to a reply hangs under the thread's
//   top comment, and a deleted top comment with live replies stays as a tombstone (empty body), as our own delete does;
// - reactions are code points in decimal ("128077-65039"): decoded to the emoji;
// - drafts (Issue.is_draft) and triage (intake) states are Plane's own and are not moved.
import {
  decodeReaction,
  displayName,
  emptyHtmlStats,
  memberRole,
  planeMarkdown,
  PRIORITY,
  STATE_GROUPS,
  userKind,
  type HtmlContext,
} from "@rsva/connector-plane/plane";
import type {
  BundleComment,
  BundleFile,
  BundleHeader,
  BundleIssue,
  BundleLabel,
  BundleLine,
  BundleProject,
  BundleLink,
  BundleReaction,
  BundleSubscription,
  BundleState,
  BundleUser,
} from "@rsva/schema/bundle";
import { filePath } from "@rsva/schema/models";

interface PlaneWorkspace { id: string; slug: string; name: string; ownerId: string | null }
/** Only what the bundle needs: never passwords, tokens or sessions. */
interface PlaneUser { id: string; email: string; displayName: string | null; firstName: string | null; lastName: string | null; isBot: boolean }
interface PlaneMember { userId: string; role: number; isActive: boolean; deletedAt: string | null }
interface PlaneProject { id: string; identifier: string; name: string; createdAt: string; archivedAt: string | null; deletedAt: string | null }
interface PlaneState {
  id: string; projectId: string; name: string; group: string; color: string; sequence: number; isDefault: boolean; isTriage: boolean;
  deletedAt: string | null;
}
interface PlaneLabel {
  id: string; projectId: string | null; parentId: string | null; name: string; color: string; sortOrder: number; deletedAt: string | null;
}
interface PlaneIssue {
  id: string; projectId: string; sequenceId: number; name: string; stateId: string | null; priority: string; parentId: string | null;
  startDate: string | null; targetDate: string | null; sortOrder: number; createdById: string | null;
  createdAt: string; updatedAt: string; completedAt: string | null;
  /** A date, YYYY-MM-DD. */
  archivedAt: string | null;
  isDraft: boolean; descriptionHtml: string | null; deletedAt: string | null;
}
/** A row of issue_assignees (target = assignee) or issue_labels (target = label). */
export interface PlaneLink { issueId: string; targetId: string; createdAt: string; deletedAt: string | null }
export interface PlaneComment {
  id: string; issueId: string; parentId: string | null; actorId: string | null; createdById: string | null;
  commentHtml: string | null; createdAt: string; editedAt: string | null; deletedAt: string | null;
}
/** issue_reactions (commentId null) and comment_reactions (issueId resolved through the comment, may be null). */
interface PlaneReaction {
  id: string; issueId: string | null; commentId: string | null; actorId: string; reaction: string; createdAt: string; deletedAt: string | null;
}
/** issue_relations: `issueId` is blocked by, relates to or duplicates `relatedId` (Plane stores "blocking" swapped). */
interface PlaneRelation { id: string; issueId: string; relatedId: string; type: string; deletedAt: string | null }
/** issue_subscribers: Plane adds the creator, assignees and commenters itself; Unsubscribe deletes the row. */
interface PlaneSubscription { id: string; issueId: string; subscriberId: string; createdAt: string; deletedAt: string | null }
/**
 * A link on an issue: issue_links, and the fork's GitHub pull requests and commits (lsrd_github_*), whose rows Plane also
 * mirrors into issue_links. `title` is the PR title or the commit's first line.
 */
interface PlaneIssueLink {
  id: string; issueId: string; url: string; title: string | null; createdById: string | null; createdAt: string; deletedAt: string | null;
  source: "link" | "github";
}
/** When an issue was archived, from its activity (field archived_at, a new value set). */
interface PlaneArchiveEvent { issueId: string; at: string }

export interface PlaneRows {
  workspace: PlaneWorkspace;
  users: PlaneUser[];
  members: PlaneMember[];
  projects: PlaneProject[];
  states: PlaneState[];
  labels: PlaneLabel[];
  issues: PlaneIssue[];
  assignees: PlaneLink[];
  issueLabels: PlaneLink[];
  comments: PlaneComment[];
  reactions: PlaneReaction[];
  archiveEvents: PlaneArchiveEvent[];
  relations: PlaneRelation[];
  links: PlaneIssueLink[];
  subscriptions: PlaneSubscription[];
  assets: PlaneAsset[];
}

/** A row of `file_assets`: an upload, by the entity it was made for. */
interface PlaneAsset {
  id: string;
  entityType: string | null;
  issueId: string | null;
  name: string;
  type: string | null;
  createdById: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface MapOptions {
  /** Link for an uploaded image by Plane asset id (images in descriptions and comments); without it they are dropped. */
  assetUrl?: (assetId: string) => string | null;
  /** The SHA-256 of an asset's bytes, when the export has them: such images and issue attachments move as files. */
  assetHash?: (assetId: string) => string | null;
}

export interface MapResult {
  header: BundleHeader;
  lines: BundleLine[];
  /** Counts of what moved and what was left out, for the connector's report. */
  report: Record<string, number>;
}

const live = <T extends { deletedAt: string | null }>(x: T) => x.deletedAt === null;
const byCreated = <T extends { createdAt: string }>(a: T, b: T) => Date.parse(a.createdAt) - Date.parse(b.createdAt);

/** Plane's DateField archive date → a moment: the activity's time on that UTC date, else its 00:00 UTC. */
export function archivedMoment(date: string, events: string[] = []): string {
  const day = date.slice(0, 10);
  const same = events.filter((at) => new Date(at).toISOString().slice(0, 10) === day).sort((a, b) => Date.parse(a) - Date.parse(b));
  return same.length ? new Date(same.at(-1)!).toISOString() : `${day}T00:00:00.000Z`;
}

/** Live link rows → the current set of targets, oldest link first, each target once. */
export function liveTargets(links: PlaneLink[], keep: (targetId: string) => boolean = () => true): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const l of links.filter(live).sort(byCreated)) {
    if (!keep(l.targetId)) continue;
    const list = out.get(l.issueId) ?? [];
    if (!list.includes(l.targetId)) list.push(l.targetId);
    out.set(l.issueId, list);
  }
  return out;
}

/**
 * Comment threads, one level deep. Live comments keep their place; a reply's parent becomes the top comment of its
 * thread (following parents up through replies and deleted comments). A deleted top comment with live replies is
 * returned as a tombstone; a reply whose chain ends at a comment no longer in the database becomes a top comment.
 */
export function threadComments(comments: PlaneComment[]): { comment: PlaneComment; parentId: string | null; tombstone: boolean }[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rootOf = (c: PlaneComment): PlaneComment => {
    const seen = new Set([c.id]);
    let at = c;
    for (let p = at.parentId ? byId.get(at.parentId) : undefined; p && p.issueId === c.issueId && !seen.has(p.id); p = p.parentId ? byId.get(p.parentId) : undefined) {
      seen.add(p.id);
      at = p;
    }
    return at;
  };
  const out: { comment: PlaneComment; parentId: string | null; tombstone: boolean }[] = [];
  const tombstones = new Set<string>();
  for (const c of comments.filter(live).sort(byCreated)) {
    const root = rootOf(c);
    if (root === c) {
      out.push({ comment: c, parentId: null, tombstone: false });
      continue;
    }
    if (!live(root) && !tombstones.has(root.id)) {
      tombstones.add(root.id);
      out.push({ comment: root, parentId: null, tombstone: true });
    }
    out.push({ comment: c, parentId: root.id, tombstone: false });
  }
  // Tombstones first, then by time: a parent precedes its replies (the import does not depend on it, readers do).
  return out.sort((a, b) => Number(b.tombstone) - Number(a.tombstone) || byCreated(a.comment, b.comment));
}

export function toBundle(rows: PlaneRows, opts: MapOptions = {}): MapResult {
  const report: Record<string, number> = {};
  const count = (k: string, n = 1) => (report[k] = (report[k] ?? 0) + n);
  const lines: BundleLine[] = [];
  const html = emptyHtmlStats();

  // Users: live members with their role; deactivated members and non-member authors as users only.
  const members = new Map(rows.members.filter(live).map((m) => [m.userId, m]));
  const users = new Map(rows.users.map((u) => [u.id, u]));
  const names = new Map(rows.users.map((u) => [u.id, displayName(u)]));
  // An image in the text: the workspace's file when the bytes moved with it, else a link to Plane (or nothing).
  const assets = new Map(rows.assets.map((a) => [a.id, a]));
  const inText = new Set<string>();
  const assetUrl = (id: string) => {
    const sha = assets.has(id) ? opts.assetHash?.(id) : null;
    if (sha) inText.add(id);
    return sha ? filePath(rows.workspace.slug, sha) : (opts.assetUrl?.(id) ?? null);
  };
  const ctx: HtmlContext = { userName: (id) => names.get(id), assetUrl };
  for (const u of rows.users) {
    const m = members.get(u.id);
    const role = m?.isActive ? memberRole(m.role) : null;
    count(role ? "members" : "usersNotMembers");
    lines.push({ m: "User", ext: u.id, email: u.email, name: names.get(u.id)!, kind: userKind(u.email, u.isBot), role } satisfies BundleUser);
  }
  const ownerId =
    (rows.workspace.ownerId && users.has(rows.workspace.ownerId) ? rows.workspace.ownerId : null) ??
    rows.members.find((m) => live(m) && m.isActive && m.role >= 20)?.userId ??
    rows.users[0]?.id;
  if (!ownerId) throw new Error(`workspace ${rows.workspace.slug} has no users`);
  const header: BundleHeader = { m: "Bundle", version: 1, source: "plane", workspace: { slug: rows.workspace.slug, name: rows.workspace.name }, owner: { ext: ownerId } };
  const userRef = (id: string | null) => (id && users.has(id) ? { ext: id } : null);

  const projects = new Set<string>();
  for (const p of rows.projects) {
    if (!live(p)) continue;
    projects.add(p.id);
    if (p.archivedAt) count("projectsArchived");
    lines.push({ m: "Project", ext: p.id, key: p.identifier, name: p.name, createdAt: iso(p.createdAt), archivedAt: p.archivedAt ? iso(p.archivedAt) : null } satisfies BundleProject);
  }

  const states = new Set<string>();
  for (const s of rows.states) {
    if (!live(s) || !projects.has(s.projectId)) continue;
    if (s.isTriage || !STATE_GROUPS.has(s.group)) {
      count("statesTriageSkipped");
      continue;
    }
    states.add(s.id);
    lines.push({
      m: "State", ext: s.id, project: { ext: s.projectId }, name: s.name, group: s.group as BundleState["group"],
      color: s.color, position: s.sequence, isDefault: s.isDefault,
    } satisfies BundleState);
  }

  const labels = new Set(rows.labels.filter((l) => live(l) && (l.projectId === null || projects.has(l.projectId))).map((l) => l.id));
  for (const l of rows.labels) {
    if (!labels.has(l.id)) continue;
    lines.push({
      m: "Label", ext: l.id, project: l.projectId ? { ext: l.projectId } : null, parent: l.parentId && labels.has(l.parentId) ? { ext: l.parentId } : null,
      name: l.name, color: l.color, position: l.sortOrder,
    } satisfies BundleLabel);
  }

  // Issues: live, in a moved project, not drafts, in a moved state.
  const issues = new Set<string>();
  for (const i of rows.issues) {
    if (!live(i)) count("issuesDeletedSkipped");
    else if (!projects.has(i.projectId)) count("issuesInDeletedProjectSkipped");
    else if (i.isDraft) count("issuesDraftSkipped");
    else if (!i.stateId || !states.has(i.stateId)) count("issuesTriageSkipped");
    else issues.add(i.id);
  }
  const assignees = liveTargets(rows.assignees, (id) => users.has(id));
  const issueLabels = liveTargets(rows.issueLabels, (id) => labels.has(id));
  const archived = new Map<string, string[]>();
  for (const e of rows.archiveEvents) archived.set(e.issueId, [...(archived.get(e.issueId) ?? []), e.at]);
  const relations = relationsOf(rows.relations, issues, count);
  for (const i of rows.issues) {
    if (!issues.has(i.id)) continue;
    const a = assignees.get(i.id) ?? [];
    const l = issueLabels.get(i.id) ?? [];
    count("assigneeLinks", a.length);
    count("labelLinks", l.length);
    if (i.archivedAt) count(archived.get(i.id)?.length ? "issuesArchivedExactTime" : "issuesArchivedMidnight");
    lines.push({
      m: "Issue", ext: i.id, project: { ext: i.projectId }, number: i.sequenceId, title: i.name, position: i.sortOrder,
      state: { ext: i.stateId! }, priority: PRIORITY[i.priority] ?? 0,
      assignees: a.map((ext) => ({ ext })), labels: l.map((ext) => ({ ext })),
      parent: i.parentId && issues.has(i.parentId) ? { ext: i.parentId } : null,
      startDate: i.startDate, dueDate: i.targetDate, createdBy: userRef(i.createdById),
      createdAt: iso(i.createdAt), updatedAt: iso(i.updatedAt), completedAt: i.completedAt ? iso(i.completedAt) : null,
      archivedAt: i.archivedAt ? archivedMoment(i.archivedAt, archived.get(i.id)) : null,
      description: planeMarkdown(i.descriptionHtml, ctx, html),
      ...relations.get(i.id),
    } satisfies BundleIssue);
  }
  count("issues", issues.size);

  const comments = new Set<string>();
  const ofIssue = rows.comments.filter((c) => issues.has(c.issueId));
  count("commentsDeletedSkipped", ofIssue.filter((c) => !live(c)).length);
  for (const { comment: c, parentId, tombstone } of threadComments(ofIssue)) {
    if (tombstone) count("commentTombstones");
    else {
      comments.add(c.id);
      count(parentId ? "replies" : "commentsTop");
      if (!parentId && c.parentId) count("repliesPromoted");
      if (parentId && parentId !== c.parentId) count("repliesReparented");
    }
    lines.push({
      m: "Comment", ext: c.id, issue: { ext: c.issueId }, parent: parentId ? { ext: parentId } : null,
      author: userRef(c.actorId ?? c.createdById),
      body: tombstone ? "" : planeMarkdown(c.commentHtml, ctx, html),
      createdAt: iso(c.createdAt), editedAt: c.editedAt ? iso(c.editedAt) : null,
      deletedAt: tombstone ? iso(c.deletedAt!) : null,
    } satisfies BundleComment);
  }

  // Reactions: on moved issues and live comments, by known users, decoded; one per user, emoji and target.
  const commentIssue = new Map(rows.comments.map((c) => [c.id, c.issueId]));
  const seen = new Set<string>();
  for (const r of rows.reactions.filter(live).sort(byCreated)) {
    const issueId = r.commentId ? commentIssue.get(r.commentId) : r.issueId;
    const emoji = decodeReaction(r.reaction);
    if (!issueId || !issues.has(issueId) || (r.commentId && !comments.has(r.commentId)) || !users.has(r.actorId) || !emoji) {
      count("reactionsSkipped");
      continue;
    }
    const key = `${r.actorId} ${emoji} ${issueId} ${r.commentId ?? ""}`;
    if (seen.has(key)) {
      count("reactionsDuplicate");
      continue;
    }
    seen.add(key);
    count(r.commentId ? "commentReactions" : "issueReactions");
    lines.push({
      m: "Reaction", ext: r.id, issue: { ext: issueId }, comment: r.commentId ? { ext: r.commentId } : null,
      user: { ext: r.actorId }, emoji, createdAt: iso(r.createdAt),
    } satisfies BundleReaction);
  }

  // Links: GitHub rows first, so a pull request mirrored into issue_links keeps its title and moves once.
  const linked = new Set<string>();
  const sources = { github: 0, link: 1 };
  for (const l of rows.links.filter(live).sort((a, b) => sources[a.source] - sources[b.source] || byCreated(a, b))) {
    const key = `${l.issueId} ${l.url.trim()}`;
    if (!issues.has(l.issueId) || linked.has(key)) {
      count(issues.has(l.issueId) ? "linksDuplicate" : "linksSkipped");
      continue;
    }
    linked.add(key);
    count(l.source === "github" ? "githubLinks" : "links");
    lines.push({
      m: "Link", ext: l.id, issue: { ext: l.issueId }, url: l.url.trim(), title: l.title ?? "", createdBy: userRef(l.createdById), createdAt: iso(l.createdAt),
    } satisfies BundleLink);
  }

  // Subscriptions: live ones on moved issues by known users, one per person and issue.
  const subscribed = new Set<string>();
  for (const s of rows.subscriptions.filter(live).sort(byCreated)) {
    const key = `${s.subscriberId} ${s.issueId}`;
    if (!issues.has(s.issueId) || !users.has(s.subscriberId) || subscribed.has(key)) {
      count("subscriptionsSkipped");
      continue;
    }
    subscribed.add(key);
    count("subscriptions");
    lines.push({ m: "Subscription", ext: s.id, issue: { ext: s.issueId }, user: { ext: s.subscriberId } } satisfies BundleSubscription);
  }

  // Files: what the text above uses, and attachments of moved issues.
  for (const a of rows.assets) {
    const attached = a.entityType === "ISSUE_ATTACHMENT" && live(a) && a.issueId !== null && issues.has(a.issueId);
    if (!attached && !inText.has(a.id)) continue;
    const sha256 = opts.assetHash?.(a.id);
    if (!sha256) {
      count("attachmentsWithoutBytes");
      continue;
    }
    count(attached ? "filesAttached" : "filesInText");
    lines.push({
      m: "File", ext: a.id, sha256, name: a.name, ...(a.type ? { mime: a.type } : {}), issue: attached ? { ext: a.issueId! } : null,
      createdBy: userRef(a.createdById), createdAt: iso(a.createdAt),
    } satisfies BundleFile);
  }

  count("projects", projects.size);
  count("states", states.size);
  count("labels", labels.size);
  count("mentions", html.mentions);
  count("mentionsAsText", html.mentionsAsText);
  count("imagesLinked", html.images);
  count("imagesDropped", html.imagesDropped);
  count("attachmentsDropped", html.attachmentsDropped);
  return { header, lines, report };
}

/**
 * Relations of moved issues as bundle fields on the end that stores them: blocked_by and duplicate on `issueId`,
 * relates_to on `issueId` too. Gantt relations (start_before, finish_before) and Plane's newer "implemented_by" have no
 * place here and are counted; a second relation of the same pair is dropped (a pair has one).
 */
function relationsOf(rows: PlaneRelation[], issues: Set<string>, count: (k: string, n?: number) => void): Map<string, Pick<BundleIssue, "blockedBy" | "related" | "duplicateOf">> {
  const out = new Map<string, Pick<BundleIssue, "blockedBy" | "related" | "duplicateOf">>();
  const pairs = new Set<string>();
  for (const r of rows.filter(live)) {
    const pair = [r.issueId, r.relatedId].sort().join(" ");
    if (!issues.has(r.issueId) || !issues.has(r.relatedId) || r.issueId === r.relatedId) {
      count("relationsSkipped");
      continue;
    }
    if (!["blocked_by", "relates_to", "duplicate"].includes(r.type)) {
      count("relationsUnsupported");
      continue;
    }
    if (pairs.has(pair)) {
      count("relationsDuplicate");
      continue;
    }
    pairs.add(pair);
    // Plane's duplicate is symmetric and an issue may have several; we keep one "duplicate of" per issue, so a second
    // one goes on the other end if that end is free, else it is counted as dropped.
    let [holder, other] = [r.issueId, r.relatedId];
    if (r.type === "duplicate" && out.get(holder)?.duplicateOf) [holder, other] = [other, holder];
    const f = out.get(holder) ?? {};
    if (r.type === "duplicate" && f.duplicateOf) {
      count("relationsDropped");
      continue;
    }
    count("relations");
    const ref = { ext: other };
    if (r.type === "blocked_by") f.blockedBy = [...(f.blockedBy ?? []), ref];
    else if (r.type === "relates_to") f.related = [...(f.related ?? []), ref];
    else f.duplicateOf = ref;
    out.set(holder, f);
  }
  return out;
}

/** Timestamps from the database driver (Date or string) as ISO strings. */
function iso(t: string | Date): string {
  return new Date(t).toISOString();
}
