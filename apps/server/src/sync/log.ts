// Reading the workspace log: catch-up after sub (socket.ts) and gap filling in the fan-out (hub.ts); and making its
// actions forget words that are gone (forgetText).
import type { Action } from "@rsva/protocol";
import { and, asc, eq, getTableColumns, gt, lte, sql as dsql, type SQL } from "drizzle-orm";
import { db, schema, type Tx } from "../db.ts";

const { syncAction } = schema;
/** Everything but `prev`: before-values are for the history endpoint, deltas do not carry them. */
const { prev: _, ...logColumns } = getTableColumns(syncAction);

const SERVER_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

/** A time as the server sends it (Postgres text, microseconds) or as ISO 8601: what a client may send back as a cursor. */
export function isServerTime(v: unknown): v is string {
  return typeof v === "string" && SERVER_TIME.test(v) && !Number.isNaN(Date.parse(v));
}

function toAction(a: Omit<typeof syncAction.$inferSelect, "prev">): Action {
  return {
    id: a.id,
    m: a.model as Action["m"],
    mid: a.modelId,
    a: a.action as Action["a"],
    ...(a.data ? { d: a.data as Record<string, unknown> } : {}),
    ...(a.actorId ? { by: a.actorId } : {}),
    ...(a.via ? { via: a.via as NonNullable<Action["via"]> } : {}),
  };
}

/** Committed actions with after < id ≤ upTo, in order. */
export async function readLog(workspaceId: string, after: number, upTo?: number): Promise<Action[]> {
  const rows = await db
    .select(logColumns)
    .from(syncAction)
    .where(and(eq(syncAction.workspaceId, workspaceId), gt(syncAction.id, after), upTo === undefined ? undefined : lte(syncAction.id, upTo)))
    .orderBy(asc(syncAction.id));
  return rows.map(toAction);
}

/** What a committed transaction logged, in order: its answer, when a retry finds the first run did commit. */
export async function readTx(tx: Tx, workspaceId: string, txId: string): Promise<Action[]> {
  const rows = await tx.select(logColumns).from(syncAction).where(and(eq(syncAction.workspaceId, workspaceId), eq(syncAction.txId, txId))).orderBy(asc(syncAction.id));
  return rows.map(toAction);
}

/**
 * Numbers and sizes (bytes of the action's data as JSON text, plus a little for the rest) of the first `limit` actions
 * after `after`: what a catch-up would weigh, read before the data itself. `octet_length(data::text)` rather than
 * pg_column_size: a compressible comment is small on disk and whole in memory.
 */
export async function logSizes(workspaceId: string, after: number, limit: number): Promise<{ id: number; n: number }[]> {
  return db
    .select({ id: syncAction.id, n: dsql<number>`coalesce(octet_length(${syncAction.data}::text), 0) + 120` })
    .from(syncAction)
    .where(and(eq(syncAction.workspaceId, workspaceId), gt(syncAction.id, after)))
    .orderBy(asc(syncAction.id))
    .limit(limit);
}

/**
 * The fields of logged rows that hold people's words: an issue's title, a comment's body, a link's address and name, a
 * pull request's title and branch or a commit's message (GitHub links).
 */
const TEXT_FIELDS = ["title", "body", "url", "head"];
/** Fields that go whole: a description's document, and the GitHub event an issue action carries (its title, its repo). */
const WHOLE_FIELDS = ["doc", "gh"];

const textArray = (fields: string[]) => dsql`array[${dsql.join(fields.map((f) => dsql`${f}`), dsql`, `)}]::text[]`;

/**
 * The logged actions of `rows` (a query of model and id pairs: `values ('Comment', $id)` or a subquery) forget their
 * words (`fields`), in place: the actions and their numbers stay, a client counts by them. A text field in `data`
 * becomes "" rather than going, so a client replaying the log still builds a whole row; the whole fields go, and so do
 * the before-values of all of them in `prev`. Pairs, not ids: ids are chosen by clients and unique only per table, so a row of another
 * model with the same id keeps its words. One statement on the log's model_id index. Used when a newer action
 * supersedes the text (an edited comment, a saved description), when the row itself is gone for good (purge.ts) and for
 * a member's address when they leave (members.ts).
 */
export async function forgetText(tx: Tx, workspaceId: string, rows: SQL, fields = TEXT_FIELDS): Promise<void> {
  const text = textArray(fields);
  const whole = textArray(WHOLE_FIELDS);
  await tx.execute(dsql`
    update sync_action set
      data = (data || coalesce((select jsonb_object_agg(f, '""'::jsonb) from unnest(${text}) f where data ? f), '{}')) - ${whole},
      prev = prev - ${text} - ${whole}
    where workspace_id = ${workspaceId} and (model, model_id) in (${rows})
      and (data ?| ${whole} or prev ?| ${text} or exists (select 1 from jsonb_each_text(data) e where e.key = any(${text}) and e.value <> ''))`);
}
