import { fileURLToPath } from "node:url";
import type { DocJSON } from "@rsva/schema/models";
import { fromHtml } from "@rsva/editor/html";
import { emptyDoc, isEmptyDoc } from "@rsva/editor/doc";
import * as schema from "@rsva/schema/db";
import { and, eq, isNull, ne, or, sql as dsql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const sql = postgres(process.env.DATABASE_URL ?? "postgres://rsva:rsva@127.0.0.1:5438/rsva", {
  max: Number(process.env.DB_POOL ?? 10),
  onnotice: () => {},
});

export const db = drizzle({ client: sql, schema, casing: "snake_case" });
type Db = typeof db;
/** A drizzle transaction: same API as db. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function migrateDb(): Promise<void> {
  const folder = fileURLToPath(new URL("../../../packages/schema/migrations", import.meta.url));
  await migrate(db, { migrationsFolder: folder });
  await convertLegacyDescriptions();
}

/**
 * Descriptions stored as Plane HTML before migration 0004 become documents (packages/editor's DOM-free HTML reader), in
 * batches, once: a converted row has `doc` set (an empty document if the HTML had no text). `html` is left as it was
 * (additive), and nothing reads it afterwards. With nothing left it costs one scan of the document table at start.
 */
async function convertLegacyDescriptions(): Promise<void> {
  const { document } = schema;
  for (;;) {
    const rows = await db
      .select({ id: document.id, html: document.html })
      .from(document)
      .where(and(isNull(document.doc), ne(document.html, "")))
      .limit(500);
    if (!rows.length) return;
    await db.transaction(async (tx) => {
      for (const r of rows) {
        const doc = fromHtml(r.html);
        await tx
          .update(document)
          .set({ doc: (isEmptyDoc(doc) ? emptyDoc() : doc) as DocJSON })
          .where(eq(document.id, r.id));
      }
    });
  }
}

/** A project with this key, or one it had before a rename: its old links and references still lead to it. */
export const projectKeyIs = (key: string): SQL => or(eq(schema.project.key, key), dsql`${key} = any(${schema.project.formerKeys})`)!;

/**
 * Issues moved out of a project under one of these keys, "RSVA-3" (PLNR-448): a key finds them after the keys of projects,
 * so read these only for keys no project's issue answers to. Through the partial index of moved issues.
 */
export const movedUnder = (keys: readonly string[]): SQL =>
  and(dsql`${schema.issue.formerKeys} <> '{}'`, dsql`${schema.issue.formerKeys} && array[${dsql.join(keys.map((k) => dsql`${k}`), dsql`, `)}]::text[]`)!;

/** An issue row's key, "PLNR-27" (issueKey in SQL), for a query that joins the issue's project. */
export const issueKeySql = dsql<string>`${schema.project.key} || '-' || ${schema.issue.number}`;

export { schema };
