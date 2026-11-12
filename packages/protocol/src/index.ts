// Sync protocol: snapshot over HTTP and WebSocket frames. Full description: docs/plan.html, "Sync protocol".
// Keys are short because frames travel on every click and every delta.
import type {
  AttachmentCreate,
  AttachmentPatch,
  CycleCreate,
  CyclePatch,
  DocJSON,
  Equal,
  IssueModelName,
  IssuePatch,
  IssueUpdate,
  LabelCreate,
  LabelPatch,
  ModelName,
  ProjectCreate,
  ProjectPatch,
  StateCreate,
  StatePatch,
  AssignableRole,
  WorkspaceInfo,
  WorkspacePatch,
} from "@rsva/schema/models";
import type { InboxFrame, InboxRequestFrame, MarkFrame, MarksFrame } from "./inbox.ts";
import type { ViewsFrame, ViewsRequestFrame, ViewWriteFrame } from "./views.ts";

export * from "./account.ts";
export * from "./api.ts";
export * from "./cycles.ts";
export * from "./github.ts";
export * from "./history.ts";
export * from "./inbox.ts";
export * from "./notify.ts";
export * from "./project-history.ts";
export * from "./setting-ops.ts";
export * from "./views.ts";

/**
 * Bumped on incompatible frame changes. A client on an older version reloads the shell.
 * 3: Comment and Reaction actions in deltas (an older client would put them into its snapshot pool).
 * 4: Document actions in deltas and the description in the issue's history answer (GET /sync/doc is gone).
 * 5: Project `color` and `formerKeys` columns (a local copy without them would never get them: it is dropped).
 * 6: the viewer comes in the snapshot answer's headers (VIEWER_HEADERS), not in its meta line: one cached body serves
 *    every member.
 * 7: User rows carry the member's `role`; User actions in deltas (a member joins, changes role, leaves).
 * The inbox frames (PLNR-26) needed no bump: a server sends them only to a client that asks, and an older shell never does.
 * 8: Issue `deletedAt` (an older client would keep showing deleted issues).
 * 9: Issue relations (`blockedByIds`, `relatedIds`, `duplicateOfId`) and the Attachment model (links).
 * A mark's subscription (PLNR-28) needed no bump: its fields are optional, and the server keeps them when an older shell
 * writes a mark without them.
 * 10: Attachment `sha256`, `size` and `mime` columns: files on issues (PLNR-50).
 * The views frames (PLNR-74) needed no bump, as the inbox's: a server sends them only to a client that asks.
 * 11: the Cycle model and Issue `cycleId` (PLNR-63): a local copy without them would never learn its cycles.
 * 12: GithubLink actions in deltas, `github` in the history answer, `gh` in Issue actions (PLNR-96).
 * 13: `ping` and `base` in ops (PLNR-134). A server before them closes on the first and refuses every op with the second, so
 *     a tab left open over a rollback must reload; so must a tab from before, which would be stuck behind a rate limit.
 * 14: WorkflowState and Label `onlyPeople`, the workspace's `memberRights` (ADR 0037): a local copy without them would
 *     never learn which states only people set or what members may change.
 * 15: Project `cycleRollover` (PLNR-64): a local copy is saved with the columns of the snapshot it was cut from
 *     (pool.ts), so one from before would drop the switch on its next save after it was turned on.
 * 16: Issue `formerKeys` and moves between projects (PLNR-448): an older client would neither find a moved issue by its
 *     old key nor send the move, and its saved copy would drop the keys.
 * 17: the workspace's `triagers` (who triages): a local copy without them would take every owner and admin for one.
 */
export const PROTOCOL_VERSION = 17;

/**
 * WebSocket close codes: the session ended (sign in again), the viewer may not open the workspace, or there is no such
 * workspace for them (not a member: it answers like a missing one). The last two are final: the client stops and drops
 * its copy of the workspace.
 */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_NOT_FOUND = 4404;
/**
 * Not final: the client reconnects after its backoff and sends its pending transactions again. The reader's budget is
 * spent (too many subscribes), or the database is unavailable past the write pipeline's retries.
 */
export const CLOSE_TRY_AGAIN = 1013;
/** What `ws` closes with on a frame over MAX_FRAME_BYTES: the first unconfirmed transaction is what it could not take. */
export const CLOSE_TOO_BIG = 1009;

/** The largest WebSocket frame the server reads; a larger one is refused before it is parsed. The client checks first. */
export const MAX_FRAME_BYTES = 2 ** 20;

// ── Snapshot: GET /sync/bootstrap?ws=<slug>&project=<KEY>, NDJSON ──────────────────────────────────────────

/** First line of the snapshot. */
export interface SnapshotMeta {
  t: "meta";
  v: number;
  /** Log number the snapshot was cut at. The client receives deltas after it over WebSocket. */
  s: number;
  /** `color` is missing in a local copy saved before it existed (the engine reads it as null). */
  ws: WorkspaceInfo;
}

/**
 * Rows of one model by columns: field names once, then values only. A third smaller raw than objects with repeated
 * keys; after brotli the two are within 2% (docs/research/snapshot-2026-10-27.md).
 */
export interface SnapshotBatch {
  t: "b";
  m: ModelName;
  c: string[];
  r: unknown[][];
}

/** The open screen's data has arrived: draw now, the rest keeps loading. */
export interface SnapshotReady {
  t: "ready";
}

export interface SnapshotEnd {
  t: "end";
}

export type SnapshotLine = SnapshotMeta | SnapshotBatch | SnapshotReady | SnapshotEnd;

// ── Log ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Log action: I insert, U update (changed fields only), A archive, D delete,
 * R the workspace data was replaced (import): the client needs a new snapshot.
 * Comment, Reaction, Document and GithubLink actions always carry `d.issueId`, a D one too. A Document action's `d.doc` is
 * the whole new description; in the stored log only a document's latest action keeps it (older ones keep `issueId`,
 * `updatedAt`). An Issue U action may carry `d.gh`, what GitHub did (GithubEvent), which is no field of the row.
 */
export interface Action {
  id: number;
  m: ModelName | IssueModelName | "Workspace";
  mid: string;
  a: "I" | "U" | "A" | "D" | "R";
  d?: Record<string, unknown>;
  /** Who made the change (user id); absent for imports. Live history entries show it without asking the server. */
  by?: string;
  /** Where it was made when not in the app or the API (PLNR-369); absent otherwise. */
  via?: Via;
}

/** A change made outside the app and the API: in the Telegram bot's chat, or by replying to an email (PLNR-369). */
export type Via = "telegram" | "email";

// ── Client transactions ─────────────────────────────────────────────────────────────────────────────────────

export type CommentCreate = { issueId: string; parentId?: string | null; body: string };
export type ReactionCreate = { issueId: string; commentId?: string | null; emoji: string };

/**
 * The lists a change of an issue replaces, as the sender saw them before it: the server applies what the sender added and
 * took off to the list as it is now, so two people changing a list at once both keep their change.
 */
export type ListBase = Partial<Record<(typeof ISSUE_LISTS)[number], string[]>>;
export const ISSUE_LISTS = ["assigneeIds", "labelIds", "blockedByIds", "relatedIds"] as const;
// Every list a client may change: a new one merges like these or fails here.
true satisfies Equal<(typeof ISSUE_LISTS)[number], { [K in keyof IssuePatch]-?: NonNullable<IssuePatch[K]> extends readonly unknown[] ? K : never }[keyof IssuePatch]>;

/**
 * Every op names its model and row and carries its fields in `set`, so the client's optimistic machinery treats them
 * alike. Deleting a comment leaves a tombstone (empty body, deletedAt) so its thread stays; deleting a reaction removes it.
 * Deleting an issue puts it in the trash (`deletedAt`); the delete op takes one in the trash away for good (RSVA-457).
 */
export type Op =
  | { op: "update"; m: "Issue"; id: string; set: IssueUpdate; base?: ListBase }
  | { op: "create"; m: "Issue"; id: string; projectId: string; set: IssuePatch & { title: string; stateId: string } }
  | { op: "delete"; m: "Issue"; id: string }
  | { op: "create"; m: "Comment"; id: string; set: CommentCreate }
  | { op: "update"; m: "Comment"; id: string; set: { body: string } }
  | { op: "delete"; m: "Comment"; id: string }
  | { op: "create"; m: "Reaction"; id: string; set: ReactionCreate }
  | { op: "delete"; m: "Reaction"; id: string }
  /** A link on an issue; anyone who may edit the issue adds, edits or removes one. */
  | { op: "create"; m: "Attachment"; id: string; set: AttachmentCreate }
  | { op: "update"; m: "Attachment"; id: string; set: AttachmentPatch }
  | { op: "delete"; m: "Attachment"; id: string }
  /**
   * The whole description; `id` is the issue's. `base` is the transaction that made the text this one was edited from
   * (null: no save yet): another text in between is refused as `conflict`, not overwritten. Without it the last write wins.
   */
  | { op: "update"; m: "Document"; id: string; set: { doc: DocJSON }; base?: string | null }
  /** Workspace settings; `id` is the workspace's. */
  | { op: "update"; m: "Workspace"; id: string; set: WorkspacePatch }
  // Project settings. A transaction that creates a project or changes states must leave each project it touches with
  // states and exactly one default among them: a new project comes with its states in the same transaction. Deleting a state or a label that issues still use is refused: the client moves the issues off it first, in
  // the transactions before (so the history shows each move), as it would by hand.
  | { op: "create"; m: "Project"; id: string; set: ProjectCreate }
  | { op: "update"; m: "Project"; id: string; set: ProjectPatch }
  | { op: "create"; m: "WorkflowState"; id: string; set: StateCreate }
  | { op: "update"; m: "WorkflowState"; id: string; set: StatePatch }
  | { op: "delete"; m: "WorkflowState"; id: string }
  | { op: "create"; m: "Label"; id: string; set: LabelCreate }
  | { op: "update"; m: "Label"; id: string; set: LabelPatch }
  | { op: "delete"; m: "Label"; id: string }
  // Cycles (PLNR-63); members plan their work, so issue writers create and change them. Cycles of a project never
  // overlap. Completing one (`completedAt`) freezes its summary; the client moves its open issues on in the same
  // transaction, after the completion, as ordinary issue updates. Deleting one that issues are in is refused: the client
  // moves them off first, as for labels.
  | { op: "create"; m: "Cycle"; id: string; set: CycleCreate }
  | { op: "update"; m: "Cycle"; id: string; set: CyclePatch }
  | { op: "delete"; m: "Cycle"; id: string }
  // Members; `id` is the user's. Admins change roles and remove others; anyone may remove themselves (leave), except
  // the owner. The server answers with a User U action: `role` null for someone who is no longer a member.
  | { op: "update"; m: "User"; id: string; set: { role: AssignableRole } }
  | { op: "delete"; m: "User"; id: string };

// ── WebSocket frames ────────────────────────────────────────────────────────────────────────────────────────

/** Client → server: subscribe to the workspace from number `s`; the server sends what was missed. */
export interface SubFrame {
  t: "sub";
  ws: string;
  s: number;
}

/** Client → server: a transaction. The client creates `id` (UUIDv7); replays are safe. */
export interface TxFrame {
  t: "tx";
  id: string;
  ops: Op[];
}

export type ClientFrame = SubFrame | TxFrame | PingFrame | InboxRequestFrame | MarkFrame | ViewsRequestFrame | ViewWriteFrame;

export interface HelloFrame {
  t: "hello";
  v: number;
  /**
   * The user the socket is signed in as. A tab reconnects with whatever credential the browser holds now, and another tab
   * may have signed someone else in: the engine compares it with its own person before sending the queue (PLNR-189).
   */
  u: string;
}

/** Deltas. The same frame string goes to every subscriber of the workspace. */
export interface DeltaFrame {
  t: "d";
  a: Action[];
}

export interface AckFrame {
  t: "ack";
  id: string;
  /** Number of the transaction's last action; the client drops it from the queue once it has applied that number. */
  s: number;
}

export interface RejectFrame {
  t: "rej";
  id: string;
  code: string;
  msg: string;
  /** rate_limited: how long to wait before sending again, ms. Nothing after this frame was taken from this connection. */
  wait?: number;
}

/**
 * Client → server: "are you there?". A dead link gives no error: a socket with nothing to read looks the same as a quiet
 * workspace, and the browser may not notice for minutes. The client asks, and takes silence as the answer.
 */
export interface PingFrame {
  t: "ping";
}

/** The answer. `s`: the log number last sent to this workspace's subscribers (missing before `sub`): how far behind the client is. */
export interface PongFrame {
  t: "pong";
  s?: number;
}

/** The client is behind the log tail or the workspace data was replaced: a new snapshot is needed. */
export interface ResyncFrame {
  t: "resync";
}

/**
 * The catch-up a `sub` asked for has been sent, on this connection (PLNR-80). A client that does not know it ignores it,
 * so it needs no version bump.
 */
export interface CaughtUpFrame {
  t: "caught-up";
}

export type ServerFrame = HelloFrame | DeltaFrame | AckFrame | RejectFrame | ResyncFrame | CaughtUpFrame | PongFrame | InboxFrame | MarksFrame | ViewsFrame;

const SERVER_FRAMES = new Set(["hello", "d", "ack", "rej", "resync", "caught-up", "pong", "inbox", "marks", "views"]);

export function parseServerFrame(data: string): ServerFrame | null {
  try {
    const f = JSON.parse(data) as { t?: unknown };
    return typeof f.t === "string" && SERVER_FRAMES.has(f.t) ? (f as ServerFrame) : null;
  } catch {
    return null;
  }
}

/** UUIDv7: time in the high bits, so new ids sort in creation order, like uuidv7() in Postgres 18. */
export function uuidv7(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  b[0] = ms / 2 ** 40;
  b[1] = ms / 2 ** 32;
  b[2] = ms / 2 ** 24;
  b[3] = ms / 2 ** 16;
  b[4] = ms / 2 ** 8;
  b[5] = ms;
  return uuidOf(b, 7);
}

/** 16 bytes as a UUID of this version (RFC 9562): its version and variant bits are set in `b`. */
export function uuidOf(b: Uint8Array, version: number): string {
  b[6] = (b[6]! & 0x0f) | (version << 4);
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b.subarray(0, 16)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
