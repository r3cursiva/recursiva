// Import bundle: NDJSON, one object per line. Objects reference each other by the source's external IDs (`ext`),
// so a connector never needs our UUIDs and a repeated import finds what was already moved.
// First version of the format (prototype): JSON Schema, dry run and rollback come in the "Agents and import" stage.
import type { Role } from "@rsva/policy";

export interface Ref {
  ext: string;
}

export interface BundleUser {
  m: "User";
  ext: string;
  email: string;
  name: string;
  kind?: "human" | "agent";
  /**
   * Workspace role. Omitted: member (owner for the header's owner). null: a known user (an author) who is not a member,
   * for example one deactivated in the source; the user is imported, the membership is not.
   */
  role?: Role | null;
}

export interface BundleProject {
  m: "Project";
  ext: string;
  key: string;
  name: string;
  createdAt?: string;
  archivedAt?: string | null;
}

export interface BundleState {
  m: "State";
  ext: string;
  project: Ref;
  name: string;
  group: "backlog" | "unstarted" | "started" | "completed" | "cancelled";
  color: string;
  position: number;
  isDefault?: boolean;
}

export interface BundleLabel {
  m: "Label";
  ext: string;
  project: Ref | null;
  parent?: Ref | null;
  name: string;
  color: string;
  position?: number;
}

export interface BundleIssue {
  m: "Issue";
  ext: string;
  project: Ref;
  number: number;
  title: string;
  /** Order in the source (greater is lower); the import turns it into a fractional index. */
  position?: number;
  state: Ref;
  priority: 0 | 1 | 2 | 3 | 4;
  assignees?: Ref[];
  labels?: Ref[];
  parent?: Ref | null;
  /** Relations, stored on this end (packages/schema/src/db.ts). Omitted keeps what the workspace has. */
  blockedBy?: Ref[];
  related?: Ref[];
  duplicateOf?: Ref | null;
  startDate?: string | null;
  dueDate?: string | null;
  createdBy?: Ref | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  archivedAt?: string | null;
  /**
   * Markdown (the dialect of packages/editor): what agents and connectors write. Preferred over descriptionHtml. A mention
   * names a bundle user by ext, `[@Name](mention:<user ext>)` (in descriptionHtml `<mention-component user=<ext>>`); one
   * whose ext the bundle lacks imports as the text "@Name".
   */
  description?: string;
  /** HTML as Plane stores it; converted on import. For connectors that cannot convert themselves. */
  descriptionHtml?: string;
}

/** A comment; `parent` makes it a reply (one level deep: the parent is a top-level comment of the same issue). */
export interface BundleComment {
  m: "Comment";
  ext: string;
  issue: Ref;
  parent?: Ref | null;
  /** Unknown or removed authors import as null ("someone"). */
  author?: Ref | null;
  /** Markdown. Connectors convert from their source format; Markdown is what agents and the composer write. Mentions as in BundleIssue.description. */
  body: string;
  createdAt?: string;
  editedAt?: string | null;
  /**
   * A deleted comment kept as a tombstone (empty body) because live replies hang under it; the source's deletion time.
   * Omitted keeps whatever the workspace has.
   */
  deletedAt?: string | null;
}

/** An emoji reaction to an issue (no `comment`) or to one of its comments. */
export interface BundleReaction {
  m: "Reaction";
  ext: string;
  issue: Ref;
  comment?: Ref | null;
  user: Ref;
  emoji: string;
  createdAt?: string;
}

/** A link on an issue; a GitHub pull request or commit address is recognised as one. Not an http(s) address: skipped. */
export interface BundleLink {
  m: "Link";
  ext: string;
  issue: Ref;
  url: string;
  title?: string;
  createdBy?: Ref | null;
  createdAt?: string;
}

/**
 * A person subscribed to an issue (PLNR-28): they hear its state changes and comments whether involved or not. Imported
 * as their Subscribe, unless they already chose here.
 */
export interface BundleSubscription {
  m: "Subscription";
  ext: string;
  issue: Ref;
  user: Ref;
}

/**
 * A file the workspace gets. Its bytes are not in the bundle: `import --files <dir>` reads them from `<dir>/<sha256>`. With
 * `issue` it is an attachment there, named `name`; without, only text uses it (`![…](/files/<slug>/<sha256>)`).
 */
export interface BundleFile {
  m: "File";
  ext: string;
  sha256: string;
  name: string;
  /** The source's type, a hint: what the file is served as is decided from its bytes (apps/server/src/files/sniff.ts). */
  mime?: string;
  issue?: Ref | null;
  createdBy?: Ref | null;
  createdAt?: string;
}

export type BundleLine = BundleUser | BundleProject | BundleState | BundleLabel | BundleIssue | BundleComment | BundleReaction | BundleLink | BundleSubscription | BundleFile;

/** Bundle header: the first line. */
export interface BundleHeader {
  m: "Bundle";
  version: 1;
  source: string;
  workspace: { slug: string; name: string };
  /** External ID of the person who owns the workspace after import. */
  owner: Ref;
}

/** One JSON object per line, each line ended by a newline: how a bundle (or a snapshot) is written. */
export function toNdjson(lines: readonly unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** The objects of an NDJSON text; empty lines (the last newline, a blank line) are skipped. */
export function parseNdjson<T = unknown>(text: string): T[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}
