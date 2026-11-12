// node apps/server/src/cli/import.ts [--update-roles] [--files <dir>] <bundle.ndjson>
//
// --update-roles: roles the bundle states change existing memberships too (agents still at most member, owners stay);
// without it a repeated import leaves everyone's role as it is here.
// --files: the bytes of the bundle's File lines, each named by its SHA-256; they go to the server's blob store.
// --expect-sync-id: the workspace's log position; if it moved, nothing is imported.
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseNdjson, type BundleHeader, type BundleLine } from "@rsva/schema/bundle";
import { migrateDb, sql } from "../db.ts";
import { blobStoreFromEnv } from "../files/store.ts";
import { importBundle } from "../import.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { "update-roles": { type: "boolean", default: false }, files: { type: "string" }, "expect-sync-id": { type: "string" } } });
const file = positionals[0];
if (!file) throw new Error("pass the bundle file");
const dir = values.files;
const expected = values["expect-sync-id"];
await migrateDb();
const r = await importBundle(parseNdjson<BundleHeader | BundleLine>(readFileSync(file, "utf8")), {
  updateRoles: values["update-roles"],
  ...(expected ? { expectSyncId: Number(expected) } : {}),
  ...(dir ? { files: { read: (sha256) => createReadStream(join(dir, sha256)), store: blobStoreFromEnv() } } : {}),
});
console.log(`Imported in ${r.ms} ms:`, r.counts);
await sql.end();
