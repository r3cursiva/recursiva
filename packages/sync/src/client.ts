// The client sync engine: implements SyncStore on top of the snapshot, IndexedDB and the WebSocket log.
//
// Data flow, as in Linear's sync engine:
// - Cold start streams the snapshot and applies it batch by batch; warm start reads the last copy from IndexedDB and
//   is ready before any network call, then catches up over the socket from its lastSyncId.
// - Deltas are applied strictly in log order. A gap means a frame was missed: re-subscribe from the last applied number.
// - Local edits apply to the pool in the same tick and go to a persisted queue. For every field a pending transaction
//   touches, the engine keeps the latest server value ("shadow"). A server delta updates the shadow and the pool, then
//   the pending patches are re-applied on top (rebase); a rejection restores the shadow value, not the value the user
//   saw before the edit, because someone else may have changed the field meanwhile.
//
// Environment pieces (fetch, WebSocket, IndexedDB, reload) are options with browser defaults, so a CLI or a test can run
// the same engine.
import { isRole, mayDeleteIssue, type Role } from "@rsva/policy";
import {
  CLOSE_FORBIDDEN,
  CLOSE_NOT_FOUND,
  CLOSE_TOO_BIG,
  CLOSE_UNAUTHORIZED,
  newProjectOps,
  txChunks,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  VIEWER_HEADERS,
  descriptionEntry,
  settingsFrom,
  githubOf,
  historyFields,
  movedFrom,
  createdFields,
  settingFields,
  uuidv7,
  type AccountSettings,
  type Action,
  type ClientFrame,
  type HistoryEntry,
  type HistoryLevel,
  type Op,
  type ServerFrame,
  type SnapshotBatch,
  type SnapshotLine,
  type SnapshotMeta,
  type SplitOps,
} from "@rsva/protocol";
import { blankIssueFields, cleanName, cleanUrl, filePath, isFileCreate, readLink } from "@rsva/schema/models";
import type {
  AssignableRole,
  Attachment,
  Comment,
  Cycle,
  CyclePatch,
  DocJSON,
  Document,
  GithubLink,
  Issue,
  IssuePatch,
  IssueUpdate,
  Label,
  LabelPatch,
  Project,
  ProjectCreate,
  ProjectPatch,
  Reaction,
  RelationType,
  StateGroup,
  StatePatch,
  User,
  WorkflowState,
  WorkspacePatch,
} from "@rsva/schema/models";
import { computed, makeObservable, observable, observableRef, runInAction } from "mobx";
import type { Feed } from "./feed.ts";
import { FeedCache, type FeedHost } from "./feeds.ts";
import type { ProjectFeed, SettingDelta } from "./project-feed.ts";
import { Inbox, type SavedInbox } from "./inbox.ts";
import { movedOrder, orderProjects } from "./project-order.ts";
import { Views, type SavedViews } from "./views.ts";
import { copyName, type Disk, type Disks } from "./disk.ts";
import { idbDisks } from "./idb.ts";
import { Link, type LinkHost, type LinkTimes, type SocketLike } from "./link.ts";
import { lines } from "./lines.ts";
import { now, warn } from "./log.ts";
import { cycleComplete, cycleDelete, issueMoves, labelCreate, labelDelete, linkUpdate, reactionToggle, relationChange, rowUpdate, stateCreate, stateDelete, stateUpdate, withBase, workspaceUpdate } from "./writes.ts";
import { MODELS, Pool, type AnyModel, type IssueRelations, type IssueShelf, type Row } from "./pool.ts";
import type { ConnectionStatus, ErrorCode, IssueChange, LinkHealth, LoadStatus, LostWork, NotSentComment, Rejection, SaveState, SyncStore, WorkspaceInfo } from "./store.ts";
import { errorText } from "@rsva/schema/util";

/** Why an engine stops when the browser's credential is now someone else's: their sign-in replaced this person's. */
export const OTHER_PERSON = "signed in as someone else in this browser";
/** The permanent refusal an HTTP status means, if any. */
const deniedBy = (status: number): ErrorCode | null => (status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not_found" : null);

export type { LinkTimes, SocketLike } from "./link.ts";

export interface SyncStoreOptions {
  /** Workspace slug. */
  workspace: string;
  /** Key of the project on screen: its issues come first in a cold snapshot, before `ready`. */
  project?: string;
  /** Server origin, e.g. "http://127.0.0.1:3800". Defaults to the page's origin. */
  baseUrl?: string;
  /** Defaults to baseUrl with ws(s): and the /ws path. */
  socketUrl?: string;
  fetch?: typeof fetch;
  WebSocket?: new (url: string) => SocketLike;
  /** null keeps nothing on disk (a CLI without storage). Defaults to globalThis.indexedDB. */
  indexedDB?: IDBFactory | null;
  /** Where the copy lives instead of IndexedDB: the TUI's folder of files. null keeps nothing; wins over `indexedDB`. */
  disk?: Disks | null;
  /** The server speaks another protocol version: the shell must be replaced. Defaults to location.reload(). */
  reload?: () => void;
  /** A socket other than the first has said hello: the server may have restarted, as a deploy does. */
  onReconnect?: () => void;
  /** Delay between a change and writing the snapshot to IndexedDB, ms. */
  persistDelay?: number;
  /** Reconnect backoff bounds, ms. */
  backoff?: readonly [min: number, max: number];
  /** Delay between being ready (or reconnecting) and fetching the activity to keep, ms. */
  fillDelay?: number;
  /** How the engine tells a live link from a dead one, ms: see DEFAULT_LINK. */
  link?: Partial<LinkTimes>;
  /** The viewer's own settings, from a snapshot answer that carries them (VIEWER_HEADERS): the app keeps them. */
  onAccount?: (settings: AccountSettings) => void;
  /**
   * Issues someone else just made or changed, live: the screens may show it. Not the viewer's own changes (from any of
   * their tabs or devices), nor a snapshot or a catch-up, which only bring the copy up to date. Called after the pool has
   * them, before anything re-renders.
   */
  onOthersChange?: (issueIds: readonly string[]) => void;
}

/** Refusals that are about now and not about the change: it stays queued and goes again after the wait. */
const TRANSIENT_REFUSALS = new Set(["rate_limited", "no_sub"]);
/** The wait after a transient refusal that names none, ms. */
const REFUSED_WAIT_MS = 2000;

/** Timings of the last snapshot, load and save, ms: for perf checks, not for the UI. */
export interface SyncStats {
  snapshotMs: number;
  parseMs: number;
  applyMs: number;
  rows: number;
  loadMs: number;
  saveMs: number;
}

export interface SyncEngine extends SyncStore {
  /** The workspace this engine was created for. */
  readonly slug: string;
  /** Loads the local copy (or the snapshot) and connects. Resolves once the data is ready or loading failed. */
  start(): Promise<void>;
  /** Writes the snapshot to IndexedDB now instead of after the debounce. */
  persist(): Promise<void>;
  /**
   * A saved view or an inbox mark written here and not echoed by the server yet. Unlike a change in pendingCount it is
   * not in the queue on disk: only the snapshot keeps it, written a moment later, and a failed write keeps it nowhere.
   */
  readonly unconfirmedOutbox: boolean;
  /**
   * This engine's copy or queue is that person's: nobody else's changes wait in it, and it holds something of theirs
   * (they are the viewer it was loaded for, or changes queued in their name).
   */
  belongsTo(userId: string): boolean;
  /**
   * Writes the copy and the queue anew to a fresh database of the workspace, then closes it: for a tab whose database
   * was deleted under it (another person signed in) when its own person signs in again, before the page reloads.
   * Works after dispose(); does nothing without a disk.
   */
  rewrite(): Promise<void>;
  dispose(): void;
  readonly stats: SyncStats;
}

export function createSyncStore(options: SyncStoreOptions): SyncEngine {
  return new Engine(options);
}

interface PendingTx {
  id: string;
  /** Creation order; UUIDv7 alone does not order two transactions made in the same millisecond. */
  n: number;
  ops: Op[];
  /** Creation time: the local createdAt, editedAt and deletedAt of comments until the server's values arrive. */
  at?: string;
  /** Set by the ack: the log number after which the transaction's effect is part of the server state. */
  s?: number;
  /** Has gone out on a socket in this tab; one read from disk may have. Its content can no longer change. */
  sent?: boolean;
  /**
   * Whose change it is. The queue on disk outlives the saved copy (one of another protocol version is dropped), and the
   * person the next snapshot names is only whoever holds the browser's credential then. Missing before PLNR-189.
   */
  by?: string;
}

/** How long the start (or a reconnect) has the network to itself before the activity to keep is fetched. */
const FILL_DELAY_MS = 2000;

/**
 * Key of a row in the engine's bookkeeping (pending counts, shadows). Ids are UUIDs unique across models, except a
 * description, which shares its issue's id: it gets its own key so its pending state and server values stay apart.
 */
const keyOf = (m: string, id: string) => (m === "Document" ? `doc:${id}` : id);

/** Most ops in one transaction; the server accepts 500. A bigger change goes as several, in order. */
const TX_OPS = 400;

/** A delete that takes the row away. Deleting a comment leaves a tombstone instead: an update of the row. */
/** Deleting a comment leaves a tombstone and removing a member keeps their user row (role null): both are patches. */
const isRemoval = (op: Op): op is Extract<Op, { op: "delete" }> => op.op === "delete" && op.m !== "Comment" && op.m !== "User";

/** Fields an op sets on an existing row (its optimistic patch). Creates and removals have none. */
function patchOf(op: Op, at: string): Row | null {
  if (op.op === "update" && op.m === "Attachment" && op.set.url !== undefined) return { ...op.set, kind: readLink(op.set.url).kind };
  if (op.op === "update") return op.m === "Comment" ? { ...op.set, editedAt: at } : op.set;
  if (op.op === "delete" && op.m === "Comment") return { body: "", deletedAt: at };
  if (op.op === "delete" && op.m === "User") return { role: null };
  return null;
}

/** An issue update that moves it to another project (PLNR-448). */
const movesProject = (op: Op): op is Extract<Op, { m: "Issue"; op: "update" }> => op.m === "Issue" && op.op === "update" && op.set.projectId !== undefined;

/** The fields an op may set locally: its patch, and for a move the number and keys localPatch adds. */
function touchedBy(op: Op, at: string): Row | null {
  const p = patchOf(op, at);
  return p && movesProject(op) ? { ...p, number: 0, formerKeys: [] } : p;
}

/**
 * What IndexedDB keeps: the server state at `s`, without local optimistic values. Stored as a plain object (structured
 * clone), not gzipped JSON: in Chromium that is 2x faster to read and save for our workspace and 5-8x faster at 20 times
 * its size (docs/research/sync-engine-2026-10-27.md).
 */
interface Saved {
  v: number;
  s: number;
  ws: WorkspaceInfo;
  me: string;
  role: Role | null;
  b: Pick<SnapshotBatch, "m" | "c" | "r">[];
  /** The viewer's inbox at `s`; missing in a copy saved before it existed (the next connection asks for it whole). */
  ib?: SavedInbox;
  /** The viewer's saved views (PLNR-74); missing in a copy saved before them (the next connection asks for them whole). */
  vw?: SavedViews;
  /** Issues whose kept activity is behind `s`, each with its last action; missing until activity has been kept (PLNR-80). */
  fs?: [issueId: string, action: number][];
}

/** An issue someone else made or changed in a way a row shows: `updatedAt` or what GitHub did alone changes no cell. */
const othersIssue = (a: Action, me: string): boolean =>
  a.m === "Issue" && (a.a === "I" || a.a === "U") && !!a.by && a.by !== me && Object.keys(a.d ?? {}).some((k) => k !== "updatedAt" && k !== "gh");

/** A new issue's entry for a project's history: what it started with. The issue feed has no use for it. */
function createdEntry(a: Action): HistoryEntry {
  return { id: a.id, a: "I", by: a.by ?? null, at: (a.d?.createdAt as string | undefined) ?? new Date().toISOString(), d: createdFields(a.d), p: {} };
}

/** Window and document, where there are any: the engine also runs in Node. */
interface Listens {
  addEventListener?: (t: string, f: (e: never) => void) => void;
  removeEventListener?: (t: string, f: (e: never) => void) => void;
  document?: unknown;
}

const encoder = new TextEncoder();

/** A transaction as the disk keeps it: what a restart needs, not what the connection tracks. */
const stored = (tx: PendingTx) => ({ id: tx.id, n: tx.n, ops: tx.ops, at: tx.at, by: tx.by });

/** The frame would be refused unread. The size in bytes is computed only for a text that could reach the limit. */
function tooBig(tx: PendingTx): boolean {
  const text = JSON.stringify({ t: "tx", id: tx.id, ops: tx.ops });
  return text.length * 3 > MAX_FRAME_BYTES && encoder.encode(text).length > MAX_FRAME_BYTES;
}

/**
 * Members that are neither private nor in SyncEngine are what FeedCache and Link read of the engine (FeedHost, LinkHost):
 * the engine is their host itself, not an object of closures. The class is not exported.
 */
class Engine implements SyncEngine, FeedHost, LinkHost {
  status: LoadStatus = "loading";
  error: string | null = null;
  errorCode: ErrorCode | null = null;
  role: Role | null = null;
  connection: ConnectionStatus = "connecting";
  lastSyncId = 0;
  pendingCount = 0;
  lastRejection: Rejection | null = null;
  /** The oldest change has gone unconfirmed too long. */
  private stalled = false;
  /** Changes cannot be written to the disk: closing the tab loses them. */
  unsafe = false;
  readonly stats: SyncStats = { snapshotMs: 0, parseMs: 0, applyMs: 0, rows: 0, loadMs: 0, saveMs: 0 };

  meId = "";
  /** The open workspace's row in the pool (`workspace`). */
  private wsId: string | null = null;
  readonly pool = new Pool();
  private pending: PendingTx[] = [];
  private seq = 0;
  /** Row key (keyOf) → number of pending transactions touching it. */
  private readonly pendingById = observable.map<string, number>();
  /** Row key (keyOf) → latest server values of the fields pending transactions changed. */
  private readonly shadow = new Map<string, Row>();
  /** Rows created here that the server has not echoed yet: not part of the server state. */
  readonly created = new Map<string, AnyModel>();
  /** Rows removed here while the removal is pending: the server copy, put back if the server rejects it. */
  readonly removed = new Map<string, { m: AnyModel; row: Row }>();
  /** Opened issues' feeds and project histories, and the activity kept on disk. */
  private readonly feeds: FeedCache;
  /** This connection has the log up to now. The feeds' stale list only knows of what has arrived: before this, a copy may miss more. */
  caughtUp = false;
  readonly inbox: Inbox;
  readonly views: Views;
  private readonly orderedProjects = computed(() => orderProjects(this.pool.projectList(), this.views.projectOrder), { keepAlive: true });

  /** The pool holds a complete server state at lastSyncId: deltas apply and `sub` may be sent. */
  private based = false;
  private fetching = false;
  /** The socket to the server. */
  private readonly wire: Link;
  private resubbing = false;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private holdUntil = 0;
  /** Changes in memory only: not written to the disk, or there is no disk. */
  private readonly unstored = new Set<string>();
  /** When each change went out on this connection. Not on the transaction: that is written to disk, and this clock is the tab's. */
  private readonly sentAt = new Map<string, number>();
  private dirty = false;
  private saving = Promise.resolve();
  db: Disk | null = null;
  disposed = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  readonly abort = new AbortController();

  readonly slug: string;
  private readonly project: string | undefined;
  private readonly base: string;
  private readonly http: typeof fetch;
  private readonly disks: Disks | null;
  private readonly reload: () => void;
  private readonly onReconnect: (() => void) | undefined;
  private readonly onOthersChange: ((issueIds: readonly string[]) => void) | undefined;
  private readonly persistDelay: number;
  private readonly onAccount: ((settings: AccountSettings) => void) | undefined;
  readonly fillDelay: number;

  constructor(o: SyncStoreOptions) {
    const g = globalThis as { location?: Location; WebSocket?: new (url: string) => SocketLike; indexedDB?: IDBFactory };
    this.slug = o.workspace;
    this.project = o.project;
    this.base = (o.baseUrl ?? g.location?.origin ?? "").replace(/\/$/, "");
    this.http = o.fetch ?? ((input, init) => fetch(input, init));
    const factory = o.indexedDB === undefined ? (g.indexedDB ?? null) : o.indexedDB;
    this.disks = o.disk !== undefined ? o.disk : factory ? idbDisks(factory) : null;
    this.reload = o.reload ?? (() => g.location?.reload());
    this.onReconnect = o.onReconnect;
    this.onOthersChange = o.onOthersChange;
    this.persistDelay = o.persistDelay ?? 1000;
    this.onAccount = o.onAccount;
    this.fillDelay = o.fillDelay ?? FILL_DELAY_MS;
    this.wire = new Link(o.socketUrl ?? `${this.base.replace(/^http/, "ws")}/ws`, o.WebSocket ?? g.WebSocket, o.link, o.backoff ?? [500, 30_000], this);
    this.feeds = new FeedCache(this);
    this.inbox = new Inbox(this.pool, () => this.meId, () => this.role, () => this.lastSyncId, (f) => this.send(f), () => this.markDirty());
    this.views = new Views(() => this.meId, (f) => this.send(f), () => this.markDirty());
    makeObservable<Engine, "wsId" | "stalled">(this, {
      status: observable,
      stalled: observable,
      unsafe: observable,
      saveState: computed,
      error: observable,
      errorCode: observable,
      role: observable,
      connection: observable,
      lastSyncId: observable,
      link: computed,
      pendingCount: observable,
      wsId: observable,
      workspace: computed,
      lastRejection: observableRef,
      meId: observable,
      me: computed,
    });
  }

  // ── Reads ───────────────────────────────────────────────────────────────────────────────────────────────────

  get link(): LinkHealth {
    const { tail, ...health } = this.wire.health;
    return { ...health, behind: tail === null ? null : Math.max(0, tail - this.lastSyncId) };
  }

  measureLink(): void {
    this.wire.probe();
  }

  get unconfirmedOutbox(): boolean {
    return this.views.unconfirmed || this.inbox.unconfirmed;
  }

  get saveState(): SaveState {
    if (this.pendingCount === 0) return "saved";
    if (this.connection !== "online") return "offline";
    return this.stalled ? "stalled" : "saving";
  }

  get workspace(): WorkspaceInfo | null {
    return this.wsId ? (this.pool.maps.Workspace.get(this.wsId) ?? null) : null;
  }

  get me(): User | null {
    return this.pool.maps.User.get(this.meId) ?? null;
  }
  get users(): ReadonlyMap<string, User> {
    return this.pool.maps.User;
  }
  get projects(): ReadonlyMap<string, Project> {
    return this.pool.maps.Project;
  }
  get states(): ReadonlyMap<string, WorkflowState> {
    return this.pool.maps.WorkflowState;
  }
  get labels(): ReadonlyMap<string, Label> {
    return this.pool.maps.Label;
  }
  get cycles(): ReadonlyMap<string, Cycle> {
    return this.pool.maps.Cycle;
  }
  get issues(): ReadonlyMap<string, Issue> {
    return this.pool.maps.Issue;
  }
  projectList(): Project[] {
    return this.orderedProjects.get();
  }
  projectByKey(key: string): Project | undefined {
    return this.pool.projectByKey(key);
  }
  archivedProjects(): Project[] {
    return this.pool.archivedProjects();
  }
  statesOf(projectId: string): WorkflowState[] {
    return this.pool.statesOf(projectId);
  }
  labelsOf(projectId: string): Label[] {
    return this.pool.labelsOf(projectId);
  }
  cyclesOf(projectId: string): Cycle[] {
    return this.pool.cyclesOf(projectId);
  }
  issuesInCycle(cycleId: string): Issue[] {
    return this.pool.issuesInCycle(cycleId);
  }
  issuesOf(projectId: string, shelf?: IssueShelf): Issue[] {
    return this.pool.issuesOf(projectId, shelf);
  }
  activeCount(projectId: string): number {
    return this.pool.activeCount(projectId);
  }
  hasUrgent(projectId: string): boolean {
    return this.pool.hasUrgent(projectId);
  }
  lastChange(projectId: string): string {
    return this.pool.lastChange(projectId);
  }
  hasOverdue(projectId: string, today: string): boolean {
    return this.pool.hasOverdue(projectId, today);
  }
  subIssuesOf(issueId: string, all?: boolean): Issue[] {
    return this.pool.subIssuesOf(issueId, all);
  }
  relationsOf(issueId: string): IssueRelations {
    return this.pool.relationsOf(issueId);
  }
  isBlocked(issue: Issue): boolean {
    return this.pool.isBlocked(issue);
  }

  isBlocking(issue: Issue): boolean {
    return this.pool.isBlocking(issue);
  }

  hasLink(issue: Issue): boolean {
    return this.pool.hasLink(issue);
  }
  attachmentsOf(issueId: string): Attachment[] {
    return this.pool.attachmentsOf(issueId);
  }

  githubOf(issueId: string): GithubLink[] {
    return this.pool.githubOf(issueId);
  }
  mayDelete(issue: Issue): boolean {
    return mayDeleteIssue(this.role, !!this.meId && issue.createdById === this.meId);
  }
  issueByKey(key: string): Issue | undefined {
    return this.pool.issueByKey(key);
  }
  issueKey(issue: Issue): string {
    return this.pool.issueKey(issue);
  }
  isPending(id: string, model?: "Document"): boolean {
    return this.pendingById.has(keyOf(model ?? "", id));
  }

  // ── Writes ──────────────────────────────────────────────────────────────────────────────────────────────────

  updateIssue(id: string, patch: IssueUpdate): void {
    this.updateIssues([{ id, patch }]);
  }

  updateIssues(patches: readonly IssueChange[]): void {
    this.enqueueAll({ first: patches.flatMap(({ id, patch }) => rowUpdate(this.pool, "Issue", id, patch)), last: [] });
  }

  purgeIssue(id: string): void {
    if (this.pool.get("Issue", id)?.deletedAt) this.enqueue([{ op: "delete", m: "Issue", id }]);
  }

  /**
   * Moves issues to another project of the workspace (PLNR-448), shown at once: each takes the state, labels and cycle the
   * server will give it (moveState, moveLabels; the cycle is cleared), and its number when the server answers. Issues
   * already there and deleted ones are left out; how many moved. One transaction up to the client's limit.
   */
  moveIssues(ids: Iterable<string>, projectId: string): number {
    const first = issueMoves(this.pool, ids, projectId);
    this.enqueueAll({ first, last: [] });
    return first.length;
  }

  createIssue(projectId: string, set: IssuePatch & { title: string; stateId: string }, doc?: DocJSON | null): Issue {
    const id = uuidv7();
    // One transaction: the issue never exists on the server without the description it was created with.
    this.enqueue([{ op: "create", m: "Issue", id, projectId, set }, ...(doc ? [{ op: "update" as const, m: "Document" as const, id, set: { doc } }] : [])]);
    return this.pool.maps.Issue.get(id)!;
  }

  // ── Relations and links ─────────────────────────────────────────────────────────────────────────────────────

  addRelation(issueId: string, type: RelationType | null, otherId: string): void {
    this.enqueue(relationChange(this.pool, issueId, type, otherId));
  }

  removeRelation(issueId: string, otherId: string): void {
    this.addRelation(issueId, null, otherId);
  }

  addLink(issueId: string, url: string, title = ""): Attachment | null {
    const clean = cleanUrl(url);
    if (!clean || !this.pool.maps.Issue.get(issueId)) return null;
    const id = uuidv7();
    this.enqueue([{ op: "create", m: "Attachment", id, set: { issueId, url: clean, title: cleanName(title) } }]);
    return this.pool.maps.Attachment.get(id)!;
  }

  updateLink(id: string, patch: { url?: string; title?: string }): void {
    this.enqueue(linkUpdate(this.pool, id, patch));
  }

  removeLink(id: string): void {
    if (this.pool.get("Attachment", id)) this.enqueue([{ op: "delete", m: "Attachment", id }]);
  }

  /** Size and type of files this client uploaded, for the rows it adds before the server answers (PLNR-50). */
  private readonly uploaded = new Map<string, { size: number; mime: string }>();

  /** A file on an issue, once its bytes are uploaded (PUT /files): the server takes its size and type from the upload. */
  addFile(issueId: string, file: { sha256: string; size: number; mime: string }, name: string): Attachment | null {
    const title = cleanName(name) || "file";
    if (!this.pool.maps.Issue.get(issueId)) return null;
    this.uploaded.set(file.sha256, { size: file.size, mime: file.mime });
    const id = uuidv7();
    this.enqueue([{ op: "create", m: "Attachment", id, set: { issueId, sha256: file.sha256, title } }]);
    return this.pool.maps.Attachment.get(id)!;
  }

  description(issueId: string): Document | undefined {
    return this.pool.maps.Document.get(issueId);
  }

  updateDescription(issueId: string, doc: DocJSON, seen?: string | null): void {
    const row = this.pool.maps.Document.get(issueId);
    if (JSON.stringify(row?.doc ?? null) === JSON.stringify(doc)) return;
    const isSave = (o: Op) => o.m === "Document" && o.id === issueId;
    const last = this.pending.findLast((t) => t.ops.some(isSave));
    // Saves that never left replace each other: offline a text is saved every few seconds, and only the last one is wanted.
    // Under a new id: another tab may have read the old one from the disk, and a repeat of an id is not applied again.
    if (last && !last.sent && last.ops.length === 1 && !this.wire.live) {
      const op = { ...last.ops[0]!, set: { doc } } as Op;
      const next: PendingTx = { ...last, id: uuidv7(), ops: [op] };
      this.pending[this.pending.indexOf(last)] = next;
      this.unstored.delete(last.id);
      if (this.db) this.db.delTx(last.id).catch(warn);
      runInAction(() => this.applyOp(op, next.at ?? new Date().toISOString()));
      if (tooBig(next)) return this.refuse(next, "too_large", "this change is too large to save");
      return this.keep(next);
    }
    // On top of a save of ours still on its way; otherwise on the text the editor had, or the one here.
    const base = last ? last.id : seen !== undefined ? seen : row?.tx;
    this.enqueue([{ op: "update", m: "Document", id: issueId, set: { doc }, ...(base === undefined ? {} : { base }) }]);
  }

  clearRejection(): void {
    runInAction(() => (this.lastRejection = null));
  }

  // ── Settings ────────────────────────────────────────────────────────────────────────────────────────────────

  updateWorkspace(patch: WorkspacePatch): void {
    this.enqueue(workspaceUpdate(this.workspace, patch));
  }

  setMemberRole(userId: string, role: AssignableRole): void {
    const u = this.pool.get("User", userId);
    if (u && u.role && u.role !== role) this.enqueue([{ op: "update", m: "User", id: userId, set: { role } }]);
  }

  removeMember(userId: string): void {
    if (this.pool.get("User", userId)?.role) this.enqueue([{ op: "delete", m: "User", id: userId }]);
  }

  moveProject(id: string, index: number): void {
    const shown = this.projectList().map((p) => p.id);
    const at = shown.indexOf(id);
    if (at < 0) return;
    const others = shown.filter((p) => p !== id);
    const next = others[Math.max(0, index)];
    if (next !== shown[at + 1]) this.views.setProjectOrder(movedOrder(this.views.projectOrder, shown, id, next));
  }

  createProject(set: ProjectCreate): Project {
    const id = uuidv7();
    const name = cleanName(set.name);
    // With its states, in one transaction: the server refuses a project without them, and an issue can be added
    // to it at once, offline too.
    this.enqueue(newProjectOps(id, { ...set, name }, uuidv7));
    return this.pool.maps.Project.get(id)!;
  }

  updateProject(id: string, patch: ProjectPatch): void {
    this.enqueue(rowUpdate(this.pool, "Project", id, patch));
  }

  createState(projectId: string, name: string, group: StateGroup): WorkflowState {
    const id = uuidv7();
    this.enqueue(stateCreate(this.pool, id, projectId, name, group));
    return this.pool.maps.WorkflowState.get(id)!;
  }

  updateState(id: string, patch: StatePatch): void {
    this.enqueue(stateUpdate(this.pool, id, patch));
  }

  deleteState(id: string, moveTo: string): void {
    this.enqueueAll(stateDelete(this.pool, id, moveTo));
  }

  createLabel(projectId: string, name: string, color: string): Label {
    const id = uuidv7();
    this.enqueue(labelCreate(this.pool, id, projectId, name, color));
    return this.pool.maps.Label.get(id)!;
  }

  updateLabel(id: string, patch: LabelPatch): void {
    this.enqueue(rowUpdate(this.pool, "Label", id, patch));
  }

  deleteLabel(id: string): void {
    this.enqueueAll(labelDelete(this.pool, id));
  }

  // ── Cycles (PLNR-63) ────────────────────────────────────────────────────────────────────────────────────────

  createCycle(projectId: string, set: Omit<CyclePatch, "completedAt"> & { name: string }): Cycle {
    const id = uuidv7();
    this.enqueue([{ op: "create", m: "Cycle", id, set: { projectId, ...set } }]);
    return this.pool.maps.Cycle.get(id)!;
  }

  updateCycle(id: string, patch: Omit<CyclePatch, "completedAt">): void {
    this.enqueue(rowUpdate(this.pool, "Cycle", id, patch));
  }

  completeCycle(id: string, moveTo: string | null, keep: readonly string[]): void {
    this.enqueueAll(cycleComplete(this.pool, id, moveTo, keep));
  }

  deleteCycle(id: string): void {
    this.enqueueAll(cycleDelete(this.pool, id));
  }

  // ── Comments, reactions, history ────────────────────────────────────────────────────────────────────────────

  feed(issueId: string): Feed {
    return this.feeds.feed(issueId);
  }

  projectHistory(projectId: string, level: HistoryLevel): ProjectFeed {
    return this.feeds.projectHistory(projectId, level);
  }

  addComment(issueId: string, body: string, parentId?: string | null): Comment {
    const id = uuidv7();
    this.enqueue([{ op: "create", m: "Comment", id, set: { issueId, body, ...(parentId ? { parentId } : {}) } }]);
    return this.pool.maps.Comment.get(id)!;
  }

  editComment(id: string, body: string): void {
    const c = this.pool.maps.Comment.get(id);
    if (c && !c.deletedAt && c.body !== body) this.enqueue([{ op: "update", m: "Comment", id, set: { body } }]);
  }

  deleteComment(id: string): void {
    const c = this.pool.maps.Comment.get(id);
    if (c && !c.deletedAt) this.enqueue([{ op: "delete", m: "Comment", id }]);
  }

  toggleReaction(issueId: string, commentId: string | null, emoji: string): void {
    this.enqueue(reactionToggle(this.pool, this.meId, issueId, commentId, emoji));
  }

  /** A request to the server, with the engine's abort signal. */
  fetch(path: string, init?: RequestInit): Promise<Response> {
    return this.http(`${this.base}${path}`, { ...init, signal: this.abort.signal });
  }

  /** A full copy on a live connection: what changes from now on arrives as deltas. */
  get linked(): boolean {
    return this.based && this.wire.live;
  }

  ended(): void {
    this.stop("unauthorized", "the session has ended");
  }

  /** Saves the copy now, not after the debounce. */
  persistNow(): Promise<void> {
    this.dirty = true;
    return this.persist();
  }

  setConnection(c: ConnectionStatus): void {
    runInAction(() => (this.connection = c));
  }

  // ── Optimistic changes ──────────────────────────────────────────────────────────────────────────────────────

  /** `first` in as many transactions as it takes, `last` with the end of it: a big move stays under the server's limit. */
  private enqueueAll(ops: SplitOps | null): void {
    if (ops) for (const tx of txChunks(ops, TX_OPS)) this.enqueue(tx);
  }

  /** One transaction of `raw`; none of nothing (a write that changes nothing). */
  private enqueue(raw: Op[]): void {
    if (!raw.length) return;
    const ops = raw.map((op) => withBase(this.pool, op));
    const tx: PendingTx = { id: uuidv7(), n: ++this.seq, ops, at: new Date().toISOString(), ...(this.meId ? { by: this.meId } : {}) };
    runInAction(() => {
      for (const op of ops) this.applyOp(op, tx.at!);
      this.pending.push(tx);
      this.track(tx, 1);
    });
    this.watchStall();
    if (tooBig(tx)) return this.refuse(tx, "too_large", "this change is too large to save");
    this.keep(tx);
    if (this.sending) this.sendTx(tx);
  }

  /** The queue on disk: if it fails, the change lives only in this tab, and the user has to know. */
  private keep(tx: PendingTx): void {
    const inMemory = () => {
      this.unstored.add(tx.id);
      this.markUnsafe();
    };
    if (!this.db) return this.disks ? inMemory() : undefined;
    this.db.putTx(tx.id, stored(tx)).then(
      () => {
        this.unstored.delete(tx.id);
        this.markUnsafe();
      },
      (e: unknown) => {
        warn(e);
        // Gone meanwhile (confirmed, or replaced by a newer save): it needs no place on the disk.
        if (this.pending.includes(tx)) inMemory();
      },
    );
  }

  private markUnsafe(): void {
    const unsafe = this.pending.some((t) => this.unstored.has(t.id));
    if (unsafe !== this.unsafe) runInAction(() => (this.unsafe = unsafe));
  }

  /** The queue may go out now: on a live connection, from a full copy, and not during a wait the server asked for. */
  private get sending(): boolean {
    return this.wire.live && this.based && !this.holdTimer;
  }

  private sendTx(tx: PendingTx): void {
    tx.sent = true;
    if (!this.sentAt.has(tx.id)) this.sentAt.set(tx.id, now());
    this.send({ t: "tx", id: tx.id, ops: tx.ops });
    this.watchAcks();
  }

  /** An answer overdue is the first sign of a dead link while there is something to lose: check it now. */
  private watchAcks(): void {
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined;
      if (!this.pending.some((t) => t.sent && t.s === undefined)) return;
      this.wire.probe();
      this.watchAcks();
    }, this.wire.times.ack);
  }

  /** Keeps `stalled` true to its name: the queue made no progress in `stall` ms. Any confirmation starts the time over. */
  private watchStall(progress = false): void {
    if (progress) {
      clearTimeout(this.stallTimer);
      this.stallTimer = undefined;
      if (this.stalled) runInAction(() => (this.stalled = false));
    }
    if (this.stallTimer || this.disposed || !this.pending.length) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = undefined;
      if (this.pending.length) runInAction(() => (this.stalled = true));
    }, this.wire.times.stall);
  }

  /** Applies a local op to the pool, remembering the server value of every field it overrides. */
  private applyOp(op: Op, at: string): void {
    let row = this.pool.get(op.m, op.id);
    // A description edited before it loaded (or of a new issue): the row starts empty; the server's copy, when it
    // arrives, goes under the pending edit like any server value.
    if (!row && op.m === "Document") {
      this.pool.put("Document", { id: op.id, doc: null, updatedAt: null });
      row = this.pool.get(op.m, op.id);
    }
    if (op.op === "create") {
      if (row) return; // the server already has it (the queue replayed over a newer snapshot)
      this.created.set(op.id, op.m);
      this.pool.put(op.m, this.newRow(op, at));
      return;
    }
    if (isRemoval(op)) {
      if (row) {
        this.removed.set(op.id, { m: op.m, row: { ...row } });
        this.pool.remove(op.m, op.id);
      }
      return;
    }
    if (!row) return;
    const p = this.localPatch(op, at, row)!;
    const key = keyOf(op.m, op.id);
    let sh = this.shadow.get(key);
    if (!sh) this.shadow.set(key, (sh = {}));
    for (const k in p) if (!(k in sh)) sh[k] = row![k];
    this.pool.patch(op.m, row!, p);
  }

  /**
   * What a local op shows on its row. A move to another project (PLNR-448) has no number there until the server's echo
   * ("KEY-?"), and the key it leaves joins its former keys at once, so a link or an open page with it still finds the issue.
   */
  private localPatch(op: Op, at: string, row: Row): Row | null {
    const p = patchOf(op, at);
    if (!p || !movesProject(op) || row.projectId === op.set.projectId) return p;
    const issue = row as unknown as Issue;
    return { ...p, number: 0, formerKeys: issue.number ? [...issue.formerKeys, this.pool.issueKey(issue)] : issue.formerKeys };
  }

  /** The row a create op shows until the server echoes it. */
  private newRow(op: Extract<Op, { op: "create" }>, at: string): Row {
    switch (op.m) {
      case "Issue":
        return {
          id: op.id,
          projectId: op.projectId,
          number: 0,
          ...blankIssueFields(),
          // "" sorts before any fractional index: the new issue shows on top, where the server will put it.
          sortOrder: "",
          createdById: this.meId || null,
          createdAt: at,
          updatedAt: at,
          completedAt: null,
          archivedAt: null,
          deletedAt: null,
          formerKeys: [],
          ...op.set,
        } satisfies Issue;
      case "Comment":
        return { id: op.id, issueId: op.set.issueId, parentId: op.set.parentId ?? null, authorId: this.meId || null, body: op.set.body, createdAt: at, editedAt: null, deletedAt: null, via: null } satisfies Comment;
      case "Attachment": {
        const own = { id: op.id, createdById: this.meId || null, createdAt: at };
        if (!isFileCreate(op.set)) return { ...own, kind: readLink(op.set.url).kind, sha256: null, size: null, mime: null, ...op.set } satisfies Attachment;
        const f = this.uploaded.get(op.set.sha256);
        return { ...own, ...op.set, kind: "file", url: filePath(this.slug, op.set.sha256), size: f?.size ?? null, mime: f?.mime ?? null } satisfies Attachment;
      }
      case "Reaction":
        return { id: op.id, issueId: op.set.issueId, commentId: op.set.commentId ?? null, userId: this.meId, emoji: op.set.emoji, createdAt: at } satisfies Reaction;
      case "Project":
        return { id: op.id, color: null, formerKeys: [], issueCounter: 0, createdAt: at, archivedAt: null, cycleRollover: false, ...op.set } satisfies Project;
      // The color is the server's (by group); the ledger draws a state by its group.
      case "WorkflowState":
        return { id: op.id, color: "", isDefault: false, onlyPeople: false, ...op.set } satisfies WorkflowState;
      case "Label":
        return { id: op.id, parentId: null, onlyPeople: false, ...op.set } satisfies Label;
      // The number is a guess until the server's echo: the next after the project's highest.
      case "Cycle":
        return {
          id: op.id,
          number: Math.max(0, ...this.pool.cyclesOf(op.set.projectId).map((c) => c.number)) + 1,
          description: "",
          startDate: null,
          endDate: null,
          leadId: null,
          createdById: this.meId || null,
          createdAt: at,
          completedAt: null,
          summary: null,
          ...op.set,
        } satisfies Cycle;
    }
  }

  /** Re-applies pending changes of one row on top of the server values just written. */
  private rebase(m: AnyModel, id: string): void {
    if (!this.pendingById.has(keyOf(m, id))) return;
    for (const tx of this.pending) {
      for (const op of tx.ops) {
        if (op.id !== id || op.m !== m) continue;
        const row = this.pool.get(op.m, id);
        if (!row) continue;
        if (isRemoval(op)) {
          this.removed.set(id, { m: op.m, row: { ...row } });
          this.pool.remove(op.m, id);
          continue;
        }
        const p = this.localPatch(op, tx.at ?? "", row);
        if (p) this.pool.patch(op.m, row, p);
      }
    }
  }

  /**
   * After a fresh snapshot: the shadow refers to the old pool, so rebuild it by replaying the queue. Comments and
   * reactions survive a snapshot, so their local values are taken off first and replayed like the rest.
   */
  private replayPending(): void {
    for (const [key, sh] of this.shadow) {
      const doc = key.startsWith("doc:");
      for (const m of doc ? (["Document"] as const) : (["Comment", "Reaction"] as const)) {
        const row = this.pool.get(m, doc ? key.slice(4) : key);
        if (row) this.pool.patch(m, row, sh);
      }
    }
    this.shadow.clear();
    for (const [id, m] of this.created) if ((MODELS as readonly string[]).includes(m)) this.created.delete(id);
    for (const [id, r] of this.removed) if ((MODELS as readonly string[]).includes(r.m)) this.removed.delete(id);
    for (const tx of this.pending) for (const op of tx.ops) this.applyOp(op, tx.at ?? new Date().toISOString());
  }

  private track(tx: PendingTx, by: 1 | -1): void {
    this.pendingCount += by;
    for (const op of tx.ops) {
      const key = keyOf(op.m, op.id);
      const n = (this.pendingById.get(key) ?? 0) + by;
      if (n > 0) this.pendingById.set(key, n);
      else this.pendingById.delete(key);
    }
  }

  /**
   * Drops a transaction (acked and applied, or rejected). Its fields go back to the server value and the remaining
   * pending patches are re-applied on top. For a rejection that is the revert; for an ack it picks up a value the
   * server normalised (a trimmed title) instead of keeping the local one. A created row the server never echoed (a
   * rejection, or a reaction the user already had) goes; a reaction removal the server rejected comes back.
   */
  private removeTx(tx: PendingTx, rejected: boolean): void {
    this.pending = this.pending.filter((t) => t !== tx);
    this.track(tx, -1);
    this.watchStall(true);
    this.unstored.delete(tx.id);
    this.sentAt.delete(tx.id);
    this.markUnsafe();
    if (this.db) this.db.delTx(tx.id).catch(warn);
    for (const op of tx.ops) {
      if (op.op === "create") {
        if (this.created.has(op.id)) {
          this.pool.remove(op.m, op.id);
          this.created.delete(op.id);
          this.shadow.delete(op.id);
          // A rejected new issue takes the description it was created with.
          if (op.m === "Issue" && rejected && !this.pending.some((t) => t.ops.some((o) => o.m === "Document" && o.id === op.id))) {
            this.pool.remove("Document", op.id);
            this.shadow.delete(keyOf("Document", op.id));
          }
        }
        continue;
      }
      if (isRemoval(op)) {
        const saved = this.removed.get(op.id);
        this.removed.delete(op.id);
        if (rejected && saved) this.pool.put(op.m, saved.row);
        continue;
      }
      const row = this.pool.get(op.m, op.id);
      const key = keyOf(op.m, op.id);
      const sh = this.shadow.get(key);
      if (!row || !sh) continue;
      const p = touchedBy(op, tx.at ?? "")!;
      const back: Row = {};
      for (const k in p) if (k in sh) back[k] = sh[k];
      this.pool.patch(op.m, row, back);
      this.rebase(op.m, op.id);
      // Fields no other pending transaction touches belong to the server again.
      for (const k in p) {
        if (!this.pending.some((t) => t.ops.some((o) => o.id === op.id && o.m === op.m && k in (touchedBy(o, "") ?? {})))) delete sh[k];
      }
      if (Object.keys(sh).length === 0) this.shadow.delete(key);
    }
  }

  /** Drops acknowledged transactions whose log number has been applied. */
  private settle(): void {
    for (const tx of this.pending.slice()) if (tx.s !== undefined && tx.s <= this.lastSyncId) this.removeTx(tx, false);
  }

  private onAck(id: string, s: number): void {
    const tx = this.pending.find((t) => t.id === id);
    if (!tx) return;
    tx.s = s;
    const sent = this.sentAt.get(id);
    if (sent !== undefined) this.wire.note({ saveMs: Math.round(now() - sent) });
    // The ack can overtake the delta carrying the transaction: keep it pending until that number is applied.
    if (s <= this.lastSyncId) runInAction(() => this.removeTx(tx, false));
  }

  private onReject(id: string, code: string, message: string, wait?: number): void {
    // About now, not about the change: reverting would lose it. Before, a queue sent after a long time offline could hit
    // the write budget, and every change past it was rolled back.
    if (TRANSIENT_REFUSALS.has(code)) return this.holdOff(wait);
    const tx = this.pending.find((t) => t.id === id);
    if (tx) this.refuse(tx, code, message);
  }

  /** Stops sending for the time the server asked for, then sends everything unconfirmed again, in order. */
  private holdOff(wait = REFUSED_WAIT_MS): void {
    // The longest wait of those asked for: refusals of what was behind the first one come with shorter ones.
    const until = Date.now() + wait;
    if (this.holdTimer && until <= this.holdUntil) return;
    this.holdUntil = until;
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined;
      if (this.sending) this.sendQueue();
    }, wait);
  }

  /** The change is off: its effect goes, what the user typed stays with the refusal. */
  private refuse(tx: PendingTx, code: string, message: string): void {
    runInAction(() => {
      // Before the revert takes the row. Its feed may not be open, after a reload or for an issue left meanwhile.
      const refused = this.refusedComment(tx, message);
      const lost = this.lostWork(tx);
      this.removeTx(tx, true);
      this.passOnBase(tx);
      if (refused) this.feed(refused.issueId).notSent.push(refused);
      const was = this.lastRejection;
      this.lastRejection = { code, message, count: (was?.count ?? 0) + 1, lost: [...(was?.lost ?? []), ...(lost ? [lost] : [])] };
    });
  }

  /** A save built on a refused one stands on what that one stood on: the refused text never existed on the server. */
  private passOnBase(tx: PendingTx): void {
    const save = tx.ops.find((o): o is Extract<Op, { m: "Document" }> => o.m === "Document");
    if (!save) return;
    for (const t of this.pending) {
      const op = t.ops.find((o): o is Extract<Op, { m: "Document" }> => o.m === "Document" && o.id === save.id);
      if (op?.base !== tx.id || t.sent) continue;
      if (save.base === undefined) delete op.base;
      else op.base = save.base;
      this.keep(t);
    }
  }

  /** What a refusal would take with it that the user cannot get back: words they wrote. */
  private lostWork(tx: PendingTx): LostWork | null {
    const created = tx.ops.find((o): o is Extract<Op, { op: "create"; m: "Issue" }> => o.op === "create" && o.m === "Issue");
    const saved = tx.ops.find((o): o is Extract<Op, { m: "Document" }> => o.m === "Document");
    const renamed = tx.ops.find((o): o is Extract<Op, { op: "update"; m: "Issue" }> => o.op === "update" && o.m === "Issue" && o.set.title !== undefined);
    const edited = tx.ops.find((o): o is Extract<Op, { op: "update"; m: "Comment" }> => o.op === "update" && o.m === "Comment");
    const text = created?.set.title ?? renamed?.set.title ?? edited?.set.body ?? null;
    return text === null && !saved ? null : { text, doc: saved?.set.doc ?? null };
  }

  /**
   * A refused new comment, to keep with the reason: the composer has already let go of the text. As it stands now, with
   * edits made while it waited; one deleted meanwhile is gone for good.
   */
  private refusedComment(tx: PendingTx, reason: string): NotSentComment | null {
    const op = tx.ops.find((o) => o.op === "create" && o.m === "Comment");
    const row = op && this.pool.maps.Comment.get(op.id);
    return row && !row.deletedAt ? { id: row.id, issueId: row.issueId, parentId: row.parentId, body: row.body, at: row.createdAt, reason } : null;
  }

  // ── Log ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private onDelta(actions: Action[]): void {
    // While a snapshot loads, deltas are dropped: `sub` after it asks for everything past the snapshot's number.
    if (!this.based || !actions.length) return;
    if (actions[0]!.id > this.lastSyncId + 1) {
      // A missed frame: ask again from what we have. Further gapped frames wait for the answer instead of re-asking.
      this.caughtUp = false;
      this.resubscribe();
      return;
    }
    this.resubbing = false;
    let replaced = false;
    // Up to the server's caught-up the frames are the copy catching up, not changes happening now.
    const others = this.onOthersChange && this.caughtUp ? new Set<string>() : null;
    try {
      runInAction(() => {
        for (const a of actions) {
          if (a.id <= this.lastSyncId) continue; // overlap between catch-up and live frames
          if (a.a === "R") {
            replaced = true;
            break;
          }
          if (others && othersIssue(a, this.meId)) others.add(a.mid);
          // The inbox compares assignees with the server's values before the action, not with a pending local edit.
          const before = a.m === "Issue" && a.a === "U" ? { ...this.pool.get("Issue", a.mid), ...this.shadow.get(a.mid) } : undefined;
          const prev = before?.assigneeIds as string[] | undefined;
          this.apply(a);
          // And its state before, as the server had it: Done out of a review is not the news Done out of the blue is.
          this.inbox.observe(a, prev, before?.stateId as string | undefined);
          this.lastSyncId = a.id;
        }
        this.settle();
      });
    } catch (e) {
      // An action this code cannot apply. Left alone, every later frame would look like a gap and the copy would freeze
      // while the dot stayed green: a snapshot is past it.
      warn(e);
      replaced = true;
    }
    this.markDirty();
    if (replaced) this.resync();
    else if (others?.size) this.onOthersChange!([...others]);
  }

  private apply(a: Action): void {
    if (a.m === "Workspace") return a.a === "U" && a.mid === this.wsId ? this.applyServer("Workspace", "U", a.mid, a.d ?? {}) : undefined;
    const entry = this.issueEntry(a);
    if (this.feeds.followsProjects) {
      const created = a.m === "Issue" && a.a === "I" ? createdEntry(a) : null;
      this.feeds.takeProject(a, entry ?? created, this.settingDelta(a));
    }
    const issueId = entry || (a.m === "Issue" && a.a === "I") ? a.mid : a.m === "Comment" || a.m === "Reaction" || a.m === "GithubLink" ? (a.d?.issueId as string) : null;
    if (issueId) this.feeds.changed(issueId, a.id);
    if (a.m === "Comment" || a.m === "Reaction" || a.m === "GithubLink") return this.feeds.applyIssueModel(a);
    if (a.m === "Document") {
      // The description moves the issue's updatedAt too (the server sets both in one transaction).
      if (a.d?.updatedAt && this.pool.get("Issue", a.mid)) this.applyServer("Issue", "U", a.mid, { updatedAt: a.d.updatedAt });
      this.feeds.record(a, entry);
      return this.feeds.applyIssueModel(a);
    }
    if (a.m === "Issue") this.feeds.record(a, entry);
    if (a.m === "Issue" && a.a === "D") this.feeds.dropIssue(a.mid);
    // The viewer's own role: what the screens offer follows it (the server has already applied the new role).
    if (a.m === "User" && a.mid === this.meId && a.d && "role" in a.d) this.role = isRole(a.d.role) ? a.d.role : null;
    this.applyServer(a.m, a.a, a.mid, a.d ?? {});
  }

  /** Writes a server change under the pending local ones: the shadow takes the new value, pending patches go on top. */
  applyServer(m: AnyModel, kind: Action["a"], mid: string, data: Row): void {
    if (kind === "D") {
      this.pool.remove(m, mid);
      this.shadow.delete(keyOf(m, mid));
      this.removed.delete(mid);
      this.created.delete(mid);
      return;
    }
    let d = data;
    if (kind === "A" && !("archivedAt" in d)) d = { ...d, archivedAt: new Date().toISOString() };
    if (m === "Document") {
      // issueId routes the action; the row is { id, doc, updatedAt }. An older log action may lack doc (compacted).
      const { issueId: _, mentionIds: _m, ...rest } = d;
      d = rest;
    } else if (m === "Comment" && "mentionIds" in d) {
      // Who the action newly mentions is for the inbox (protocol/inbox.ts), not part of the row.
      const { mentionIds: _, ...rest } = d;
      d = rest;
    } else if (m === "Issue" && ("gh" in d || "dropped" in d)) {
      // What GitHub did and the labels a move dropped are for the feed (issueEntry), not part of the row.
      const { gh: _, dropped: _d, ...rest } = d;
      d = rest;
    }
    const sh = this.shadow.get(keyOf(m, mid));
    if (sh) for (const k in d) if (k in sh) sh[k] = d[k];
    const saved = this.removed.get(mid);
    if (saved) {
      Object.assign(saved.row, d); // removed here, pending: the server copy stays current in case the removal fails
      return;
    }
    if (kind === "I") {
      this.pool.put(m, { ...d, id: mid });
      this.created.delete(mid);
    } else {
      const row = this.pool.get(m, mid);
      if (row) this.pool.patch(m, row, d);
    }
    this.rebase(m, mid);
  }

  /**
   * The history entry an issue's change makes: a field change with its before-values (the server values it replaces, so
   * it is read before the pool changes), a description save that says only that, or what GitHub did, with or without a
   * change it caused; null for anything else.
   */
  private issueEntry(a: Action): HistoryEntry | null {
    const { gh } = githubOf(a.d);
    // A catch-up read must not date an old event now: what GitHub did says when, even with no field changed.
    const at = (a.d?.updatedAt as string | undefined) ?? gh?.at ?? new Date().toISOString();
    const via = a.via ? { via: a.via } : {};
    if (a.m === "Document") return { ...descriptionEntry(a.id, a.by ?? null, at), ...via };
    if (a.m !== "Issue" || (a.a !== "U" && a.a !== "A")) return null;
    const d = historyFields(a.d);
    if (a.a === "U" && Object.keys(d).length === 0 && !gh) return null;
    const was = this.before("Issue", a.mid);
    const p: Row = {};
    for (const k in d) p[k] = was(k);
    return { id: a.id, a: a.a, by: a.by ?? null, at, d, p, ...githubOf(a.d), ...via, ...movedFrom(a.d) };
  }

  /**
   * A row's server values as they are before an action changes them: the shadow's for a field a pending local change
   * covers, the row's otherwise, null for a field it lacks.
   */
  private before(m: AnyModel, id: string): (k: string) => unknown {
    const row = this.pool.get(m, id);
    const sh = this.shadow.get(keyOf(m, id));
    return (k) => (sh && k in sh ? sh[k] : (row?.[k] ?? null));
  }

  /** A state's or label's change for a project's history, read before the pool takes it: the name it had comes from the row. */
  private settingDelta(a: Action): SettingDelta | null {
    if (a.m !== "Label" && a.m !== "WorkflowState") return null;
    const row = this.pool.get(a.m, a.mid);
    const was = this.before(a.m, a.mid);
    const projectId = ((a.d?.projectId as string | null | undefined) ?? (row?.projectId as string | null | undefined) ?? null);
    const base = { id: a.id, m: a.m, mid: a.mid, by: a.by ?? null, at: new Date().toISOString() };
    if (a.a === "I") return { projectId, entry: { ...base, a: "I", d: settingFields(a.d), p: {} } };
    if (a.a === "D") return { projectId, entry: { ...base, a: "D", d: {}, p: row ? { name: was("name") } : {} } };
    if (a.a !== "U") return null;
    const d = settingFields(a.d);
    if (!Object.keys(d).length) return null;
    const p: Row = {};
    for (const k in d) p[k] = was(k);
    return { projectId, entry: { ...base, a: "U", d, p } };
  }

  // ── Snapshot ────────────────────────────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.disks) {
      try {
        this.db = await this.disks.open(copyName(this.slug));
        // Disposed while the database was opening (a quick switch to another workspace): close what dispose() missed.
        if (this.disposed) {
          this.db.close();
          this.db = null;
          return;
        }
        await this.load();
      } catch (e) {
        // Private mode or a broken database: work from the network. A copy that broke halfway must not mix with the snapshot.
        warn(e);
        this.db = null;
        for (const tx of this.pending) this.unstored.add(tx.id);
        runInAction(() => {
          this.pool.clear();
          this.based = false;
          this.lastSyncId = 0;
        });
        this.markUnsafe();
      }
    }
    const g = globalThis as unknown as Listens;
    g.addEventListener?.("pagehide", this.onHide);
    g.addEventListener?.("beforeunload", this.onLeave);
    g.addEventListener?.("online", this.onWake);
    g.addEventListener?.("offline", this.onOffline);
    g.addEventListener?.("focus", this.onWake);
    g.addEventListener?.("pageshow", this.onWake);
    (g.document as Listens | undefined)?.addEventListener?.("visibilitychange", this.onWake);
    // The socket opens alongside the snapshot request: `sub` goes out as soon as the snapshot is in.
    this.wire.connect();
    if (!this.based) await this.snapshot(true);
  }

  private async load(): Promise<void> {
    const t0 = now();
    const db = this.db!;
    const [saved, txs] = await Promise.all([db.loadSnapshot<Saved>(), db.pendingTxs<PendingTx>()]);
    runInAction(() => {
      // By time, then by number: `n` counts per tab, and the queue is shared by the tabs of a browser.
      this.pending = txs.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "") || a.n - b.n);
      this.seq = Math.max(0, ...this.pending.map((t) => t.n));
      // Whether they went out before this tab is unknown: they count as sent, and their content stays as it is.
      for (const tx of this.pending) tx.sent = true;
      for (const tx of this.pending) this.track(tx, 1);
      if (!saved || saved.v !== PROTOCOL_VERSION) return;
      for (const b of saved.b) this.pool.putBatch(b.m, b.c, b.r);
      this.putWorkspace(saved.ws);
      this.meId = saved.me;
      this.role = saved.role ?? null;
      this.lastSyncId = saved.s;
      if (saved.ib) this.inbox.load(saved.ib);
      if (saved.vw) this.views.load(saved.vw);
      if (saved.fs) this.feeds.restore(saved.fs);
      this.based = true;
      this.replayPending();
      this.ready();
    });
    this.watchStall();
    this.stats.loadMs = now() - t0;
  }

  /**
   * Downloads a snapshot. `incremental` (cold start) applies batches as they arrive; otherwise (resync) the old pool
   * stays on screen until the new snapshot is complete and then is swapped in one action.
   */
  private async snapshot(incremental: boolean): Promise<void> {
    if (this.fetching) return;
    this.fetching = true;
    this.based = false;
    this.caughtUp = false; // deltas are dropped until `sub` after the snapshot
    const t0 = now();
    let parse = 0;
    let apply = 0;
    let rows = 0;
    let meta: SnapshotMeta | null = null;
    let ended = false;
    const staged: SnapshotLine[] = [];
    try {
      const q = new URLSearchParams({ ws: this.slug });
      if (this.project) q.set("project", this.project);
      const res = await this.fetch(`/sync/bootstrap?${q}`);
      if (!res.ok || !res.body) {
        const code = deniedBy(res.status);
        if (code) throw Object.assign(new Error(code === "not_found" ? `Workspace "${this.slug}" not found` : `HTTP ${res.status}`), { code });
        throw new Error(`Snapshot request failed: HTTP ${res.status}`);
      }
      // Who the snapshot is for comes in headers: the body is the same for every member (protocol version 5).
      const me = res.headers.get(VIEWER_HEADERS.me) ?? "";
      // A resync keeps the queue: under someone else's credential it would become theirs, and go with their next socket.
      if (this.otherPerson(me)) throw Object.assign(new Error(OTHER_PERSON), { code: "unauthorized" });
      const role = res.headers.get(VIEWER_HEADERS.role);
      runInAction(() => ((this.meId = me), (this.role = isRole(role) ? role : null)));
      const settings = settingsFrom((name) => res.headers.get(name));
      if (settings) this.onAccount?.(settings);
      for await (const text of lines(res.body)) {
        let t = now();
        const l = JSON.parse(text) as SnapshotLine;
        parse += now() - t;
        if (l.t === "meta") {
          if (l.v !== PROTOCOL_VERSION) return this.reload();
          meta = l;
        } else if (l.t === "b") rows += l.r.length;
        else if (l.t === "end") ended = true;
        t = now();
        if (incremental) this.applyLine(l);
        else staged.push(l);
        apply += now() - t;
      }
      if (!meta || !ended) throw new Error("Snapshot ended early");
      const m = meta;
      const t = now();
      runInAction(() => {
        if (!incremental) {
          this.pool.clear();
          for (const l of staged) this.applyLine(l);
        }
        this.putWorkspace(m.ws);
        this.lastSyncId = m.s;
        this.based = true;
        // Replay first: it rebuilds the shadows from the new rows, so settling an acked edit restores the snapshot's
        // value; settled first, it would patch the new row with the value from before the edit.
        this.replayPending();
        this.settle();
        this.ready();
      });
      apply += now() - t;
      Object.assign(this.stats, { snapshotMs: now() - t0, parseMs: parse, applyMs: apply, rows });
      // Deltas before the snapshot's number were skipped: the inbox may lack their events.
      this.inbox.invalidate();
      // Write at once, not after the debounce: a reload right after the first visit should already be warm.
      this.dirty = true;
      void this.persist();
      this.subscribe();
      this.feeds.reload();
    } catch (e) {
      if (this.abort.signal.aborted) return;
      warn(e);
      const code = (e as { code?: ErrorCode }).code;
      // A missing workspace stays missing and an ended session stays ended: retrying would only repeat the answer.
      if (code) return this.stop(code, errorText(e));
      runInAction(() => {
        this.error = errorText(e);
        if (this.status === "loading") this.status = "error";
      });
      if (!this.disposed) this.snapshotTimer = setTimeout(() => this.resync(), this.wire.delay());
    } finally {
      this.fetching = false;
    }
  }

  private applyLine(l: SnapshotLine): void {
    if (l.t === "b") runInAction(() => this.pool.putBatch(l.m, l.c, l.r));
    else if (l.t === "meta") runInAction(() => this.putWorkspace(l.ws));
    else if (l.t === "ready") this.ready();
  }

  /** The server's workspace row; pending edits of it are replayed on top by the caller (replayPending). */
  private putWorkspace(ws: WorkspaceInfo): void {
    this.pool.put("Workspace", { ...ws });
    this.wsId = ws.id;
  }

  /** Also clears the error a failed resync left while the old data stayed on screen. */
  private ready(): void {
    const first = this.status !== "ready";
    runInAction(() => {
      this.status = "ready";
      this.error = null;
    });
    if (first) {
      performance.mark?.("rsva:data");
      this.feeds.scheduleFill();
    }
  }

  private resync(): void {
    void this.snapshot(false);
  }

  // ── Persistence ─────────────────────────────────────────────────────────────────────────────────────────────

  persist(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    // Saves run one after another: a caller awaiting persist() also waits for a save already in flight.
    return (this.saving = this.saving.then(() => this.save()).catch(warn));
  }

  private async save(): Promise<void> {
    const db = this.db;
    if (!db || !this.dirty) return;
    const saved = this.saved();
    if (!saved) return;
    this.dirty = false;
    const t0 = now();
    try {
      await db.saveSnapshot(saved);
    } catch (e) {
      this.dirty = true;
      warn(e);
    }
    this.stats.saveMs = now() - t0;
  }

  /** The copy as the disk keeps it; null until there is a full one. */
  private saved(): Saved | null {
    const ws = this.workspace;
    if (!this.based || !ws) return null;
    const saved: Saved = {
      v: PROTOCOL_VERSION,
      s: this.lastSyncId,
      // The server's values: a pending rename is in the tx store and replays on load.
      ws: { ...ws, ...this.shadow.get(ws.id) } as WorkspaceInfo,
      me: this.meId,
      role: this.role,
      b: this.pool.toBatches(
        (_m, row) => {
          const id = row.id as string;
          if (this.created.has(id)) return null;
          const sh = this.shadow.get(id);
          return sh ? { ...row, ...sh } : row;
        },
        // A removal still pending: the server has the row, so the stored copy keeps it.
        (m) => [...this.removed.values()].filter((r) => r.m === m).map((r) => r.row),
      ),
    };
    const ib = this.inbox.save();
    if (ib) saved.ib = ib;
    const vw = this.views.persisted();
    if (vw) saved.vw = vw;
    const fs = this.feeds.saved();
    if (fs) saved.fs = fs;
    return saved;
  }

  async rewrite(): Promise<void> {
    if (!this.disks) return;
    const saved = this.saved();
    const disk = await this.disks.open(copyName(this.slug));
    try {
      if (saved) await disk.saveSnapshot(saved);
      await Promise.all(this.pending.map((tx) => disk.putTx(tx.id, stored(tx))));
    } finally {
      disk.close();
    }
  }

  markDirty(): void {
    this.dirty = true;
    if (this.db && !this.saveTimer) this.saveTimer = setTimeout(() => void this.persist(), this.persistDelay);
  }

  private readonly onHide = () => void this.persist();

  /** Closing the tab loses only what is not on the disk: the browser asks then, and not otherwise. */
  private readonly onLeave = (e: { preventDefault(): void }) => {
    if (this.unsafe && this.pendingCount > 0) e.preventDefault();
  };

  // ── Socket ──────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The server closed the socket: some codes stop the engine (true), the rest only reconnect. Refused while opening: there
   * is no session. A live socket only lost the session it opened with, and the browser may hold a newer one (a fresh
   * sign-in replaced it, routes.ts): one more socket tells which.
   */
  closedBy(code: number | undefined, wasLive: boolean): boolean {
    if (code === CLOSE_UNAUTHORIZED && !wasLive) this.stop("unauthorized", "the session has ended");
    else if (code === CLOSE_FORBIDDEN) this.stop("forbidden", "no access to this workspace");
    // A warm start asks only the socket: a member removed while the tab was closed learns it here.
    else if (code === CLOSE_NOT_FOUND) this.stop("not_found", `Workspace "${this.slug}" not found`);
    else {
      // The server would not read the frame. Sent again it would close the socket again, for good, with every change
      // behind it waiting. Enqueue checks the size, so this is one from before that check, in the queue on disk.
      const tx = code === CLOSE_TOO_BIG ? this.pending.find(tooBig) : undefined;
      if (tx) this.refuse(tx, "too_large", "this change is too large to save");
      return false;
    }
    return true;
  }

  /** The socket is gone: what this connection was tracking goes with it. */
  down(): void {
    this.sentAt.clear();
    this.caughtUp = false;
    clearTimeout(this.ackTimer);
    clearTimeout(this.holdTimer);
    this.ackTimer = this.holdTimer = undefined;
  }

  private onPong(s: number | undefined): void {
    this.wire.pong();
    if (s === undefined || !this.based) return;
    // Still short of the tail the last pong named, with nothing on its way: a delta never reached this socket. Ask for it.
    const { tail } = this.wire.health;
    if (tail !== null && this.lastSyncId < tail) this.resubscribe();
    this.wire.note({ tail: s });
  }

  private readonly onWake = () => this.wire.wake();

  /** The system says there is no network. It never says so wrongly, only too rarely: nothing to wait for. */
  private readonly onOffline = () => this.wire.lost();

  onFrame(f: ServerFrame): void {
    switch (f.t) {
      case "hello":
        if (f.v !== PROTOCOL_VERSION) return this.reload();
        // Someone else signed in in this browser: this tab's queue and copy are another person's, not to be sent as them.
        if (this.otherPerson(f.u)) return this.stop("unauthorized", OTHER_PERSON);
        if (this.wire.up()) this.onReconnect?.();
        if (this.based) {
          this.subscribe();
          this.feeds.scheduleFill();
        } else this.resync(); // a no-op while the first snapshot is still loading
        return;
      case "d":
        return this.onDelta(f.a);
      case "ack":
        return this.onAck(f.id, f.s);
      case "pong":
        return this.onPong(f.s);
      case "rej":
        // Waiting is not refusing: marks and views stay unconfirmed and go again with the queue.
        if ((f.id === "mark" || f.id === "view") && TRANSIENT_REFUSALS.has(f.code)) return this.holdOff(f.wait);
        if (f.id === "mark") return this.inbox.onRejected();
        if (f.id === "view") return this.views.onRejected();
        return this.onReject(f.id, f.code, f.msg, f.wait);
      case "inbox":
        return this.inbox.onInbox(f);
      case "marks":
        return this.inbox.onMarks(f);
      case "views":
        return this.views.onViews(f);
      case "resync":
        return this.resync();
      case "caught-up":
        this.caughtUp = true;
        return this.feeds.confirm();
    }
  }

  /** Subscribes from the local number and resends unconfirmed transactions; the server dedupes them by id. */
  private subscribe(): void {
    if (!this.wire.live || !this.based) return;
    this.resubbing = false;
    this.send({ t: "sub", ws: this.slug, s: this.lastSyncId });
    this.sendQueue();
  }

  /** Everything unconfirmed, in order; the server tells repeats by their id. */
  private sendQueue(): void {
    for (const tx of this.pending) if (tx.s === undefined) this.sendTx(tx);
    this.inbox.request();
    this.views.request();
  }

  private send(f: ClientFrame): void {
    this.wire.send(f);
  }

  /** Asks for the log again from what is here. Until the answer, further asks wait for it instead of repeating it. */
  private resubscribe(): void {
    if (this.resubbing) return;
    this.resubbing = true;
    this.send({ t: "sub", ws: this.slug, s: this.lastSyncId });
  }

  belongsTo(userId: string): boolean {
    // Without a viewer to compare with, only changes signed with their name: an unsigned one (before PLNR-189) is nobody's.
    return !this.otherPerson(userId) && (this.meId === userId || (this.pending.length > 0 && this.pending.every((t) => t.by === userId)));
  }

  /**
   * The server answers for someone else than the person this engine's copy or queue belongs to. A server that names nobody
   * counts as someone else; only a fresh engine with nothing queued has nobody to compare with.
   */
  private otherPerson(id: string): boolean {
    return (!!this.meId && id !== this.meId) || this.pending.some((t) => t.by !== undefined && t.by !== id);
  }

  /**
   * A permanent refusal: no more snapshot requests or reconnects. After a sign-out (unauthorized) the local data and the
   * queue of unsent changes stay in IndexedDB, so signing in again as the same person picks up where this left off; when
   * the workspace is no longer the viewer's (forbidden, not_found) its copy is deleted.
   */
  private stop(code: ErrorCode, message: string): void {
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = undefined;
    this.wire.close();
    const gone = code === "forbidden" || code === "not_found";
    runInAction(() => {
      this.error = message;
      this.errorCode = code;
      this.status = "error";
      this.connection = "offline";
      // They cannot be sent, and they go with the copy: at least nobody thinks they were saved.
      if (gone && this.pendingCount > 0) {
        const lost = this.pending.flatMap((t) => this.lostWork(t) ?? []);
        this.lastRejection = { code, message: `${this.pendingCount} unsent changes could not be saved: ${message}`, count: this.pendingCount, lost };
        for (const tx of this.pending.slice()) this.removeTx(tx, true);
      }
    });
    // No access any more (removed, left, or the workspace is gone): its copy on this device goes too, with the queue.
    if (gone && this.disks) {
      this.db?.close();
      this.db = null;
      // A copy that cannot be removed stays; the next start of this workspace finds it gone on the server again.
      void Promise.resolve(this.disks.remove(copyName(this.slug))).catch(() => undefined);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    clearTimeout(this.saveTimer);
    clearTimeout(this.snapshotTimer);
    this.feeds.dispose();
    clearTimeout(this.stallTimer);
    this.inbox.dispose();
    const g = globalThis as unknown as Listens;
    g.removeEventListener?.("pagehide", this.onHide);
    g.removeEventListener?.("beforeunload", this.onLeave);
    g.removeEventListener?.("online", this.onWake);
    g.removeEventListener?.("offline", this.onOffline);
    g.removeEventListener?.("focus", this.onWake);
    g.removeEventListener?.("pageshow", this.onWake);
    (g.document as Listens | undefined)?.removeEventListener?.("visibilitychange", this.onWake);
    this.wire.close();
    this.db?.close();
    this.db = null;
  }
}
