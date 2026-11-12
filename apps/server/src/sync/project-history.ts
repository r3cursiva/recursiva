// A project's history (PLNR-71): GET /sync/project-history?project=<id>&level=<level>[&until=<time>].
//
// The log is the record, as for an issue's activity (sync/history.ts): changes of the project's issues with their
// stored before-values, found through the (model_id, id) index for each of the project's issues, and the comments from
// their table. The level is applied here, in SQL: at "outcomes" only moves between states leave the database, so the
// coarse view of a busy project costs a fraction of the bytes of the detailed one. Comments come as their first
// COMMENT_EXCERPT characters, the history shows one line of each.
//
// What an issue was created with comes from its Issue I action, CREATED_FIELDS only (PLNR-270). At "everything" the
// project's own changes come too: Label and WorkflowState actions of its states and labels, deleted ones included. A
// deleted one has no row to say whose it was; its creation and, since 2026-11-04, its deletion name the project in the
// action's data, and those few actions are found by reading the workspace's settings actions, not its whole log.
//
// Considered (2026-10-30): the whole log of the project sent once and filtered on the client (every level switch
// instant, but the first answer is all field changes and comment texts, most of which the default level hides); a table
// of daily totals kept by the write pipeline (a second record to keep in step with the log, and it answers only the
// summaries, not the rows). Pages by bytes, like the issue activity, keep the first answer small whatever the project's
// age.
import {
  COMMENT_EXCERPT,
  LEVEL_FIELDS,
  LEVEL_GITHUB,
  SETTING_FIELDS,
  atLevel,
  createdFields,
  descriptionEntry,
  githubOf,
  historyFields,
  levelComments,
  movedFrom,
  levelSettings,
  settingFields,
  type HistoryLevel,
  type ProjectHistory,
  type ProjectHistoryEntry,
  type ProjectSettingEntry,
} from "@rsva/protocol";
import { DESCRIPTION_FIELD } from "@rsva/schema/models";
import { and, asc, eq, inArray, isNull, ne, or, sql as dsql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db, schema } from "../db.ts";
import { ITEM_BYTES, inPage, metered, pageStart } from "./history.ts";

const { workspace, project, issue, comment, label, workflowState, syncAction } = schema;

/** Bytes a page holds at most, about: a quarter of an issue's, the owner's network (120 KB/s) reads it in a second. */
const PROJECT_PAGE_BYTES = 2 ** 18;

/** The project's issues, archived and deleted ones too: their history stays the project's. */
const issuesOf = (projectId: string) => db.select({ id: issue.id }).from(issue).where(eq(issue.projectId, projectId));

/** Log entries of the project's issues that the level shows: creation and archiving (not at outcomes), changes of its fields and what GitHub did. */
function entriesOf(projectId: string, workspaceId: string, level: HistoryLevel): SQL {
  const fields = LEVEL_FIELDS[level].filter((f) => f !== DESCRIPTION_FIELD);
  const verbs = dsql.join(LEVEL_GITHUB[level].map((v) => dsql`${v}`), dsql`, `);
  const changes = and(
    eq(syncAction.model, "Issue"),
    eq(syncAction.action, "U"),
    or(dsql`${syncAction.data} ?| array[${dsql.join(fields.map((f) => dsql`${f}`), dsql`, `)}]::text[]`, dsql`${syncAction.data} -> 'gh' ->> 'verb' in (${verbs})`),
  );
  // The project's issues now, and its moves out (PLNR-448): an issue moved away leaves the line of its move behind, its
  // story before that goes with it.
  const movedOut = LEVEL_FIELDS[level].includes("projectId")
    ? and(eq(syncAction.model, "Issue"), eq(syncAction.action, "U"), dsql`${syncAction.prev} ? 'projectId'`, dsql`(${syncAction.prev} ->> 'projectId') = ${projectId}`)
    : undefined;
  return and(
    eq(syncAction.workspaceId, workspaceId),
    or(and(inArray(syncAction.modelId, issuesOf(projectId)), or(
      changes,
      level === "outcomes" ? undefined : and(eq(syncAction.model, "Issue"), inArray(syncAction.action, ["I", "A"])),
      LEVEL_FIELDS[level].includes(DESCRIPTION_FIELD) ? and(eq(syncAction.model, "Document"), eq(syncAction.action, "U")) : undefined,
    )), movedOut),
  )!;
}

const SETTING_MODELS = ["Label", "WorkflowState"];

/**
 * The project's state and label actions the Timeline says: every creation and deletion, and changes of SETTING_FIELDS
 * (not colors or order). Its states and labels are those with a row in it, and deleted ones whose creation or deletion
 * named it.
 */
function settingsOf(projectId: string, workspaceId: string): SQL {
  const settings = and(eq(syncAction.workspaceId, workspaceId), inArray(syncAction.model, SETTING_MODELS));
  const ids = dsql`select ${label.id} from ${label} where ${label.projectId} = ${projectId}
    union all select ${workflowState.id} from ${workflowState} where ${workflowState.projectId} = ${projectId}
    union all select ${syncAction.modelId} from ${syncAction} where ${settings} and ${syncAction.action} in ('I', 'D') and ${syncAction.data} ->> 'projectId' = ${projectId}`;
  const fields = dsql.join(SETTING_FIELDS.map((f) => dsql`${f}`), dsql`, `);
  return and(settings, dsql`${syncAction.modelId} in (${ids})`, or(ne(syncAction.action, "U"), dsql`${syncAction.data} ?| array[${fields}]::text[]`))!;
}

/** Live comments on the project's issues (a deleted one leaves only a tombstone, which says nothing). */
const commentsOf = (projectId: string) => and(inArray(comment.issueId, issuesOf(projectId)), isNull(comment.deletedAt));

/** Every item of the project's history at the level with its size, for pageStart. */
function items(projectId: string, workspaceId: string, level: HistoryLevel, upTo: (at: PgColumn) => SQL): SQL {
  const parts = [dsql`select ${syncAction.createdAt} as at, ${ITEM_BYTES}::int as n from ${syncAction} where ${entriesOf(projectId, workspaceId, level)} and ${upTo(syncAction.createdAt)}`];
  if (levelComments(level)) {
    parts.push(dsql`select ${comment.createdAt}, least(octet_length(${comment.body}), ${COMMENT_EXCERPT * 4}) + ${ITEM_BYTES} from ${comment} where ${commentsOf(projectId)} and ${upTo(comment.createdAt)}`);
  }
  if (levelSettings(level)) parts.push(dsql`select ${syncAction.createdAt}, ${ITEM_BYTES} from ${syncAction} where ${settingsOf(projectId, workspaceId)} and ${upTo(syncAction.createdAt)}`);
  return dsql.join(parts, dsql` union all `);
}

/** A page for a reader, counted against their read budget like an issue's (history.ts). */
export function readProjectHistory(userId: string, projectId: string, level: HistoryLevel, until?: string): Promise<ProjectHistory | null | "rate_limited"> {
  return metered(userId, PROJECT_PAGE_BYTES * 2, () => projectHistory(projectId, level, until));
}

/** The newest page of the project's history at the level, at or before `until`; null when there is no such project. */
async function projectHistory(projectId: string, level: HistoryLevel, until?: string): Promise<ProjectHistory | null> {
  return db.transaction(
    async (tx) => {
      const [row] = await tx
        .select({ s: workspace.lastSyncId, workspaceId: project.workspaceId })
        .from(project)
        .innerJoin(workspace, eq(workspace.id, project.workspaceId))
        .where(eq(project.id, projectId));
      if (!row) return null;
      const { from, older } = await pageStart(tx, (upTo) => items(projectId, row.workspaceId, level, upTo), until, PROJECT_PAGE_BYTES);
      const page = inPage(from, until);
      const [log, comments, settings] = await Promise.all([
        tx
          // A description's own text stays out: an entry only says it changed.
          .select({ id: syncAction.id, m: syncAction.model, i: syncAction.modelId, a: syncAction.action, by: syncAction.actorId, at: syncAction.createdAt, d: dsql<unknown>`${syncAction.data} - 'doc'`, p: syncAction.prev })
          .from(syncAction)
          .where(and(entriesOf(projectId, row.workspaceId, level), page(syncAction.createdAt)))
          .orderBy(asc(syncAction.id)),
        levelComments(level)
          ? tx
              .select({ id: comment.id, i: comment.issueId, by: comment.authorId, at: comment.createdAt, x: dsql<string>`left(${comment.body}, ${COMMENT_EXCERPT})`, r: comment.parentId })
              .from(comment)
              .where(and(commentsOf(projectId), page(comment.createdAt)))
              .orderBy(asc(comment.createdAt))
          : Promise.resolve([]),
        levelSettings(level)
          ? tx
              .select({ id: syncAction.id, m: syncAction.model, mid: syncAction.modelId, a: syncAction.action, by: syncAction.actorId, at: syncAction.createdAt, d: syncAction.data, p: syncAction.prev })
              .from(syncAction)
              .where(and(settingsOf(projectId, row.workspaceId), page(syncAction.createdAt)))
              .orderBy(asc(syncAction.id))
          : Promise.resolve([]),
      ]);
      const history: ProjectHistoryEntry[] = [];
      for (const e of log) {
        const entry =
          e.m === "Document"
            ? { ...descriptionEntry(e.id, e.by, e.at), i: e.i }
            : e.a === "I"
              ? atLevel({ id: e.id, i: e.i, a: "I", by: e.by, at: e.at, d: createdFields(e.d), p: {} }, level)
              : atLevel({ id: e.id, i: e.i, a: e.a as ProjectHistoryEntry["a"], by: e.by, at: e.at, d: historyFields(e.d), p: historyFields(e.p), ...githubOf(e.d), ...movedFrom(e.d) }, level);
        if (entry) history.push(entry);
      }
      const changes: ProjectSettingEntry[] = settings.map((e) => ({
        id: e.id,
        m: e.m as ProjectSettingEntry["m"],
        mid: e.mid,
        a: e.a as ProjectSettingEntry["a"],
        by: e.by,
        at: e.at,
        d: e.a === "D" ? {} : settingFields(e.d),
        p: settingFields(e.p),
      }));
      return { s: row.s, history, comments, ...(levelSettings(level) && { settings: changes }), older };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
