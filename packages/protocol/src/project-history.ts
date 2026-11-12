// A project's history (PLNR-71): everything that happened to its issues, newest first, read off the log like an issue's
// activity. How much of it comes depends on the level the viewer picks; the server filters by it, so a coarse level
// does not download the field changes it would hide.
//
// Issue creations are drawn by the client from the issues it already has (createdAt, createdById), imported issues
// included, as the issue activity does. What a creation started with comes from its log action (PLNR-270): an `I` entry
// carrying only CREATED_FIELDS that hold something; an imported issue has none and reads as plain "created". Considered:
// working the starting values out on the client by undoing the loaded changes (no bytes at all), but an imported issue
// has no log before the import, and it would read its present values as the ones it was created with.
//
// At "everything" the answer also carries the project's own changes (PLNR-270): its workflow states and labels created,
// renamed, regrouped, made default, moved under another label and deleted, with who did it. State names drive the
// process rules (packages/policy), so a rename of one is part of the project's story.
import { DESCRIPTION_FIELD, HISTORY_FIELDS, type GithubEvent, type HistoryField } from "@rsva/schema/models";
import type { HistoryEntry } from "./history.ts";

/** How detailed the history is. The coarsest level of the page, Milestones, is drawn from cycles and asks for none of it. */
export type HistoryLevel = "outcomes" | "steps" | "everything";

export const HISTORY_LEVELS = ["outcomes", "steps", "everything"] as const satisfies readonly HistoryLevel[];

/**
 * The issue fields each level reads: outcomes need only moves between states (an issue's day folds into the chain of
 * them); steps add who took the issue, archiving, moves to another project and comments; everything adds every field and
 * the description.
 */
export const LEVEL_FIELDS: Record<HistoryLevel, readonly HistoryField[]> = {
  outcomes: ["stateId"],
  steps: ["stateId", "assigneeIds", "delegateId", "archivedAt", "deletedAt", "projectId"],
  everything: [...HISTORY_FIELDS, DESCRIPTION_FIELD],
};

/**
 * What GitHub did that each level shows when the state stayed (a move is shown for the move). Only these two come
 * without a move: a merge is an outcome, a pushed commit belongs to the full record.
 */
export const LEVEL_GITHUB: Record<HistoryLevel, readonly GithubEvent["verb"][]> = {
  outcomes: ["merged"],
  steps: ["merged"],
  everything: ["merged", "pushed"],
};

/** Whether a level shows comments. */
export const levelComments = (level: HistoryLevel): boolean => level !== "outcomes";

export function isHistoryLevel(v: unknown): v is HistoryLevel {
  return typeof v === "string" && (HISTORY_LEVELS as readonly string[]).includes(v);
}

/** Whether a level shows the project's own changes: its states and labels. */
export const levelSettings = (level: HistoryLevel): boolean => level === "everything";

/** What an issue's creation line says it started with; the rest of its row stays out of the answer. */
export const CREATED_FIELDS = ["stateId", "labelIds", "assigneeIds", "delegateId", "priority"] as const satisfies readonly HistoryField[];

/** The CREATED_FIELDS of a new issue's row that hold something: no nulls, no empty lists, no priority of none. */
export function createdFields(row: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!row || typeof row !== "object") return out;
  for (const k of CREATED_FIELDS) {
    const v = (row as Record<string, unknown>)[k];
    if (v === null || v === undefined || v === 0 || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}

/** The models of a project's own changes the Timeline shows. */
export type SettingModel = "WorkflowState" | "Label";

/** The fields of a state or label whose change the Timeline says; colors and order are left out. */
export const SETTING_FIELDS = ["name", "group", "isDefault", "parentId"] as const;

/** The SETTING_FIELDS of an action's data or before-values. */
export function settingFields(d: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (d && typeof d === "object") for (const k of SETTING_FIELDS) if (k in d) out[k] = (d as Record<string, unknown>)[k];
  return out;
}

/**
 * A change of one of the project's states or labels: created (`d` its fields), changed (`d` what changed, `p` what it
 * held) or deleted (`p.name` its name; deletions logged before 2026-11-04 have none).
 */
export interface ProjectSettingEntry {
  id: number;
  m: SettingModel;
  mid: string;
  a: "I" | "U" | "D";
  by: string | null;
  at: string;
  d: Record<string, unknown>;
  p: Record<string, unknown>;
}

/** A change of one of the project's issues: an issue history entry and the issue it belongs to. */
export interface ProjectHistoryEntry extends HistoryEntry {
  i: string;
}

/** Characters of a comment's Markdown the history shows: one line of it. */
export const COMMENT_EXCERPT = 200;

/** A comment on one of the project's issues: its start only, the history shows a line of it. */
export interface ProjectComment {
  id: string;
  i: string;
  by: string | null;
  at: string;
  /** The first COMMENT_EXCERPT characters of the body, Markdown as written. */
  x: string;
  /** The comment it replies to. */
  r: string | null;
}

/**
 * GET /sync/project-history?project=<id>&level=<level>[&until=<time>]: one page of the project's history at `level`, read
 * in one transaction at log number `s` (deltas after it come on top). `older` is set when there is more before the page;
 * `until=<older>` returns the page before.
 */
export interface ProjectHistory {
  s: number;
  history: ProjectHistoryEntry[];
  comments: ProjectComment[];
  /** The project's own changes; at "everything" only, absent at the other levels. */
  settings?: ProjectSettingEntry[];
  older?: string | null;
}

/**
 * The part of an entry a level shows: its fields that the level reads, or null when none are left. A creation is shown
 * by the client from the issue at every level; its entry only adds what it started with, so one with nothing left is none.
 */
export function atLevel<E extends HistoryEntry>(e: E, level: HistoryLevel): E | null {
  if (e.a === "A") return level === "outcomes" ? null : e;
  const keep = LEVEL_FIELDS[level];
  if (e.a === "I") {
    if (level === "outcomes") return null;
    const d: Record<string, unknown> = {};
    for (const k of keep) if (k in e.d) d[k] = e.d[k];
    return Object.keys(d).length ? { ...e, d, p: {} } : null;
  }
  // A move maps its state and labels as part of it: a level that does not show moves shows none of that either.
  if ("projectId" in e.d && !keep.includes("projectId")) return null;
  const d: Record<string, unknown> = {};
  const p: Record<string, unknown> = {};
  for (const k of keep) {
    if (!(k in e.d)) continue;
    d[k] = e.d[k];
    if (k in e.p) p[k] = e.p[k];
  }
  return Object.keys(d).length || (e.gh && LEVEL_GITHUB[level].includes(e.gh.verb)) ? { ...e, d, p } : null;
}
