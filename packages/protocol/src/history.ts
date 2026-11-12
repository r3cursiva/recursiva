// An issue's activity as the server answers it (GET /sync/history, POST /sync/feeds), and the helpers server and client
// share to build its entries from the log.
import { DESCRIPTION_FIELD, HISTORY_FIELDS, type Comment, type Document, type GithubEvent, type GithubLink, type Reaction } from "@rsva/schema/models";
import type { Via } from "./index.ts";

// ── Issue history: GET /sync/history/:issueId, JSON ─────────────────────────────────────────────────────────────

/** One change of the issue from the log: what the action set (`d`) and what those fields held before (`p`). */
export interface HistoryEntry {
  /** Log number. */
  id: number;
  a: "I" | "U" | "A";
  by: string | null;
  at: string;
  /** History fields only (HISTORY_FIELDS); an I entry (a project's history only) what the issue started with, CREATED_FIELDS. */
  d: Record<string, unknown>;
  p: Record<string, unknown>;
  /** What GitHub did: the cause of this change, or all of it when the state stayed. */
  gh?: GithubEvent;
  /** Where the change was made when not in the app or the API. */
  via?: Via;
  /** A move to another project (`d.projectId`): the key the issue left, "RSVA-3", as it was then (PLNR-448). */
  was?: string;
  /** A move's labels of the project it left that the new one has no label of that name for: they went. */
  dropped?: string[];
}

/**
 * What an opened issue needs beyond the snapshot, read in one transaction at log number `s`: the client applies deltas
 * after `s` on top. The description comes with it (one request on open instead of two); it moves to Yjs later.
 *
 * One page of the issue's activity: its newest entries, comments and reactions up to about a megabyte. `older` is set
 * when there is more before them; `?until=<older>` returns the page before (without the description).
 */
export interface IssueHistory {
  s: number;
  history: HistoryEntry[];
  comments: Comment[];
  reactions: Reaction[];
  /** The issue's pull requests and commits, all of them; empty on an older page. */
  github: GithubLink[];
  /** null: the issue has no description row yet (or this is an older page). */
  doc: Document | null;
  /** Server time older activity starts at, for the next page's `until`; null or absent when the page reaches the beginning. */
  older?: string | null;
}

/**
 * Answer of POST /sync/feeds: the activity of many issues at once, cut at `s`, for the browser to keep (PLNR-80). Issues
 * the request named that are not here are too long to prefetch, or gone: they load when opened.
 */
export interface IssueFeeds {
  s: number;
  feeds: KeptFeed[];
}

/** An issue's activity with the issue's id, as a browser keeps it. */
export type KeptFeed = IssueHistory & { id: string };

/** Issues one request to POST /sync/feeds may name. */
export const FEEDS_MAX_IDS = 500;

const HISTORY = new Set<string>(HISTORY_FIELDS);

/** A description change as a history entry: it says that the description changed, not what it says. */
export function descriptionEntry(id: number, by: string | null, at: string): HistoryEntry {
  return { id, a: "U", by, at, d: { [DESCRIPTION_FIELD]: true }, p: {} };
}

/** The history fields of an action's data; empty for a move in a column or a server-set time. Server and client share it. */
export function historyFields(d: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (d && typeof d === "object") for (const [k, v] of Object.entries(d)) if (HISTORY.has(k)) out[k] = v;
  return out;
}

/**
 * The key a move left and the labels it dropped, as the action's data says them: a move sets `projectId`, adds the old key
 * last to `formerKeys` and names in `dropped` the labels that went (no field of the row). The key is plain text: it stays
 * the same when that key goes to another project later. Nothing for any other action.
 */
export function movedFrom(d: unknown): { was?: string; dropped?: string[] } {
  const x = d as { projectId?: unknown; formerKeys?: unknown; dropped?: unknown } | null;
  if (!x || typeof x.projectId !== "string" || !Array.isArray(x.formerKeys)) return {};
  const was = x.formerKeys.at(-1);
  const dropped = Array.isArray(x.dropped) && x.dropped.length ? { dropped: x.dropped as string[] } : {};
  return { ...(typeof was === "string" ? { was } : {}), ...dropped };
}

/** What GitHub did, as the action's data says it, for a history entry; nothing for any other action. */
export function githubOf(d: unknown): { gh?: GithubEvent } {
  const gh = (d as { gh?: GithubEvent } | null)?.gh;
  return gh ? { gh } : {};
}
