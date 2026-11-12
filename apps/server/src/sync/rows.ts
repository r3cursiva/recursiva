// What the write pipeline's op handlers do to rows alike: read one for update or refuse it as not found, insert one or
// refuse its id as taken, tell which fields a change changes, refuse removing what issues still use, take turns on
// the workspace row.
import { and, eq, sql as dsql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { schema, type Tx } from "../db.ts";
import { TxError } from "./tx-error.ts";

const { workspace, issue } = schema;

/**
 * Fields of `set` that differ from the row, with their values before. Compared as JSON: lists (labels, assignees, former
 * keys) by their items, scalars as `!==` would. Before RSVA-428 cycles and links compared with `!==`; their fields are all
 * strings and nulls, for which the two agree.
 */
export function diff(row: object, set: object): { changed: Record<string, unknown>; prev: Record<string, unknown> } {
  const was = row as Record<string, unknown>;
  const changed: Record<string, unknown> = {};
  const prev: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(set)) {
    if (JSON.stringify(was[k]) !== JSON.stringify(v)) {
      changed[k] = v;
      prev[k] = was[k];
    }
  }
  return { changed, prev };
}

type Owned = PgTable & { id: PgColumn; workspaceId: PgColumn };

/** The workspace's row of `t` by id, locked for the transaction; not_found "no <what> <id>" when there is none. */
export async function lockOwned<T extends Owned>(tx: Tx, t: T, workspaceId: string, id: string, what: string): Promise<T["$inferSelect"]> {
  const [row] = await tx
    .select()
    .from(t as Owned)
    .where(and(eq(t.id, id), eq(t.workspaceId, workspaceId)))
    .for("update");
  if (!row) throw new TxError("not_found", `no ${what} ${id}`);
  return row as T["$inferSelect"];
}

/** The row an `insert … on conflict do nothing returning …` gave; a conflict "<what> already exists" when it gave none. */
export async function created<R>(insert: PromiseLike<R[]>, what: string): Promise<R> {
  const [row] = await insert;
  if (!row) throw new TxError("conflict", `${what} already exists`);
  return row;
}

/** Refuses removing a row issues still use (bad_ref): `why` says how many of them and what to do first. */
export async function unusedBy(tx: Tx, uses: SQL | undefined, why: (n: number) => string): Promise<void> {
  const [used] = await tx.select({ n: dsql<number>`count(*)::int` }).from(issue).where(uses);
  if (used!.n) throw new TxError("bad_ref", why(used!.n));
}

/** Locks the workspace row: parent and relation changes of a workspace take turns on it (the commit takes it anyway). */
export async function lockWorkspace(tx: Tx, workspaceId: string): Promise<void> {
  await tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, workspaceId)).for("update");
}
