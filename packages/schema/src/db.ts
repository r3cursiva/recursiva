// Postgres tables: the single description of the data model. Client row types (models.ts) and migrations
// (`pnpm --filter @rsva/schema generate`) come from here. Only the server imports it: drizzle never reaches the browser.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { TileColor } from "./models.ts";

const id = () => uuid().primaryKey().default(sql`uuidv7()`);
const ts = () => timestamp({ withTimezone: true, mode: "string" });
// Where an object was imported from: a repeated import finds it instead of creating a duplicate.
const external = { externalSource: text(), externalId: text() };

/** The workspace a row belongs to. */
const workspaceRef = () => uuid().notNull().references(() => workspace.id);
/** What a row of a workspace's starts with: its id and its workspace. */
const inWorkspace = () => ({ id: id(), workspaceId: workspaceRef() });
/** What a row of a project's starts with: its id, its workspace and its project (issues and cycles). */
const inProject = () => ({ ...inWorkspace(), projectId: uuid().notNull().references(() => project.id) });
/** What a row on an issue starts with: its id, its workspace and its issue (comments, reactions, attachments, GitHub links). */
const onIssue = () => ({ ...inWorkspace(), issueId: uuid().notNull().references(() => issue.id) });
/** The index that finds an imported object again: one per source and id within `scope`, its workspace or its project. */
const externalIndex = (t: { externalSource: AnyPgColumn; externalId: AnyPgColumn }, scope: AnyPgColumn) => uniqueIndex().on(scope, t.externalSource, t.externalId);

export const workspace = pgTable("workspace", {
  id: id(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  /** Tile tone (packages/ui letter-tile): null draws the open workspace in ink and the others in a tone from the name. */
  color: text().$type<TileColor>(),
  /**
   * What an admin opened to every member, as Linear's team permissions (packages/policy, MEMBER_RIGHTS): labels, states,
   * projects. Agents are members, so this is also what agents may change (ADR 0037). A new workspace opens labels:
   * everyday work; states and projects are how the work runs.
   */
  memberRights: text().array().notNull().default(sql`'{labels.write}'`),
  /**
   * Who triages (the owner, 2026-11-11): the members whose Triage lists the proposals and the agents' reviews, as Linear's
   * triage responsibility. Empty: every owner and admin, as before the setting.
   */
  triagers: uuid().array().notNull().default(sql`'{}'`),
  /** Number of the last log action; incremented in the same transaction as the change. */
  lastSyncId: bigint({ mode: "number" }).notNull().default(0),
});

export const user = pgTable("user", {
  id: id(),
  email: text().notNull().unique(),
  name: text().notNull(),
  /** human, agent, or bot: the integration or the app itself acting on its own (BOTS), a member of no workspace. */
  kind: text().notNull().default("human"),
  /** The profile picture (PLNR-244): the SHA-256 of its bytes, which `user_picture` holds; null draws initials. */
  picture: char({ length: 64 }),
  /** The creature drawn without a picture (PLNR-366), as CREATURE in models.ts spells it; null draws the name's own. */
  avatar: text(),
  ...external,
});

export const member = pgTable(
  "member",
  {
    workspaceId: workspaceRef(),
    userId: uuid().notNull().references(() => user.id),
    /** owner, admin, member, guest. */
    role: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const project = pgTable(
  "project",
  {
    ...inWorkspace(),
    key: text().notNull(),
    name: text().notNull(),
    /** Tile tone (packages/ui letter-tile): null picks one from the key. */
    color: text().$type<TileColor>(),
    /**
     * Keys the project had before a rename: issue keys and links with them keep working (as in Linear), and no other
     * project of the workspace may take them.
     */
    formerKeys: text().array().notNull().default(sql`'{}'`),
    /** Last issued issue number. */
    issueCounter: integer().notNull().default(0),
    createdAt: ts().notNull().defaultNow(),
    archivedAt: ts(),
    /** Its cycles complete themselves once over, and their open issues move to the next one (PLNR-64, ADR 0049). */
    cycleRollover: boolean().notNull().default(false),
    ...external,
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.key), externalIndex(t, t.workspaceId)],
);

export const workflowState = pgTable(
  "workflow_state",
  {
    id: id(),
    projectId: uuid().notNull().references(() => project.id),
    name: text().notNull(),
    /** backlog, unstarted, started, completed, cancelled: Plane's state groups. */
    group: text().notNull(),
    color: text().notNull(),
    position: doublePrecision().notNull(),
    isDefault: boolean().notNull().default(false),
    /** Only people move issues here: agents are refused (packages/policy, Guarded; ADR 0037). A signed-in admin switches it. */
    onlyPeople: boolean().notNull().default(false),
    ...external,
  },
  (t) => [index().on(t.projectId), externalIndex(t, t.projectId)],
);

export const label = pgTable(
  "label",
  {
    ...inWorkspace(),
    /** null for a workspace label. */
    projectId: uuid().references(() => project.id),
    parentId: uuid(),
    name: text().notNull(),
    color: text().notNull(),
    position: doublePrecision().notNull().default(0),
    /** Only people rename or delete it; agents still put it on issues (packages/policy, Guarded; ADR 0037). */
    onlyPeople: boolean().notNull().default(false),
    ...external,
  },
  (t) => [index().on(t.workspaceId), externalIndex(t, t.workspaceId)],
);

/**
 * What a cycle was when it was completed (PLNR-63): its numbers frozen, so the page and its review read the same however
 * its issues move on and however much of the log is trimmed later. `open` are the issues that were not done or cancelled
 * then: the ones the completion moved on (where they are now says where they went) or left behind.
 */
export interface CycleSummary {
  /** Issues in the cycle at completion, by state group. */
  groups: Record<string, number>;
  open: string[];
  /** At the first moment, then at each day's end to the completion: issues in the cycle, started or done, and done (docs/research/cycles-2026-10-30.md, RSVA-528). */
  scope: number[];
  started: number[];
  done: number[];
}

/**
 * A time box of a project's work (PLNR-63), as in Plane: a name, an optional description and lead, and dates. Without
 * dates it is a draft. Cycles of one project never overlap; an issue sits in one cycle at most (`issue.cycleId`).
 * Completing one sets `completedAt` and freezes its `summary`; a completed cycle takes no new issues.
 */
export const cycle = pgTable(
  "cycle",
  {
    ...inProject(),
    /** 1, 2, 3… in the project: "C12" in short and the address of the cycle's page. */
    number: integer().notNull(),
    name: text().notNull(),
    description: text().notNull().default(""),
    /** Both days included; both null for a draft. */
    startDate: date({ mode: "string" }),
    endDate: date({ mode: "string" }),
    leadId: uuid().references(() => user.id),
    createdById: uuid().references(() => user.id),
    createdAt: ts().notNull().defaultNow(),
    completedAt: ts(),
    summary: jsonb().$type<CycleSummary>(),
    ...external,
  },
  (t) => [uniqueIndex().on(t.projectId, t.number), index().on(t.workspaceId), externalIndex(t, t.workspaceId)],
);

export const issue = pgTable(
  "issue",
  {
    ...inProject(),
    number: integer().notNull(),
    title: text().notNull(),
    stateId: uuid().notNull().references(() => workflowState.id),
    /** 0 none, 1 urgent, 2 high, 3 medium, 4 low (as in Linear). */
    priority: smallint().notNull().default(0),
    assigneeIds: uuid().array().notNull().default(sql`'{}'`),
    /** The agent working on the issue; the assignee owns the outcome. */
    delegateId: uuid(),
    labelIds: uuid().array().notNull().default(sql`'{}'`),
    parentId: uuid(),
    /**
     * Relations live on the issue, as the parent does (docs/research/relations-links-2026-10-29.md): issues this one waits
     * for, issues related to it, the issue it duplicates. The other side ("blocks", "duplicates", related from there) is
     * read through the pool's reverse index. A pair is stored once: related on whichever side added it.
     */
    blockedByIds: uuid().array().notNull().default(sql`'{}'`),
    relatedIds: uuid().array().notNull().default(sql`'{}'`),
    duplicateOfId: uuid(),
    startDate: date({ mode: "string" }),
    dueDate: date({ mode: "string" }),
    /** The cycle of the issue's project it is planned into (PLNR-63); one at most, as in Linear. */
    cycleId: uuid().references(() => cycle.id),
    /** Fractional index: moving an issue changes one row. Collation "C" (migration 0002): compared bytewise, as in JS. */
    sortOrder: text().notNull(),
    createdById: uuid(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
    completedAt: ts(),
    archivedAt: ts(),
    /**
     * Deleted, not removed (migration 0010): the row stays in the snapshot and the pool hides it, so undo, restore and the
     * project's trash are field edits like archiving. Delete permanently and the sweep after TRASH_DAYS remove the row
     * (sync/purge.ts, RSVA-457).
     */
    deletedAt: ts(),
    /**
     * Keys the issue had in projects it was moved out of, oldest first ("RSVA-3", PLNR-448): links, branches and typed keys
     * with them still find it, after the keys of projects. Dropped when another project takes that key (sync/settings.ts).
     */
    formerKeys: text().array().notNull().default(sql`'{}'`),
    ...external,
  },
  (t) => [
    uniqueIndex().on(t.projectId, t.number),
    externalIndex(t, t.workspaceId),
    index().on(t.workspaceId),
    // The few moved issues of a workspace, for a lookup by a former key: a scan of them, not of every issue.
    index("issue_moved_idx").on(t.workspaceId).where(sql`${t.formerKeys} <> '{}'`),
  ],
);

/**
 * A rich-text document as ProseMirror's JSON (packages/editor/src/doc.ts has the exact node and mark types). Defined
 * structurally here so the schema package does not depend on the editor.
 */
export interface DocJSON {
  type: string;
  attrs?: Record<string, string | number | boolean>;
  content?: DocJSON[];
  marks?: { type: string; attrs?: Record<string, string> }[];
  text?: string;
}

/**
 * Description body. Not part of the workspace snapshot: loaded with the issue's history when it is opened.
 * `doc` is the description (migration 0004, docs/decisions/0007-description-storage.md); null is empty. `html` is the
 * Plane HTML rows held before that: the server converts it into `doc` once at start and never reads it otherwise.
 */
export const document = pgTable("document", {
  /** Same as the issue id. */
  id: uuid().primaryKey(),
  workspaceId: workspaceRef(),
  html: text().notNull(),
  doc: jsonb().$type<DocJSON>(),
  updatedAt: ts().notNull().defaultNow(),
});

/**
 * Comment on an issue. Not part of the workspace snapshot: loaded with the issue's history when the issue is opened
 * (GET /sync/history/:issueId), then kept live by deltas. Replies are one level deep: `parentId` is a top-level
 * comment of the same issue. Deleting keeps the row as a tombstone (empty body, `deletedAt`) so a thread keeps its
 * replies.
 */
export const comment = pgTable(
  "comment",
  {
    ...onIssue(),
    parentId: uuid(),
    /** null: an imported comment whose author is not a member. */
    authorId: uuid().references(() => user.id),
    /** Markdown, rendered on the client into DOM nodes (never parsed as HTML). */
    body: text().notNull(),
    createdAt: ts().notNull().defaultNow(),
    editedAt: ts(),
    deletedAt: ts(),
    /** Where it was written when not in the app: "telegram" (a reply in the bot's chat), "email" (a reply by email). PLNR-369. */
    via: text(),
    ...external,
  },
  (t) => [index().on(t.issueId), externalIndex(t, t.workspaceId)],
);

/** Emoji reaction to an issue (commentId null) or one of its comments. One per user, emoji and target. */
export const reaction = pgTable(
  "reaction",
  {
    ...onIssue(),
    commentId: uuid().references(() => comment.id),
    userId: uuid().notNull().references(() => user.id),
    emoji: text().notNull(),
    createdAt: ts().notNull().defaultNow(),
    ...external,
  },
  (t) => [
    index().on(t.issueId),
    unique().on(t.userId, t.emoji, t.issueId, t.commentId).nullsNotDistinct(),
    externalIndex(t, t.workspaceId),
  ],
);

/**
 * A link or a file on an issue. A link is a URL with a title, recognised as a GitHub pull request or commit by its
 * address; a file (kind "file") is a blob of the workspace with its name as the title and `/files/<ws>/<sha256>` as the
 * URL (PLNR-50). In the snapshot, like the issue's other fields.
 */
export const attachment = pgTable(
  "attachment",
  {
    ...onIssue(),
    /** link, github_pr, github_commit, file (packages/schema/src/models.ts, ATTACHMENT_KINDS). */
    kind: text().notNull(),
    url: text().notNull(),
    /** A link's title (empty: the client shows the address); a file's name. */
    title: text().notNull().default(""),
    /** A file's blob; its size and type, copied from the blob row so the snapshot carries them. Null for links. */
    sha256: char({ length: 64 }),
    size: bigint({ mode: "number" }),
    mime: text(),
    createdById: uuid().references(() => user.id),
    createdAt: ts().notNull().defaultNow(),
    ...external,
  },
  (t) => [index().on(t.workspaceId), index().on(t.issueId), externalIndex(t, t.workspaceId)],
);

/**
 * A file's bytes as the workspace has them, by content (PLNR-50): one row per distinct file in a workspace, however many
 * attachments and images use it. The bytes are in the blob store (apps/server/src/files), not here; this row is what the
 * quota sums and what an attachment's size and type come from. `mime` is what the server serves the file as: a raster
 * image type only when the bytes start like one (files/sniff.ts).
 */
export const blob = pgTable(
  "blob",
  {
    workspaceId: workspaceRef(),
    sha256: char({ length: 64 }).notNull(),
    size: bigint({ mode: "number" }).notNull(),
    mime: text().notNull(),
    createdById: uuid().references(() => user.id),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.sha256] })],
);

// ── GitHub (PLNR-96, ADR 0017) ──────────────────────────────────────────────────────────────────────────────────

/** Where the App is installed, as GitHub's webhooks and `github sync` report it. Not a workspace's: its repositories are. */
export const githubInstallation = pgTable("github_installation", {
  /** GitHub's installation id. */
  id: bigint({ mode: "number" }).primaryKey(),
  account: text().notNull(),
  /** User or Organization. */
  accountType: text().notNull(),
  /** GitHub login of who installed it, when a webhook named them. */
  installedBy: text(),
  suspendedAt: ts(),
  createdAt: ts().notNull().defaultNow(),
});

/**
 * A repository the App can see. It feeds one workspace once the operator binds it (`apps/server/src/cli/github.ts`); until
 * then, or with `enabled` off, its webhooks are received and ignored.
 */
export const githubRepo = pgTable(
  "github_repo",
  {
    /** GitHub's repository id: it survives a rename, and a name can pass to someone else. */
    id: bigint({ mode: "number" }).primaryKey(),
    fullName: text().notNull(),
    installationId: bigint({ mode: "number" }).references(() => githubInstallation.id),
    workspaceId: uuid().references(() => workspace.id),
    defaultBranch: text().notNull().default("main"),
    /** A public repository's bot comment carries keys and links, never issue titles. */
    isPrivate: boolean().notNull().default(true),
    enabled: boolean().notNull().default(true),
    /**
     * Projects its references may reach, by id: a rename or a key another project takes over leaves the binding with its
     * project (PLNR-454). Empty: any project of the workspace.
     */
    projectIds: uuid().array().notNull().default(sql`'{}'`),
    lastDeliveryAt: ts(),
    lastError: text(),
    lastErrorAt: ts(),
  },
  (t) => [index().on(t.workspaceId), index().on(t.fullName)],
);

/**
 * A pull request of a bound repository, whether or not it names an issue yet: a key can arrive with a later edit, and the
 * reviews and checks gathered until then must not be lost. Server-only: clients see GithubLink rows.
 */
export const githubPull = pgTable(
  "github_pull",
  {
    id: id(),
    repoId: bigint({ mode: "number" }).notNull().references(() => githubRepo.id),
    number: integer().notNull(),
    title: text().notNull(),
    /** open, draft, merged, closed (models.ts, PullState). */
    state: text().notNull(),
    head: text().notNull(),
    headSha: text().notNull(),
    base: text().notNull(),
    author: text().notNull(),
    authorBot: boolean().notNull().default(false),
    /** Each reviewer's last verdict: approved, changes or dismissed. Read as one review state (github/pull.ts). */
    reviews: jsonb().$type<Record<string, string>>().notNull().default({}),
    /** The head commit's checks and commit statuses by name: pass, fail or run. Emptied when the head moves. */
    checks: jsonb().$type<Record<string, string>>().notNull().default({}),
    /** Issue keys in the pull request's commits: true when a commit closes it. Read when the commits change. */
    commitRefs: jsonb().$type<Record<string, boolean>>().notNull().default({}),
    /** The App's one comment on the pull request. */
    commentId: bigint({ mode: "number" }),
    /** Last change as GitHub reports it: the time a row shows. */
    updatedAt: ts().notNull(),
  },
  (t) => [uniqueIndex().on(t.repoId, t.number), index().on(t.repoId, t.headSha)],
);

/**
 * A pull request or a commit on an issue: `pullId` set, or `sha`, `message`, `author`, `authorBot` and `at` of a commit
 * pushed to the default branch. `closing` is false for a reference that only links ("Refs INFRA-1"). Loaded with the
 * issue's history, not in the snapshot.
 */
export const githubLink = pgTable(
  "github_link",
  {
    ...onIssue(),
    repoId: bigint({ mode: "number" }).notNull().references(() => githubRepo.id),
    pullId: uuid().references(() => githubPull.id),
    closing: boolean().notNull(),
    sha: text(),
    message: text(),
    author: text(),
    authorBot: boolean(),
    at: ts(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.issueId), index().on(t.pullId), uniqueIndex().on(t.issueId, t.pullId), uniqueIndex().on(t.issueId, t.repoId, t.sha)],
);

/**
 * A webhook delivery GitHub made: a redelivery of an answered one is not applied twice, and settings show the last one
 * and the last error. Trimmed to the last 30 days as new ones arrive.
 */
export const githubDelivery = pgTable(
  "github_delivery",
  {
    /** X-GitHub-Delivery. */
    id: text().primaryKey(),
    /** With the action: pull_request.closed. */
    event: text().notNull(),
    repoId: bigint({ mode: "number" }),
    repoName: text(),
    workspaceId: uuid().references(() => workspace.id),
    /** The answer given; 0 while it is being handled. */
    status: integer().notNull().default(0),
    error: text(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt), index().on(t.createdAt)],
);

/** The log: every change, numbered in order within the workspace. */
export const syncAction = pgTable(
  "sync_action",
  {
    workspaceId: uuid().notNull(),
    id: bigint({ mode: "number" }).notNull(),
    model: text().notNull(),
    modelId: uuid().notNull(),
    /** I insert, U update, A archive, D delete, R replaced (import). */
    action: char({ length: 1 }).notNull(),
    data: jsonb(),
    /**
     * Values of the changed fields before the action (U only): the issue history shows "from → to" without walking
     * the log, and the entry stays readable after older actions are trimmed. Server-only: deltas do not carry it.
     */
    prev: jsonb(),
    txId: uuid(),
    actorId: uuid(),
    /** Where the change was made when not in the app or the API: "telegram", "email" (PLNR-369). The history shows it. */
    via: text(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    index().on(t.modelId, t.id),
    // Issues moved out of a project, for its Timeline (PLNR-448): moves are rare, so the index is small.
    index("sync_action_moved_out_idx").on(t.workspaceId, sql`(${t.prev} ->> 'projectId')`).where(sql`${t.model} = 'Issue' and ${t.prev} ? 'projectId'`),
  ],
);

/**
 * A person's marks on an issue's notifications (PLNR-26). The notifications themselves are not stored: they are read off
 * the log (packages/protocol/src/inbox.ts). Marks are log numbers, so a newer action makes the issue unread again and
 * brings it back from the archive. The person's Subscribe or Unsubscribe on the issue is a mark too (PLNR-28): it is as
 * private as the rest. Server-side per person: they never go into the workspace's log or snapshot.
 */
export const inboxMark = pgTable(
  "inbox_mark",
  {
    userId: uuid().notNull().references(() => user.id),
    issueId: uuid().notNull().references(() => issue.id),
    workspaceId: workspaceRef(),
    readId: bigint({ mode: "number" }).notNull().default(0),
    archivedId: bigint({ mode: "number" }).notNull().default(0),
    snoozedId: bigint({ mode: "number" }).notNull().default(0),
    snoozedUntil: ts(),
    /** Subscribe (true) or Unsubscribe (false) on the issue from log number `subscribedId` on; null: never chose (PLNR-28). */
    subscribed: boolean(),
    subscribedId: bigint({ mode: "number" }).notNull().default(0),
    /** When the row last changed: a client asks for marks changed after the last it has. */
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.issueId] }), index().on(t.userId, t.workspaceId, t.updatedAt)],
);

/**
 * A saved view (PLNR-74): a name for a query over the whole workspace (a project is one of its filters), display
 * options and a layout. With `tab` it is a tab in each project its query names with `project:`, ordered by `position`
 * (one order for everyone). A private view is its owner's alone; a shared one every member sees, and only its owner or
 * an admin changes. Not in the log or the snapshot: a member's private views must not reach the others, so views
 * travel in their own socket frames, each viewer getting the shared ones and their own (apps/server/src/sync/views.ts).
 * A deleted view keeps its row (`deletedAt`), so a client that was away learns it is gone.
 */
export const savedView = pgTable(
  "saved_view",
  {
    ...inWorkspace(),
    ownerId: uuid().notNull().references(() => user.id),
    name: text().notNull(),
    /** A Phosphor icon's name from the client's short list (VIEW_ICONS). */
    icon: text().notNull(),
    /** The filter as query text (packages/query): readable, and the same text the URL, the CLI and agents take. */
    query: text().notNull().default(""),
    /** Display options (packages/query DisplayOptions); the client fills in what an older view lacks. */
    display: jsonb().notNull(),
    /** list or board. */
    layout: text().notNull().default("list"),
    shared: boolean().notNull().default(false),
    /** A tab in the projects of its `project:` filter. */
    tab: boolean().notNull().default(false),
    /** Order among the tabs of a project: smaller first. */
    position: doublePrecision().notNull().default(0),
    createdAt: ts().notNull().defaultNow(),
    /** When the row last changed, deletion included: a client asks for views changed after the last it has. */
    updatedAt: ts().notNull().defaultNow(),
    deletedAt: ts(),
    ...external,
  },
  (t) => [index().on(t.workspaceId, t.updatedAt), externalIndex(t, t.workspaceId)],
);

/** A person's choice to keep a view in their sidebar (PLNR-74): their own, whoever owns the view. */
export const viewPin = pgTable(
  "view_pin",
  {
    userId: uuid().notNull().references(() => user.id),
    viewId: uuid().notNull().references(() => savedView.id),
    workspaceId: workspaceRef(),
    pinned: boolean().notNull(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.viewId] }), index().on(t.userId, t.workspaceId, t.updatedAt)],
);

/**
 * A person's own sidebar in a workspace, one row per person, outside the log. `ids`: their order of the projects
 * (ADR 0020); ids of projects missing here come after the listed ones by key, so no row means the order by key.
 * `pins`: what they keep in the Pinned section, in order, as `view:<id>`, `issue:<id>` or `cycle:<id>` (PLNR-292).
 * `hidden`: projects they took out of the sidebar. `groups`: their groups of projects and Quiet choices (RSVA-566,
 * `SidebarGroups` of packages/protocol), `{}` until they make one. None of them is checked against the workspace: only
 * its owner reads it.
 */
export const projectOrder = pgTable(
  "project_order",
  {
    userId: uuid().notNull().references(() => user.id),
    workspaceId: workspaceRef(),
    ids: uuid().array().notNull(),
    pins: text().array().notNull().default(sql`'{}'`),
    hidden: uuid().array().notNull().default(sql`'{}'`),
    groups: jsonb().notNull().default({}),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] })],
);

const bytea = customType<{ data: Uint8Array }>({ dataType: () => "bytea" });

/**
 * The bytes of a person's profile picture (PLNR-244): one square image the browser cut and encoded, tens of KB, so a row
 * and not a file; it changes in the same transaction as `user.picture`, and goes with the database's backup. Served at
 * /pictures/<sha256> (apps/server/src/auth/picture.ts).
 */
export const userPicture = pgTable(
  "user_picture",
  {
    userId: uuid().primaryKey().references(() => user.id),
    sha256: char({ length: 64 }).notNull(),
    bytes: bytea().notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.sha256)],
);

/**
 * The person's own settings on Settings › Profile (PLNR-194), the same in every workspace and on every device. Not in
 * `user`: that row is in every workspace's snapshot, and these are nobody else's business. A person without a row has
 * the defaults.
 */
export const accountSettings = pgTable("account_settings", {
  userId: uuid().primaryKey().references(() => user.id),
  /** IANA zone (`Europe/Sofia`); null until a browser of theirs reports its own. */
  timeZone: text(),
  /** First day of the week as `Date.getDay()` counts: 1 Monday, 0 Sunday, 6 Saturday. */
  weekStart: smallint().notNull().default(1),
  /** ThemeChoice from @rsva/protocol (mode, light theme, dark theme); null: never picked. */
  theme: jsonb(),
  /** UiChoice from @rsva/protocol (the window's panes); null: never picked. */
  ui: jsonb(),
  /** My work's folded groups (GroupId[] from @rsva/protocol/my-work); null: Later and Done this week. */
  myWork: jsonb(),
  /** Settings › Notifications (PLNR-199): NotifyPrefs from @rsva/protocol; null: the defaults. */
  notifications: jsonb(),
  /** What the unsubscribe link in a notification email carries (PLNR-208): random, made with the first such email. */
  unsubscribeKey: text(),
  updatedAt: ts().notNull().defaultNow(),
});

/**
 * How far the notifier has read each workspace's log (PLNR-200): actions after `lastId` are not classified yet. It moves
 * in the same transaction that writes their outbox rows, so a restart neither skips nor repeats them.
 */
export const notifyCursor = pgTable("notify_cursor", {
  workspaceId: uuid().primaryKey().references(() => workspace.id),
  lastId: bigint({ mode: "number" }).notNull(),
});

/** The last morning digest and weekly summary each person was sent, as their local date: one of each a day at most. */
export const notifyDigest = pgTable(
  "notify_digest",
  {
    userId: uuid().notNull().references(() => user.id),
    /** daily, weekly; morning: the day's notices, due today and cycles (PLNR-206). */
    kind: text().notNull(),
    sentOn: date({ mode: "string" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);

/**
 * A notification on its way to a channel: written when its action is classified, sent once `dueAt` passes (already seen
 * and quiet hours set it), then marked. One per person, action and channel; a group chat's row (PLNR-204) carries its
 * group, and the person is whoever linked the group: the group gets what they may read.
 */
export const notifyOutbox = pgTable(
  "notify_outbox",
  {
    id: id(),
    userId: uuid().notNull().references(() => user.id),
    workspaceId: workspaceRef(),
    channel: text().notNull(),
    /** The log action and why it concerns the person: an InboxKind and the NotifyEvent row it falls under. */
    actionId: bigint({ mode: "number" }).notNull(),
    issueId: uuid().notNull(),
    kind: text().notNull(),
    event: text().notNull(),
    byId: uuid(),
    commentId: uuid(),
    stateId: uuid(),
    dueAt: ts().notNull(),
    /** pending, sent, seen (read in the app before it was due), dropped (rules changed, issue gone), failed. */
    status: text().notNull().default("pending"),
    attempts: smallint().notNull().default(0),
    error: text(),
    /**
     * A sent Telegram message: its chat and its id there (PLNR-203). A reply finds the issue and thread by both: ids are
     * counted per chat, so a chat linked later must not match a message of the one before.
     */
    chatId: bigint({ mode: "number" }),
    messageId: bigint({ mode: "number" }),
    /** The group chat a "group" row goes to (PLNR-204); null for the person's own channels. */
    groupId: uuid().references(() => telegramGroup.id, { onDelete: "cascade" }),
    /** An email sent instead of a Telegram message, because the person's chat stopped taking them (PLNR-204). */
    fallback: boolean().notNull().default(false),
    /**
     * The hash of the token in a sent email's reply address (PLNR-211, mail/inbound.ts): a reply to it finds the
     * person, the issue and the thread here, as a Telegram reply does by messageId. Only its hash is kept.
     */
    replyHash: text(),
    createdAt: ts().notNull().defaultNow(),
    doneAt: ts(),
  },
  (t) => [
    // NULLS NOT DISTINCT: the person's own rows, with no group, stay one per action and channel.
    unique().on(t.userId, t.workspaceId, t.actionId, t.channel, t.groupId).nullsNotDistinct(),
    index().on(t.dueAt).where(sql`${t.status} = 'pending'`),
    index().on(t.chatId, t.messageId).where(sql`${t.messageId} is not null`),
    uniqueIndex().on(t.replyHash).where(sql`${t.replyHash} is not null`),
  ],
);

/**
 * A person's Telegram chat with the bot (PLNR-202): where their Telegram column goes. Made when they press Start on a
 * link from Settings › Notifications › Telegram; deleted on Disconnect. The bot writes to no other chat.
 */
export const telegramChat = pgTable("telegram_chat", {
  userId: uuid().primaryKey().references(() => user.id),
  chatId: bigint({ mode: "number" }).notNull(),
  /** As Telegram reported them when the chat was linked: @username (may be absent) and the name. */
  username: text(),
  name: text().notNull(),
  linkedAt: ts().notNull().defaultNow(),
  /** The last refusal from Telegram (the bot blocked, the chat gone): delivery stops until the person connects again. */
  error: text(),
  errorAt: ts(),
  /** `/mute 2h` in the chat (PLNR-205): until then only urgent issues are sent here; the rest stays in the inbox. */
  mutedUntil: ts(),
  /**
   * Whether the chat may act for the person (RSVA-496): buttons that change things, commands, replies as comments, issues
   * from forwards. Off, it only gets notifications, so whoever gets into the Telegram account reads and changes nothing.
   * A newly linked chat starts off; turning it on needs a fresh sign-in.
   */
  actions: boolean().notNull().default(false),
});

/**
 * A Telegram group chat linked to a workspace (PLNR-204): everyone in it sees what it was given, the events of its
 * projects. Linked by a member with `/link@<bot> <code>` or the bot's startgroup link; it gets only what that member may
 * read, checked again when each message goes. Removed from the group, the bot marks it and sends nothing more.
 */
export const telegramGroup = pgTable(
  "telegram_group",
  {
    ...inWorkspace(),
    /** Telegram's id of the group; a group that becomes a supergroup gets a new one (telegram/groups.ts). */
    chatId: bigint({ mode: "number" }).notNull(),
    /** As Telegram reported them: the group's title, and how many were in it when the page last asked. */
    title: text().notNull(),
    members: integer(),
    linkedBy: uuid().notNull().references(() => user.id),
    linkedAt: ts().notNull().defaultNow(),
    /** What it gets: these projects, these events (GROUP_EVENTS). Nothing until both are picked. */
    projectIds: uuid().array().notNull().default(sql`'{}'`),
    events: text().array().notNull().default(sql`'{}'`),
    /** The linker's date of the last cycles of the day it was sent (PLNR-253), one a day at most; a day with none counts. */
    cyclesSentOn: date({ mode: "string" }),
    /** Why it stopped (the bot removed): nothing goes until the group is linked again. */
    error: text(),
    errorAt: ts(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.chatId), index().on(t.chatId)],
);

/** A group chat's link code (`/link@<bot> <code>`): keyed by its SHA-256 and good for ten minutes, one per person. */
export const telegramGroupCode = pgTable("telegram_group_code", {
  id: text().primaryKey(),
  userId: uuid().notNull().unique().references(() => user.id),
  workspaceId: workspaceRef(),
  expiresAt: ts().notNull(),
});

/**
 * The start code of a Telegram link (`t.me/<bot>?start=<code>`): keyed by its SHA-256, as sessions are, and good for
 * ten minutes. One per person: a new link replaces the last.
 */
export const telegramCode = pgTable("telegram_code", {
  id: text().primaryKey(),
  userId: uuid().notNull().unique().references(() => user.id),
  expiresAt: ts().notNull(),
});

// ── Sign-in (docs/decisions/0009-sign-in.md). Server-only: none of these reach the browser. ─────────────────────

/**
 * A signed-in browser. The cookie holds a random token; the row is keyed by its SHA-256, so a copy of the database does
 * not hand out sessions. Idle sessions expire (`lastSeenAt`), and every session ends at `expiresAt`.
 */
export const session = pgTable(
  "session",
  {
    /** base64url SHA-256 of the cookie's token. */
    id: text().primaryKey(),
    userId: uuid().notNull().references(() => user.id),
    /** code, passkey or cli. */
    method: text().notNull(),
    userAgent: text(),
    createdAt: ts().notNull().defaultNow(),
    lastSeenAt: ts().notNull().defaultNow(),
    expiresAt: ts().notNull(),
  },
  (t) => [index().on(t.userId)],
);

/**
 * A browser a person has signed in from (PLNR-252): a sign-in from any other sends them a security email. The browser
 * keeps a random token in an HttpOnly cookie of its own, which outlives signing out; the row is keyed by its SHA-256.
 */
export const signInDevice = pgTable(
  "sign_in_device",
  {
    userId: uuid().notNull().references(() => user.id),
    /** base64url SHA-256 of the cookie's token. */
    id: text().notNull(),
    createdAt: ts().notNull().defaultNow(),
    /** The last sign-in from it: a browser unseen for the cookie's lifetime is forgotten (sweepSessions). */
    lastSeenAt: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);

/** A code sent by email: its hash, the wrong guesses so far, and its time. */
const sentCode = () => ({
  codeHash: text().notNull(),
  attempts: smallint().notNull().default(0),
  createdAt: ts().notNull().defaultNow(),
  expiresAt: ts().notNull(),
});

/** The one live sign-in code of an email: a new request replaces it. Stored as a hash, with the wrong guesses counted. */
export const loginCode = pgTable("login_code", {
  /** Lower-cased. */
  email: text().primaryKey(),
  ...sentCode(),
});

/**
 * One wrong sign-in code: a capped number of these per email in 24 hours stops codes for that address (auth/codes.ts).
 * In the database, so a deploy does not reset the count. Rows older than a day are swept.
 */
export const loginFailure = pgTable(
  "login_failure",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Lower-cased. */
    email: text().notNull(),
    at: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.email, t.at)],
);

/**
 * The waitlist of the cloud (RSVA-542, ADR 0054): an address that asked for access from the landing, and whether it was
 * let in. A let-in address signs in with a code as an invited one does and may create one workspace; creating it uses
 * the entry up, after which the person is a member like any other. One row an address: asking again changes nothing.
 */
export const waitlist = pgTable(
  "waitlist",
  {
    id: id(),
    /** Lower-cased. */
    email: text().notNull().unique(),
    /** What they work on, one line, as they typed it; may be empty. */
    note: text().notNull().default(""),
    createdAt: ts().notNull().defaultNow(),
    /** Let in by the operator (`waitlist admit`); null while waiting. */
    admittedAt: ts(),
    /** When their one workspace was created: the entry is used up. */
    usedAt: ts(),
  },
  (t) => [index().on(t.createdAt)],
);

/**
 * A change of a person's sign-in email, waiting for the code sent to the new address (PLNR-197, ADR 0033). One per
 * person: asking again replaces it. The code is stored as a hash with its wrong guesses, as a sign-in code is.
 */
export const emailChange = pgTable("email_change", {
  userId: uuid().primaryKey().references(() => user.id),
  /** The new address, lower-cased. */
  email: text().notNull(),
  ...sentCode(),
});

/**
 * The way back from an email change, mailed to the address it replaced (PLNR-197, ADR 0033): the link restores that
 * address and ends every session of the person. The row keeps the SHA-256 of the link's secret.
 */
export const emailRevert = pgTable(
  "email_revert",
  {
    /** base64url SHA-256 of the link's secret. */
    hash: text().primaryKey(),
    userId: uuid().notNull().references(() => user.id),
    /** The address the link restores, lower-cased. */
    oldEmail: text().notNull(),
    /** The address it was changed to: what the page names. */
    newEmail: text().notNull(),
    createdAt: ts().notNull().defaultNow(),
    expiresAt: ts().notNull(),
  },
  (t) => [index().on(t.userId)],
);

/** A WebAuthn credential (passkey). Attestation is not requested, so the key is what the browser reported at registration. */
export const passkey = pgTable(
  "passkey",
  {
    /** The credential id, base64url. */
    id: text().primaryKey(),
    userId: uuid().notNull().references(() => user.id),
    /** SubjectPublicKeyInfo DER, base64url: node:crypto reads it as is. */
    publicKey: text().notNull(),
    /** COSE algorithm: -7 ES256, -8 EdDSA, -257 RS256. */
    algorithm: integer().notNull(),
    signCount: bigint({ mode: "number" }).notNull().default(0),
    transports: text().array().notNull().default(sql`'{}'`),
    name: text().notNull(),
    createdAt: ts().notNull().defaultNow(),
    lastUsedAt: ts(),
  },
  (t) => [index().on(t.userId)],
);

/**
 * An API token: for agents, CLI and scripts. Bound to one workspace and one member, whose role it acts with, narrowed by
 * the scope (read, write, or custom with its grants). The secret is shown once; the row keeps its SHA-256 (it is 32 random bytes, so a slow hash
 * would add nothing).
 */
export const apiToken = pgTable(
  "api_token",
  {
    id: id(),
    /** base64url SHA-256 of the secret. */
    hash: text().notNull().unique(),
    workspaceId: workspaceRef(),
    userId: uuid().notNull().references(() => user.id),
    name: text().notNull(),
    /** read, write or custom (packages/policy, SCOPES). */
    scope: text().notNull(),
    /** A custom token's grants (packages/policy, GRANTS); empty for read and write. */
    grants: text().array().notNull().default(sql`'{}'`),
    /** Who last set the token's access, and when: an email change undone revokes the tokens they changed since (revokeTokensSince). */
    grantedById: uuid().references(() => user.id),
    grantedAt: ts(),
    createdById: uuid().references(() => user.id),
    createdAt: ts().notNull().defaultNow(),
    lastUsedAt: ts(),
    expiresAt: ts(),
    revokedAt: ts(),
  },
  (t) => [index().on(t.workspaceId)],
);

/**
 * An invitation of an email to a workspace (docs/decisions/0011-members-invites.md). The link in the email carries a
 * random secret; the row keeps its SHA-256, as tokens do. A live invite lets its address sign in with a code even
 * without an account: the account is created at the first sign-in. One live invite per address and workspace; resending
 * replaces its secret and time.
 */
export const invite = pgTable(
  "invite",
  {
    ...inWorkspace(),
    /** Lower-cased. */
    email: text().notNull(),
    /** member or admin. */
    role: text().notNull(),
    /** base64url SHA-256 of the link's secret. */
    hash: text().notNull().unique(),
    invitedById: uuid().references(() => user.id),
    createdAt: ts().notNull().defaultNow(),
    expiresAt: ts().notNull(),
    acceptedAt: ts(),
    /** Revoked by an admin, or declined by the invited person. */
    revokedAt: ts(),
  },
  (t) => [
    uniqueIndex("invite_live_index").on(t.workspaceId, t.email).where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    index().on(t.email),
  ],
);

/** Applied client transactions: replaying a txId changes nothing and gets the same answer. */
export const appliedTx = pgTable("applied_tx", {
  txId: uuid().primaryKey(),
  workspaceId: uuid().notNull(),
  lastSyncId: bigint({ mode: "number" }).notNull(),
  createdAt: ts().notNull().defaultNow(),
});
