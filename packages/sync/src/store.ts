// The contract between the client sync engine and the UI. Screens read only through this interface; every getter is
// MobX-observable, so a component wrapped in observer() re-renders exactly when the data it read changes.
//
// The engine (client.ts, owned by the sync engine work) implements it on top of the snapshot, IndexedDB and the
// WebSocket log. Reads never touch the network: they come from the in-memory pool.
import type { Role } from "@rsva/policy";
import type { HistoryEntry, HistoryLevel, InboxEvent, InboxKind, InboxMark, ProjectComment, ProjectHistoryEntry, ProjectSettingEntry, PinRef, SavedView, SidebarGroups, ViewFields } from "@rsva/protocol";
import type { AssignableRole, Attachment, Comment, Cycle, CyclePatch, DocJSON, Document, GithubLink, Issue, IssuePatch, IssueUpdate, Label, LabelPatch, Project, ProjectCreate, ProjectPatch, RelationType, StateGroup, StatePatch, User, WorkflowState, WorkspaceInfo, WorkspacePatch } from "@rsva/schema/models";

import type { IssueRelations, IssueShelf } from "./pool.ts";

export type { Attachment, Comment, DocJSON, Document, GithubLink, HistoryEntry, HistoryLevel, InboxEvent, InboxKind, InboxMark, IssueRelations, IssueShelf, ProjectComment, ProjectHistoryEntry, ProjectSettingEntry, RelationType, SavedView, ViewFields };

/** A top-level comment with its replies, both oldest first. */
export interface CommentThread {
  comment: Comment;
  replies: Comment[];
}

/** Reactions with one emoji on one target, in order of the emoji's first use. */
export interface ReactionGroup {
  emoji: string;
  userIds: string[];
  /** The current user is among them: clicking removes theirs. */
  mine: boolean;
}

/** A comment the server refused: its text and why, until the author sends it again or drops it. Held in this tab. */
export interface NotSentComment {
  id: string;
  issueId: string;
  parentId: string | null;
  body: string;
  at: string;
  reason: string;
}

/**
 * The part of an issue that is not in the snapshot: comments, reactions and history. Loaded on the first `feed()` call
 * (when the issue opens), then kept live by deltas; observable like the rest of the store.
 */
export interface IssueFeed {
  /** "loading" only before the first answer; a later reload keeps showing the data it has. */
  readonly status: "loading" | "ready" | "error";
  /** What is shown is a kept copy known to be out of date: an edit of the whole description would overwrite newer text. */
  readonly behind: boolean;
  /** Top-level comments with replies. A deleted comment stays only as long as it has live replies. */
  readonly threads: CommentThread[];
  /** Field changes, oldest first. Creation is not an entry: draw it from the issue's createdAt and createdById. */
  readonly history: HistoryEntry[];
  /** The viewer's comments the server refused. */
  readonly notSent: readonly NotSentComment[];
  /** Forgets one: it was sent again, or deleted. */
  dropNotSent(id: string): void;
  /** Reactions to a comment, or to the issue itself when given the issue id. */
  reactions(targetId: string): ReactionGroup[];
  /** The issue has older activity than what is loaded (the server sends it in pages, newest first). */
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** Loads the page before the oldest one loaded; a no-op while one is loading or when there is none. */
  loadOlder(): void;
  /** After a failed first load: loads again, "loading" meanwhile. A no-op in any other state. */
  retry(): void;
}

/** A project's history at one level (PLNR-71): pages of it from the server, newest first, then live. */
export interface ProjectHistoryFeed {
  /** "loading" only before the first answer; a later reload keeps showing the data it has. */
  readonly status: "loading" | "ready" | "error";
  /**
   * Changes of the project's issues the level shows, oldest first. Creations are drawn from the issues: an I entry only
   * says what one started with (none for an imported issue).
   */
  readonly entries: readonly ProjectHistoryEntry[];
  /** Changes of the project's own states and labels, oldest first (at "everything" only). */
  readonly settings: readonly ProjectSettingEntry[];
  /** Comments on them, oldest first (none at "outcomes"). */
  readonly comments: readonly ProjectComment[];
  /** Where the loaded history starts (older activity exists before it); null when it reaches the beginning. */
  readonly older: string | null;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  loadOlder(): void;
}

/** The viewer's subscription to an issue (PLNR-28). */
export interface Subscription {
  following: boolean;
  /** They pressed Subscribe or Unsubscribe; otherwise `following` is their involvement. */
  chosen: boolean;
  /** How they are involved, the strongest reason first; null when not at all. */
  involved: "assignee" | "creator" | "commenter" | null;
}

/** One issue in the inbox: its notifications since it was last archived, the newest shown. */
export interface InboxRow {
  issue: Issue;
  /** Oldest first. */
  events: InboxEvent[];
  latest: InboxEvent;
  kinds: ReadonlySet<InboxKind>;
  unread: boolean;
  /** Set while the row is snoozed: when it comes back. */
  snoozedUntil: string | null;
}

/**
 * The viewer's notifications (PLNR-26): read off the log, never stored per recipient. Marks apply at once and go to
 * the server, which echoes them to the viewer's other tabs and devices.
 */
export interface InboxStore {
  /** "loading" until the first answer or a saved copy. */
  readonly status: "loading" | "ready";
  /** Every issue with a notification that is not archived, newest first; snoozed ones carry `snoozedUntil`. */
  readonly rows: InboxRow[];
  /** Unread rows that are not snoozed: the badge. */
  readonly unread: number;
  /** Marks the rows read (or unread: the latest notification becomes new again). */
  read(issueIds: readonly string[], read?: boolean): void;
  /** Out of the inbox until a newer notification arrives; also marks them read. */
  archive(issueIds: readonly string[]): void;
  /** Hidden until `until` or a newer notification; null brings it back now. */
  snooze(issueId: string, until: Date | null): void;
  /**
   * Whether the viewer hears the issue's state changes and comments, and why: their Subscribe or Unsubscribe (`chosen`),
   * else whether they are involved. Assignments, reviews, approvals, mentions and replies come anyway.
   */
  subscription(issue: Issue): Subscription;
  /** Subscribe (true) or Unsubscribe (false) from now on: the notifications already in the inbox stay. */
  subscribe(issueId: string, on: boolean): void;
  /** The marks as they are now, to put back with restore() (undo). */
  marksOf(issueIds: readonly string[]): InboxMark[];
  restore(marks: readonly InboxMark[]): void;
}

/**
 * Saved views (PLNR-74): the workspace's shared ones and the viewer's own, and which of them the viewer keeps in the
 * sidebar. Changes show at once and go to the server, which sends them to everyone who sees the view.
 */
export interface ViewsStore {
  /** "loading" until the first answer or a saved copy. */
  readonly status: "loading" | "ready";
  /** Oldest first; projects' homes are not among them (`homes`). */
  readonly list: SavedView[];
  /** Projects' homes (ADR 0053): views with the layout "home", the shared ones and the viewer's own, oldest first. */
  readonly homes: SavedView[];
  get(id: string): SavedView | undefined;
  /** Creates the view (an id it does not know, every field given) or changes it; saving a deleted one brings it back. */
  save(id: string, set: Partial<ViewFields>): void;
  remove(id: string): void;
  /** The viewer's own order of the workspace's projects, by id: what `projectList` follows. */
  readonly projectOrder: string[];
  setProjectOrder(ids: string[]): void;
  /** The sidebar's Pinned section, in order (PLNR-292): views, issues and cycles. */
  readonly pins: PinRef[];
  pinned(ref: PinRef): boolean;
  /** Pins last or unpins. */
  pin(ref: PinRef, pinned: boolean): void;
  setPins(refs: PinRef[]): void;
  /** Puts a pin right before `next` (undefined: last). */
  movePin(ref: PinRef, next: PinRef | undefined): void;
  /** Projects the viewer took out of their sidebar. */
  readonly hiddenProjects: string[];
  hideProject(id: string, hidden: boolean): void;
  /** The viewer's groups of projects and their Quiet choices (RSVA-566), whole. */
  readonly groups: SidebarGroups;
  setGroups(groups: SidebarGroups): void;
}

/** One issue's part of a bulk change. */
export interface IssueChange {
  id: string;
  patch: IssueUpdate;
}

export type LoadStatus =
  /** Nothing to show yet: no local copy and the snapshot has not reached `ready`. */
  | "loading"
  /** The open screen's data is here (from IndexedDB or the snapshot's `ready` frame); the rest may still stream. */
  | "ready"
  /** The workspace does not exist or the snapshot failed; see `error`. */
  | "error";

export type ConnectionStatus = "connecting" | "online" | "offline";

/** How the connection is doing, for whoever asks why something feels slow. Measured on traffic that goes anyway. */
export interface LinkHealth {
  /** Round trip of the last ping, ms; null until one is answered on this connection. */
  pingMs: number | null;
  /** From sending the last confirmed change to its ack, ms: the database's time as well as the network's. */
  saveMs: number | null;
  /** Log entries this client lacks by the tail the last pong named; null until a pong on this connection names it. */
  behind: number | null;
  /** How many times a working connection was lost since the workspace opened in this tab. */
  drops: number;
  /** When the last one was lost (ISO). */
  lostAt: string | null;
}

export type ErrorCode = "not_found" | "unauthorized" | "forbidden";

/**
 * Where the viewer's changes stand. "saved": all confirmed by the server. "saving": on their way. "offline": no connection;
 * they wait on this device and go out when it is back. "stalled": connected, but no confirmation for some seconds.
 */
export type SaveState = "saved" | "saving" | "offline" | "stalled";

/** What a refused change held that exists nowhere else now. */
export interface LostWork {
  /** A refused title or edit of a comment. */
  text: string | null;
  /** The refused description. */
  doc: DocJSON | null;
}

/** The last refusal; `count` says how many there were since it was last cleared. */
export interface Rejection {
  code: string;
  message: string;
  count: number;
  lost: LostWork[];
}

export type { WorkspaceInfo } from "@rsva/schema/models";

export interface SyncStore {
  readonly status: LoadStatus;
  readonly error: string | null;
  /**
   * Set when the error is permanent and the engine stops retrying: the workspace does not exist (or is not the viewer's),
   * the session ended (sign in again), or the viewer's role may not open it.
   */
  readonly errorCode: ErrorCode | null;
  readonly connection: ConnectionStatus;
  /** Last log number applied locally. */
  readonly lastSyncId: number;
  readonly link: LinkHealth;
  /** Local transactions the server has not confirmed yet. */
  readonly pendingCount: number;
  /** Where those changes stand, for the user: an unconfirmed change must never look saved. */
  readonly saveState: SaveState;
  /** They could not be written to this device's disk: they are lost if the tab closes. */
  readonly unsafe: boolean;

  readonly workspace: WorkspaceInfo | null;
  readonly me: User | null;
  /** The viewer's role in the workspace: what to offer (packages/policy); the server enforces it either way. */
  readonly role: Role | null;

  readonly users: ReadonlyMap<string, User>;
  readonly projects: ReadonlyMap<string, Project>;
  readonly states: ReadonlyMap<string, WorkflowState>;
  readonly labels: ReadonlyMap<string, Label>;
  readonly cycles: ReadonlyMap<string, Cycle>;
  readonly issues: ReadonlyMap<string, Issue>;
  readonly inbox: InboxStore;
  readonly views: ViewsStore;

  /** Pings now instead of at the next interval: someone is looking at the numbers. */
  measureLink(): void;
  /** Projects in the viewer's own order, those it does not name after them by key, without archived ones. */
  projectList(): Project[];
  /** Archived projects ordered by key. */
  archivedProjects(): Project[];
  /** By key, or by a key it had before a rename: old links keep working. Compare with `project.key` to redirect. */
  projectByKey(key: string): Project | undefined;
  /** A project's states by position. */
  statesOf(projectId: string): WorkflowState[];
  /** Labels usable in a project: its own plus workspace labels, by position. */
  labelsOf(projectId: string): Label[];
  /** A project's cycles by number, completed ones too (PLNR-63). */
  cyclesOf(projectId: string): Cycle[];
  /** A cycle's live issues by sortOrder. */
  issuesInCycle(cycleId: string): Issue[];
  /** A project's live issues by sortOrder; its archive or its trash (deleted ones), latest first. */
  issuesOf(projectId: string, shelf?: IssueShelf): Issue[];
  /** How many of a project's live issues are open: not in a completed or cancelled state. */
  activeCount(projectId: string): number;
  /** Whether an active issue of the project is urgent: the dot on its tag in the collapsed sidebar. */
  hasUrgent(projectId: string): boolean;
  /** When anything in the project last changed: its newest issue change, or its making. */
  lastChange(projectId: string): string;
  /** Whether an active issue of the project was due before `today` (YYYY-MM-DD). */
  hasOverdue(projectId: string, today: string): boolean;
  /** Live sub-issues (neither archived nor deleted) by sortOrder; `all` adds the archived and deleted ones. */
  subIssuesOf(issueId: string, all?: boolean): Issue[];
  /** Both ends of an issue's relations (live issues only): blocked by, blocks, related, duplicate of, duplicates. */
  relationsOf(issueId: string): IssueRelations;
  /** One of the issue's blockers is live and still open. */
  isBlocked(issue: Issue): boolean;
  /** The issue is open and a live open issue waits on it. */
  isBlocking(issue: Issue): boolean;
  /** A link, a pull request or a commit is attached to the issue (not a file): `has:link`. */
  hasLink(issue: Issue): boolean;
  /** The issue's links, oldest first. */
  attachmentsOf(issueId: string): Attachment[];
  /** The issue's pull requests and commits: known once its feed has loaded, then live. */
  githubOf(issueId: string): GithubLink[];
  /** The viewer may delete this issue or restore it from the trash: its creator or an admin. */
  mayDelete(issue: Issue): boolean;
  /** "PLANE-60" → issue, archived and deleted ones too. */
  issueByKey(key: string): Issue | undefined;
  /** issue → "PLANE-60". New issues created offline read "PLANE-?" until the server assigns a number. */
  issueKey(issue: Issue): string;
  /** True while the issue (or comment) has local changes the server has not confirmed; with "Document", its description. */
  isPending(id: string, model?: "Document"): boolean;

  /**
   * Applies the change locally at once (same frame), then sends it; a server rejection reverts it. `archivedAt` or
   * `deletedAt` any time archives or deletes, null restores.
   */
  updateIssue(id: string, patch: IssueUpdate): void;
  /**
   * Many issues in one act (bulk actions, PLNR-294): each patch as updateIssue writes it, in as few transactions as the
   * server's limit allows, so past that limit it is not all or nothing.
   */
  updateIssues(patches: readonly IssueChange[]): void;
  /**
   * Deletes an issue in the trash for good (RSVA-457): gone here at once, its sub-issues and relations let go of it by the
   * server. A live issue is left alone: it goes to the trash first (`deletedAt`).
   */
  purgeIssue(id: string): void;
  /**
   * Moves issues to another project of the workspace at once (PLNR-448): the state, labels and cycle as the server maps
   * them, the number when it answers; the old key keeps finding each. Issues already there and deleted ones are left
   * out; returns how many moved.
   */
  moveIssues(ids: Iterable<string>, projectId: string): number;
  /** Creates an issue locally at once and returns it; the number comes from the server. `doc`: its description. */
  createIssue(projectId: string, set: IssuePatch & { title: string; stateId: string }, doc?: DocJSON | null): Issue;
  /**
   * The issue's description, loaded with its feed (call feed() first); undefined until then, `doc` null when empty.
   * Observable: a save from anywhere (another tab, an agent) shows up here.
   */
  description(issueId: string): Document | undefined;
  /**
   * Replaces the description at once, then sends it. `seen`: `tx` of the text the edit started from (`description()`).
   * If the text moved on meanwhile the server refuses this save, the text here goes back to theirs, and the refused text
   * is in `lastRejection.lost`: until Yjs merges two edits, neither is overwritten unseen.
   */
  updateDescription(issueId: string, doc: DocJSON, seen?: string | null): void;

  /**
   * Relates two issues, replacing any relation the pair had (a pair has one). "blocks" and "duplicates" are written on the
   * other issue, as its "blocked by" and "duplicate of".
   */
  addRelation(issueId: string, type: RelationType, otherId: string): void;
  /** Removes the pair's relation, whichever end stores it. */
  removeRelation(issueId: string, otherId: string): void;
  /** Adds a link (cleaned as the server stores it); null for an address that is not http or https. */
  addLink(issueId: string, url: string, title?: string): Attachment | null;
  updateLink(id: string, patch: { url?: string; title?: string }): void;
  removeLink(id: string): void;
  /** Adds a file whose bytes are already uploaded (PUT /files/:ws/:sha256); `updateLink` renames it, `removeLink` takes it off. */
  addFile(issueId: string, file: { sha256: string; size: number; mime: string }, name: string): Attachment | null;

  /** Comments, reactions and history of an issue; the first call starts loading them. */
  feed(issueId: string): IssueFeed;
  /** A project's history at a level (PLNR-71); the first call starts loading it. */
  projectHistory(projectId: string, level: HistoryLevel): ProjectHistoryFeed;
  /** Adds a comment (Markdown) at once and returns it; `parentId` makes it a reply to a top-level comment. */
  addComment(issueId: string, body: string, parentId?: string | null): Comment;
  /** Own comments only; the server rejects anyone else's, and the edit reverts. */
  editComment(id: string, body: string): void;
  /** Leaves a tombstone so replies keep their thread. */
  deleteComment(id: string): void;
  /** Adds the current user's reaction, or removes it if it is there. `commentId` null reacts to the issue. */
  toggleReaction(issueId: string, commentId: string | null, emoji: string): void;
  // Settings: applied at once like issue edits, reverted on rejection.
  /** Name and color of the open workspace. */
  updateWorkspace(patch: WorkspacePatch): void;
  /** An admin gives a member another role; shows at once, reverts if the server refuses. */
  setMemberRole(userId: string, role: AssignableRole): void;
  /** An admin removes a member: their row stays with role null, so their name still shows on their work. */
  removeMember(userId: string): void;
  /** The viewer's own order: moves a project to `index` among the other projects of `projectList`. */
  moveProject(id: string, index: number): void;
  /** A new project with the default workflow (DEFAULT_WORKFLOW), last in the viewer's order. Admins only. */
  createProject(set: ProjectCreate): Project;
  /** Name, key (the old one stays an alias), color, archive: `archivedAt` any time archives, null restores. */
  updateProject(id: string, patch: ProjectPatch): void;
  /** A new state, last in its group. */
  createState(projectId: string, name: string, group: StateGroup): WorkflowState;
  /** `isDefault: true` moves the default here (the old one loses it in the same transaction); false is ignored. */
  updateState(id: string, patch: StatePatch): void;
  /** Moves every issue in the state (archived too) to `moveTo`, which also becomes the default if this one was. */
  deleteState(id: string, moveTo: string): void;
  createLabel(projectId: string, name: string, color: string): Label;
  updateLabel(id: string, patch: LabelPatch): void;
  /** Takes the label off every issue and moves labels inside it up a level, then deletes it. */
  deleteLabel(id: string): void;
  /** A new cycle, numbered after the project's last (the server confirms the number); without dates it is a draft. */
  createCycle(projectId: string, set: Omit<CyclePatch, "completedAt"> & { name: string }): Cycle;
  updateCycle(id: string, patch: Omit<CyclePatch, "completedAt">): void;
  /**
   * Completes the cycle: its summary is frozen by the server, then each open issue not in `keep` moves to `moveTo` (a
   * cycle id, or null for no cycle), in the same transaction.
   */
  completeCycle(id: string, moveTo: string | null, keep: readonly string[]): void;
  /** Takes every issue out of the cycle, then deletes it. Completed cycles are kept. */
  deleteCycle(id: string): void;
  /** The last rejected transaction, for a toast; cleared by the UI. */
  readonly lastRejection: Rejection | null;
  clearRejection(): void;
}
