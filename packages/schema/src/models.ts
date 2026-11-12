// Model rows as the client sees them: types and small constants. drizzle is imported for types only,
// so the browser gets a handful of bytes from this module.
import type { Role } from "@rsva/policy";
import type { attachment, comment, cycle, document, issue, label, member, project, reaction, user, workflowState, workspace } from "./db.ts";

export type { CycleSummary, DocJSON } from "./db.ts";

/**
 * True when A and B are the same type. `true satisfies Equal<Copy, Source>` ties a list or type that has to be written
 * out to the one it follows: a field added to one and not the other fails the compiler instead of a write or a screen.
 */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Server-only fields never reach the browser: external IDs are for import, and the workspace is known anyway. */
type Row<T extends { $inferSelect: unknown }> = Omit<T["$inferSelect"], "externalSource" | "externalId" | "workspaceId">;

export type Workspace = Row<typeof workspace>;
/**
 * A user as the workspace sees them: the account plus their role there. `role` is null for someone who left or was
 * removed while a client was open: their name still shows on their issues and comments, the members list leaves them out.
 */
export type User = Row<typeof user> & { role: MemberRole | null };
/** A member's role (ROLES in packages/policy); the owner's changes only by a transfer (not built yet). */
export type MemberRole = Role;
export type Member = Row<typeof member>;
export type Project = Row<typeof project>;
export type WorkflowState = Row<typeof workflowState>;
export type Label = Row<typeof label>;
export type Cycle = Row<typeof cycle>;
export type Issue = Row<typeof issue>;
export type Comment = Row<typeof comment>;
export type Reaction = Row<typeof reaction>;
export type Attachment = Row<typeof attachment>;
/**
 * An issue's description; `id` is the issue's id. `tx`: the transaction that wrote this text (null: none yet); missing in
 * a copy kept before it existed.
 */
export type Document = Omit<Row<typeof document>, "html"> & { tx?: string | null };

/** Models synced to the browser and the row type of each. */
export interface Models {
  User: User;
  Project: Project;
  WorkflowState: WorkflowState;
  Label: Label;
  Cycle: Cycle;
  Issue: Issue;
  Attachment: Attachment;
}

export type ModelName = keyof Models;

/**
 * Models of one issue that are not in the snapshot: loaded with the issue's history when it is opened, then kept live
 * by deltas. Their log actions always carry `issueId` in `d`, so a client routes them without knowing the row.
 */
export interface IssueModels {
  Comment: Comment;
  Reaction: Reaction;
  Document: Document;
  GithubLink: GithubLink;
}

export type IssueModelName = keyof IssueModels;

/** Issue fields a client sets and the history shows, in the history's order: the start of both lists below. */
const ISSUE_FIELDS = [
  "title",
  "stateId",
  "priority",
  "assigneeIds",
  "delegateId",
  "labelIds",
  "parentId",
  "blockedByIds",
  "relatedIds",
  "duplicateOfId",
  "startDate",
  "dueDate",
  "cycleId",
] as const satisfies readonly (keyof Issue)[];

/**
 * Issue fields the history shows. Moves in a column (sortOrder) and server-set times are not history. `projectId`: a move
 * to another project (PLNR-448); its entry also says the key it left (movedFrom in packages/protocol).
 */
export const HISTORY_FIELDS = [...ISSUE_FIELDS, "archivedAt", "deletedAt", "projectId"] as const satisfies readonly (keyof Issue)[];

/** A description change in the history: its entry says only that the description changed, never the text. */
export const DESCRIPTION_FIELD = "description";

export type HistoryField = (typeof HISTORY_FIELDS)[number] | typeof DESCRIPTION_FIELD;

/** Longest comment body, characters of Markdown. */
export const COMMENT_MAX = 65_536;

/** Longest issue title, in UTF-16 units as an input's maxLength counts them. */
export const TITLE_MAX = 500;

/** Issue fields a client may change in a transaction. The server sets the rest. */
export const ISSUE_EDITABLE = [...ISSUE_FIELDS, "sortOrder"] as const satisfies readonly (keyof Issue)[];

export type IssuePatch = Partial<Pick<Issue, (typeof ISSUE_EDITABLE)[number]>>;

/**
 * The fields of a new issue nobody set: what the server's defaults give, for a row the client builds before its echo.
 * Every field a client may set but the title, the state and the order in a column, which a new issue always gets.
 */
export const blankIssueFields = (): Pick<Issue, Exclude<(typeof ISSUE_EDITABLE)[number], "title" | "stateId" | "sortOrder">> => ({
  priority: 0,
  assigneeIds: [],
  delegateId: null,
  labelIds: [],
  parentId: null,
  blockedByIds: [],
  relatedIds: [],
  duplicateOfId: null,
  startDate: null,
  dueDate: null,
  cycleId: null,
});

/**
 * Archive and delete, changed by an update but not given at creation. As with a project's archive, the client sends any
 * time or null and the server sets the time. Only completed or cancelled issues are archived (Plane's rule); only their
 * creator or an admin deletes or restores one.
 */
export type IssueLifecycle = Partial<Pick<Issue, "archivedAt" | "deletedAt">>;

/** The people an issue can be assigned to, by name: everyone but bots. */
export const assignable = <U extends Pick<User, "kind" | "name">>(users: Iterable<U>): U[] => [...users].filter((u) => u.kind !== "bot").sort((a, b) => a.name.localeCompare(b.name));

/** In the lists: neither archived nor deleted. */
export const isLiveIssue = (i: IssueLifecycle): boolean => !i.archivedAt && !i.deletedAt;
/** Days an issue stays in the trash before the server deletes it for good (RSVA-457; Linear's and Plane's 30). */
export const TRASH_DAYS = 30;
/**
 * `projectId` moves the issue to another project of the workspace (PLNR-448): the server gives it the next number there,
 * keeps its old key as a former key and maps what belongs to a project (moveState, moveLabels; its cycle is cleared). An
 * update only: a new issue names its project outside `set`.
 */
export type IssueUpdate = IssuePatch & IssueLifecycle & { projectId?: string };

/**
 * The priorities in Plane's order, urgent first and none last: the code the database keeps (`issue.priority`), the word
 * of the query and the API, the name people read. Every screen, the server's messages and the TUI name them from here.
 */
export const PRIORITIES = [
  { code: 1, keyword: "urgent", name: "Urgent" },
  { code: 2, keyword: "high", name: "High" },
  { code: 3, keyword: "medium", name: "Medium" },
  { code: 4, keyword: "low", name: "Low" },
  { code: 0, keyword: "none", name: "No priority" },
] as const;
export type Priority = (typeof PRIORITIES)[number]["code"];
/** The priority that notifies and draws the signal colour. */
export const URGENT = PRIORITIES[0].code;

/** Code 0, the priority an issue has until someone sets one. */
const NO_PRIORITY = PRIORITIES.find((p) => p.code === 0)!;

/** The name of a priority code; a code the database does not hold reads as no priority. */
export const priorityName = (code: number): string => (PRIORITIES.find((p) => p.code === code) ?? NO_PRIORITY).name;

/** A priority's tooltip: "Priority: High", and "No priority" alone rather than "Priority: No priority". */
export const priorityTitle = (code: number): string => (code === NO_PRIORITY.code ? NO_PRIORITY.name : `Priority: ${priorityName(code)}`);

/** Plane's state groups, in the order lists show them. Every project has at least one state and exactly one default. */
export const STATE_GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;
export type StateGroup = (typeof STATE_GROUPS)[number];

/** Most issues one issue may list as its blockers or as related: a list, not a dependency graph. */
export const RELATIONS_MAX = 50;

/**
 * Relations as the two ends see them: one stored field each way. "blocks" and "duplicates" are the other end of
 * `blockedByIds` and `duplicateOfId`; related reads the same from both ends.
 */
export const RELATION_TYPES = ["blockedBy", "blocks", "related", "duplicateOf", "duplicates"] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

// ── Moving an issue to another project (PLNR-448) ─────────────────────────────────────────────────────────────
// The rules are here so the browser shows a move at once exactly as the server will store it, and the server maps what a
// caller left out (the agent API, a change sent against the project an issue has just left) by the same rules.

/** Two names that are one for a move: the same letters, case and surrounding spaces aside. */
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type StateLike = Pick<WorkflowState, "id" | "name" | "group" | "position" | "isDefault">;

/**
 * The state an issue takes in the project it moves to: the one of the same name (exactly, else ignoring case), else one of
 * the same group (the default if it is of that group, else the first), else the default. `from` is its state now (undefined: unknown, the default); `to` the target's
 * states, which always hold a default.
 */
export function moveState(from: Pick<WorkflowState, "name" | "group"> | undefined, to: readonly StateLike[]): string {
  const ordered = [...to].sort((a, b) => a.position - b.position);
  const pick =
    (from && (ordered.find((s) => s.name === from.name) ?? ordered.find((s) => sameName(s.name, from.name)) ?? ordered.find((s) => s.group === from.group && s.isDefault) ?? ordered.find((s) => s.group === from.group))) ??
    ordered.find((s) => s.isDefault) ??
    ordered[0];
  if (!pick) throw new Error("a project without states");
  return pick.id;
}

type LabelLike = Pick<Label, "id" | "name" | "projectId">;

/**
 * The labels an issue keeps in the project `toProjectId`: workspace labels and the target's own stay, a label of another
 * project becomes the target's label of the same name, else it is dropped (`dropped`, for the move's line in the
 * history). `labels` are the issue's labels as rows, in its order; an id with no row is dropped too. Each label once.
 */
export function moveLabels(labelIds: readonly string[], labels: ReadonlyMap<string, LabelLike>, toProjectId: string, to: readonly LabelLike[]): { labelIds: string[]; dropped: string[] } {
  const out: string[] = [];
  const dropped: string[] = [];
  for (const id of labelIds) {
    const l = labels.get(id);
    const mapped = !l ? undefined : l.projectId === null || l.projectId === toProjectId ? l.id : to.find((t) => t.projectId === toProjectId && sameName(t.name, l.name))?.id;
    if (mapped === undefined) dropped.push(id);
    else if (!out.includes(mapped)) out.push(mapped);
  }
  return { labelIds: out, dropped };
}

type RelationFields = Pick<Issue, "id" | "blockedByIds" | "relatedIds" | "duplicateOfId">;

/**
 * The issue edits that give two issues the relation `type` (null: none). A pair has one relation, stored on one end, so
 * whatever the pair had goes first; "blocks" and "duplicates" are written on `b` as its "blocked by" and "duplicate of".
 * The end that only loses a relation comes first, so the server sees the old relation gone before the new one is
 * checked. The browser and the agent API both build their ops from this.
 */
export function relationPatches(a: RelationFields, b: RelationFields, type: RelationType | null): { id: string; set: IssuePatch }[] {
  if (a.id === b.id) return [];
  const next = (row: RelationFields, other: string): RelationFields => ({
    ...row,
    blockedByIds: row.blockedByIds.filter((x) => x !== other),
    relatedIds: row.relatedIds.filter((x) => x !== other),
    duplicateOfId: row.duplicateOfId === other ? null : row.duplicateOfId,
  });
  const na = next(a, b.id);
  const nb = next(b, a.id);
  const [holder, other] = type === "blocks" || type === "duplicates" ? [nb, a.id] : [na, b.id];
  if (type === "blockedBy" || type === "blocks") holder.blockedByIds = [...holder.blockedByIds, other];
  else if (type === "related") holder.relatedIds = [...holder.relatedIds, other];
  else if (type) holder.duplicateOfId = other;
  const patch = (before: RelationFields, after: RelationFields) => {
    const set: IssuePatch = {};
    if (before.blockedByIds.join() !== after.blockedByIds.join()) set.blockedByIds = after.blockedByIds;
    if (before.relatedIds.join() !== after.relatedIds.join()) set.relatedIds = after.relatedIds;
    if (before.duplicateOfId !== after.duplicateOfId) set.duplicateOfId = after.duplicateOfId;
    return Object.keys(set).length ? { id: before.id, set } : null;
  };
  const pa = patch(a, na);
  const pb = patch(b, nb);
  const out = holder === na ? [pb, pa] : [pa, pb];
  return out.filter((p) => p !== null);
}

/** What a link is, read off its address (GitHub pull requests and commits show as such), or an uploaded file. */
export const ATTACHMENT_KINDS = ["link", "github_pr", "github_commit", "file"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];
/** A link of some kind (an address, a pull request, a commit), not an uploaded file: what `has:link` counts (RSVA-174). */
export const isLinkKind = (kind: string): boolean => kind !== "file";

/** Longest link address, characters. */
export const URL_MAX = 2048;

/** Link fields a client sets; `kind` is derived from the URL on both ends. */
export type LinkCreate = Pick<Attachment, "issueId" | "url" | "title">;
/** A file on an issue: an uploaded blob of the workspace and its name. The server fills the URL, size and type from the blob. */
export type FileCreate = { issueId: string; sha256: string; title: string };
export type AttachmentCreate = LinkCreate | FileCreate;
/** A link's address and title, or a file's name (its address is its content). */
export type AttachmentPatch = Partial<Pick<Attachment, "url" | "title">>;

export const isFileCreate = (set: AttachmentCreate): set is FileCreate => "sha256" in set;

// ── Files (PLNR-50) ─────────────────────────────────────────────────────────────────────────────────────────────

/** A file's id: the SHA-256 of its bytes, in lower-case hex. */
export const SHA256 = /^[0-9a-f]{64}$/;
/** Largest file, bytes. */
export const FILE_MAX = 25 * 2 ** 20;
/** Most files one issue may have: a list in the panel, not a file share. */
export const FILES_PER_ISSUE_MAX = 100;
/**
 * Raster image types: the only files served inline and drawn as images. The server sets one only when the bytes start
 * like that type (apps/server/src/files/sniff.ts); SVG is not here, it can carry script.
 */
export const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** Where a workspace's file is served: same origin, behind the workspace's access check, cached forever (content-addressed). */
export const filePath = (slug: string, sha256: string): string => `/files/${slug}/${sha256}`;

// ── Profile pictures (PLNR-244) ────────────────────────────────────────────────────────────────────────────────

/** A picture's side, pixels: the browser cuts and encodes it so; a 40 px avatar on a 3x screen needs 120. */
export const PICTURE_SIDE = 256;
/** Largest picture, bytes: a 256 px WebP of a photo is 10–25 KB, a JPEG somewhat more. */
export const PICTURE_MAX = 256 * 2 ** 10;
/** Where a person's picture is served: same origin, to whoever shares a workspace with them, cached forever. */
export const picturePath = (sha256: string): string => `/pictures/${sha256}`;

/**
 * A generated avatar (PLNR-366): nine whole numbers and a tone's index after a version, "c1:5,40,60,-12,82,2,40,30,50,1".
 * packages/ui/src/lib/creature.ts writes and draws it, bringing each number into its range; the server keeps any string
 * of this form.
 */
export const CREATURE = /^c1:-?\d{1,3}(?:,-?\d{1,3}){9}$/;

/** A file path of filePath's form, else null. Image nodes and file attachments point only at such paths. */
export function readFilePath(path: string): { slug: string; sha256: string } | null {
  const m = /^\/files\/([a-z0-9-]{3,32})\/([0-9a-f]{64})$/.exec(path);
  return m && WORKSPACE_SLUG.test(m[1]!) ? { slug: m[1]!, sha256: m[2]! } : null;
}

/** A commit's hash is shown this long: on every screen, in the CLI and in a commit link's short name. */
export const SHA_SHOWN = 7;

const GITHUB = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|commit)\/(\d+|[0-9a-f]{7,40})(?:[/?#].*)?$/i;

/**
 * A link's kind and short name: "owner/repo#12" for a pull request, "owner/repo@abc1234" for a commit, null for any other
 * address. The client shows the short name when the link has no title; the server stores the kind.
 */
export function readLink(url: string): { kind: AttachmentKind; ref: string | null } {
  const m = GITHUB.exec(url);
  if (!m) return { kind: "link", ref: null };
  const pr = m[2]!.toLowerCase() === "pull";
  if (pr && !/^\d+$/.test(m[3]!)) return { kind: "link", ref: null };
  return pr ? { kind: "github_pr", ref: `${m[1]}#${m[3]}` } : { kind: "github_commit", ref: `${m[1]}@${m[3]!.slice(0, SHA_SHOWN).toLowerCase()}` };
}

/**
 * A link address as stored: trimmed, http or https only (no javascript:, data: or file:), parsed and re-serialised so the
 * client and the server agree on it. null for anything else.
 */
export function cleanUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t || t.length > URL_MAX || /[\s\u0000-\u001f]/.test(t)) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.username || u.password) return null;
  const out = u.href;
  return out.length > URL_MAX ? null : out;
}

// ── GitHub (PLNR-96) ────────────────────────────────────────────────────────────────────────────────────────────

export type PullState = "open" | "draft" | "merged" | "closed";
export type PullReview = "approved" | "changes" | "required";
export type PullChecks = "pass" | "fail" | "run";

/**
 * A pull request (`kind` "pull") or a commit on an issue, one row per issue: what the panel draws. A pull request on two
 * issues is two rows with their own `closing`. `closing` false reads as Linked: merging it leaves the issue's state.
 */
export interface GithubLink {
  id: string;
  issueId: string;
  kind: "pull" | "commit";
  /** owner/name. */
  repo: string;
  /** The pull request's number; null for a commit. */
  number: number | null;
  /** The commit; null for a pull request. */
  sha: string | null;
  /** The pull request's title or the first line of the commit message. */
  title: string;
  state: PullState | null;
  head: string | null;
  base: string | null;
  /** Null for a commit, and for a merged or closed pull request nobody reviewed. */
  review: PullReview | null;
  checks: PullChecks | null;
  /** How many checks fail. */
  failing: number;
  /** GitHub login. */
  author: string;
  /** A bot account: drawn with the agent's square avatar. */
  authorBot: boolean;
  /** The last change of the pull request, or the commit's time. */
  at: string;
  closing: boolean;
}

/**
 * What GitHub did, carried in an Issue U action's `d.gh` beside the state move it caused, or alone when the state stayed.
 * The feed draws the line from it; a client drops it from the row. `verb` says what happened to the pull request, commit
 * or branch; a branch gives its name as `title`.
 */
export interface GithubEvent {
  verb: "branch" | "opened" | "ready" | "merged" | "pushed";
  repo: string;
  number: number | null;
  sha: string | null;
  title: string;
  state: PullState | null;
  /** GitHub login. */
  by: string;
  closing: boolean;
  /** When the server took it: an action of `gh` alone carries no time of its own. */
  at: string;
}

export const pullUrl = (l: Pick<GithubLink, "repo" | "number">): string => `https://github.com/${l.repo}/pull/${l.number}`;
export const commitUrl = (l: Pick<GithubLink, "repo" | "sha">): string => `https://github.com/${l.repo}/commit/${l.sha}`;

/** Who GitHub's changes are by: a user with this address, in no workspace's members, sent in the snapshot of a workspace with a bound repository. */
export const GITHUB_BOT = { email: "github-bot@rsva.invalid", name: "GitHub" } as const;
/** Who the app's own changes are by: a cycle that completes itself and moves its open issues on (PLNR-64). */
export const APP_BOT = { email: "app-bot@rsva.invalid", name: "recursiva" } as const;
export type Bot = typeof GITHUB_BOT | typeof APP_BOT;
export const BOTS: readonly Bot[] = [GITHUB_BOT, APP_BOT];

const BRANCH_MAX = 60;
/** Cyrillic to Latin, so a Russian title still gives a readable branch: each letter's Latin by position, space-separated. */
const CYRILLIC = "абвгдеёжзийклмнопрстуфхцчшщъыьэюяєіїґў";
const LATIN = "a b v g d e yo zh z i y k l m n o p r s t u f kh ts ch sh shch  y  e yu ya ye i yi g u";

/**
 * The issue's git branch: its key in lower case, then its title as a slug, cut at a word so it stays under 60 characters.
 * Whatever in the title reads as a key goes: a key in a branch name closes its issue when the pull request merges, and
 * "Follow-up to OPTO-12" must not close OPTO-12.
 */
export function branchName(key: string, title: string): string {
  const k = key.toLowerCase();
  const latin = LATIN.split(" ");
  const slug = [...title.toLowerCase()]
    .map((c) => {
      const at = CYRILLIC.indexOf(c);
      return at < 0 ? c : latin[at];
    })
    .join("")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(new RegExp(`(^|-)${ISSUE_KEY}(?=-|$)`, "gi"), "")
    .replace(/^-|-$/g, "");
  const room = BRANCH_MAX - k.length - 1;
  if (!slug || room <= 0) return k;
  if (slug.length <= room) return `${k}-${slug}`;
  const cut = slug.slice(0, room);
  const word = slug[room] === "-" ? cut : cut.slice(0, cut.lastIndexOf("-") + 1 || room);
  return `${k}-${word.replace(/-$/, "")}`;
}

/** Completed or cancelled: the issue is closed (it has a completion time) and may be archived. */
export const isClosedGroup = (group: string | null | undefined): boolean => group === "completed" || group === "cancelled";

/** Work still waiting to be done: live, and in a state that is neither completed nor cancelled. */
export const isOpenIssue = (i: IssueLifecycle, group: string | null | undefined): boolean => isLiveIssue(i) && !isClosedGroup(group);

/** The state a new issue gets when nothing chooses one: the project's default state, else its first. */
export function defaultState<S extends Pick<WorkflowState, "isDefault">>(projectStates: readonly S[]): S | undefined {
  return projectStates.find((s) => s.isDefault) ?? projectStates[0];
}

/**
 * Plane's started group can hold several states (In Progress, In Review, Approved): by position, the first is work in
 * progress, the second waits for review, any later one is approved. Glyphs (PLNR-24) and the inbox (PLNR-26) read it.
 */
export type StartedStage = "progress" | "review" | "approved";

/** The stage of a started state among its project's states (in position order); undefined for any other group. */
export function startedStage(projectStates: readonly Pick<WorkflowState, "id" | "group">[], stateId: string): StartedStage | undefined {
  const started = projectStates.filter((s) => s.group === "started");
  const at = started.findIndex((s) => s.id === stateId);
  if (at < 0) return undefined;
  return at === 0 ? "progress" : at === 1 ? "review" : "approved";
}

/** A UUID (any version) as Postgres writes it, lower case, for a larger pattern: a mention, a pin, a Telegram button. */
export const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A whole string that is a UUID, in either case: checked before a value reaches a uuid column, where Postgres would fail the cast. */
export const UUID = new RegExp(`^${UUID_PATTERN}$`, "i");

/** Project key, the start of every issue key: a letter, then letters and digits, as in Plane (up to 12). */
export const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,11}$/;

/**
 * An issue key, "PLNR-27", as a source for a larger pattern: PROJECT_KEY, a dash, a number without a leading zero and of
 * at most ten digits (an int4 column holds up to 2147483647). Upper case; with the "i" flag a pattern takes any case.
 * What stands around a key is the larger pattern's to say: text (packages/editor issue-ref.ts), a branch name, an address.
 */
export const ISSUE_KEY = `${PROJECT_KEY.source.slice(1, -1)}-[1-9][0-9]{0,9}`;
const WHOLE_ISSUE_KEY = new RegExp(`^${ISSUE_KEY}$`, "i");

/** An issue's number, or null above what an int4 column holds (Postgres would fail the query). */
function issueNumber(digits: string): number | null {
  const n = Number(digits);
  return n <= 2 ** 31 - 1 ? n : null;
}

/** An issue's key from its project's key and its number. */
export const issueKey = (projectKey: string, number: number) => `${projectKey}-${number}`;

/**
 * A whole string that is an issue key, in any case ("plnr-27" is what a person may type): its project key in upper case,
 * as keys are stored, and its number; null for anything else, a number no issue can have included.
 */
export function parseIssueKey(s: string): { projectKey: string; number: number } | null {
  if (!WHOLE_ISSUE_KEY.test(s)) return null;
  const at = s.lastIndexOf("-");
  const number = issueNumber(s.slice(at + 1));
  return number === null ? null : { projectKey: s.slice(0, at).toUpperCase(), number };
}

/** The issue's own page in the app, the link to share: /:workspace/browse/KEY-N. */
export const issuePath = (slug: string, key: string) => `/${slug}/browse/${key}`;

/** A project's cycle page: /:workspace/projects/KEY/cycles/N. */
export const cyclePath = (slug: string, projectKey: string, n: number) => `/${slug}/projects/${projectKey}/cycles/${n}`;

/**
 * A person's own settings page with a workspace open beside it: /:workspace/settings/…, the link an email or a chat sends.
 * The notification tabs are sub-pages.
 */
export const settingsPath = (slug: string, page: "notifications" | "notifications/email" | "notifications/telegram") => `/${slug}/settings/${page}`;

/**
 * The keys an issue moved out of project `p` under number `number` may have kept (PLNR-448): a move keeps the key the
 * project had then, so a link with any key of the project, now or before, looks for each. Without a project (the key is no
 * project's any more), the typed key only.
 */
export function movedKeysOf(projectKey: string, number: number, p: { key: string; formerKeys: readonly string[] } | undefined): string[] {
  return [...new Set([projectKey, ...(p ? [p.key, ...p.formerKeys] : [])])].map((k) => issueKey(k, number));
}

/** Projects by key, a former key too: a link or a reference made before a rename still finds its project. */
export function projectsByKey<P extends { key: string; formerKeys: readonly string[] }>(projects: readonly P[]): Map<string, P> {
  const out = new Map<string, P>();
  for (const p of projects) for (const k of p.formerKeys) out.set(k, p);
  for (const p of projects) out.set(p.key, p);
  return out;
}

/** Longest name of a workspace, project, state or label, in UTF-16 units as an input's maxLength counts them. */
export const NAME_MAX = 80;

/**
 * A workspace, project, state or label name, or an issue title, as it is stored: any visible character stays (letters of any script,
 * punctuation, emoji), what cannot be seen goes. Line breaks and tabs become spaces, runs of spaces one, bidi controls
 * (text that reads otherwise than it is written) and zero-width characters are dropped, combining marks stop at four
 * on a letter (no "zalgo" towers over the row), lone surrogates become U+FFFD, the result is NFC. ZWJ and ZWNJ stay:
 * emoji sequences and Persian and Indic words need them. Client and server clean alike, so a local write and the
 * stored row agree; an empty result is no name.
 */
export function cleanName(raw: string): string {
  return raw
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
    .normalize("NFC")
    .replace(/[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "")
    .replace(/(\p{M}{4})\p{M}+/gu, "$1")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
}

/** Tile tones of projects and workspaces (packages/ui letter-tile); without one a tile gets a tone from its key or name. */
export const TILE_COLORS = ["ink", "slate", "signal", "umber", "ochre", "olive", "forest", "teal", "cobalt", "indigo", "plum", "rose"] as const;
export type TileColor = (typeof TILE_COLORS)[number];

/** The workspace as the client sees it: the snapshot's first line and the switcher's mark. */
export type WorkspaceInfo = Pick<Workspace, "id" | "slug" | "name" | "color" | "memberRights" | "triagers">;
/** Workspace fields a client may change. The slug is fixed: links, local copies and tokens use it. Member rights: a signed-in admin's. */
export type WorkspacePatch = Partial<Pick<Workspace, "name" | "color" | "memberRights" | "triagers">>;
/** Roles an admin can give: the owner is set by a transfer, guests cannot open anything yet. */
export const ASSIGNABLE_ROLES = ["member", "admin"] as const satisfies readonly Role[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
/** Workspace address: 3–32 lower-case letters, digits and inner hyphens. */
export const WORKSPACE_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;
/** First path segments the server answers itself; every other path is an app route (the shell, also from the Service Worker). */
export const SERVER_PATHS = ["api", "auth", "files", "healthz", "notify", "pictures", "sync", "ws"] as const;
/**
 * The compressed copies of a built file of the app, each beside it under the file's name and a suffix: the web build
 * writes them (apps/web/build/shell.ts), the server serves the smallest one the browser accepts (apps/server/src/static.ts).
 * The encoding as Accept-Encoding names it.
 */
export const PRECOMPRESSED = [
  ["br", ".br"],
  ["zstd", ".zst"],
  ["gzip", ".gz"],
] as const;
/** First path segments the app and the server use: a workspace may not take them (new workspaces and imports alike). */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  ...SERVER_PATHS, "join", "new", "settings", "assets", "admin", "app", "help", "invite", "invites", "login",
  "logout", "me", "signin", "sign-in", "signup", "sign-up", "static", "www",
]);
/** Project fields a client may change. `archivedAt`: the server sets the time, the client sends any time or null. */
export type ProjectPatch = Partial<Pick<Project, "name" | "key" | "color" | "archivedAt" | "cycleRollover">>;
/** A new project; its workflow states come in the same transaction (DEFAULT_WORKFLOW from the app). */
export type ProjectCreate = Pick<Project, "name" | "key"> & { color?: TileColor | null };
export type StatePatch = Partial<Pick<WorkflowState, "name" | "group" | "position" | "isDefault" | "onlyPeople">>;
/** `isDefault` only for a new project's first state: later the default moves by updates (StatePatch). */
export type StateCreate = Pick<WorkflowState, "projectId" | "name" | "group" | "position"> & { isDefault?: boolean; onlyPeople?: boolean };

/** A new project's workflow, Plane's defaults; the first is the default state. The wizard and New project both use it. */
export const DEFAULT_WORKFLOW: readonly { name: string; group: StateGroup; onlyPeople?: true }[] = [
  { name: "Backlog", group: "backlog" },
  /** "Start this": people approve work into Todo, agents do not (packages/policy, PEOPLE_STATES). */
  { name: "Todo", group: "unstarted", onlyPeople: true },
  { name: "In Progress", group: "started" },
  { name: "Done", group: "completed" },
  { name: "Cancelled", group: "cancelled" },
];
export type LabelPatch = Partial<Pick<Label, "name" | "color" | "parentId" | "position" | "onlyPeople">>;
/** New labels belong to a project; workspace labels come only from imports for now. */
export type LabelCreate = Pick<Label, "name" | "color" | "position"> & { projectId: string; parentId?: string | null; onlyPeople?: boolean };

// ── Cycles (PLNR-63) ────────────────────────────────────────────────────────────────────────────────────────────

/** Cycle fields a client may change. `completedAt`: the server sets the time (and freezes the summary), the client sends any time. */
export type CyclePatch = Partial<Pick<Cycle, "name" | "description" | "startDate" | "endDate" | "leadId">> & { completedAt?: string };
export type CycleCreate = Pick<Cycle, "projectId" | "name"> & Partial<Pick<Cycle, "description" | "startDate" | "endDate" | "leadId">>;

/** Longest cycle description, characters: a line or two under the name, not a document. */
export const CYCLE_DESCRIPTION_MAX = 2000;

/**
 * Where a cycle is on the calendar of `today` (YYYY-MM-DD, the viewer's day): a draft has no dates; an ended cycle is past
 * its last day and not completed yet, so someone still decides where its open issues go.
 */
export type CycleStatus = "draft" | "upcoming" | "active" | "ended" | "completed";

export function cycleStatus(c: Pick<Cycle, "startDate" | "endDate" | "completedAt">, today: string): CycleStatus {
  if (c.completedAt) return "completed";
  if (!c.startDate || !c.endDate) return "draft";
  if (today < c.startDate) return "upcoming";
  return today > c.endDate ? "ended" : "active";
}

/** Two cycles' days meet (both days included); drafts meet nothing. */
export function cyclesOverlap(a: Pick<Cycle, "startDate" | "endDate">, b: Pick<Cycle, "startDate" | "endDate">): boolean {
  return !!(a.startDate && a.endDate && b.startDate && b.endDate) && a.startDate <= b.endDate! && b.startDate <= a.endDate!;
}
