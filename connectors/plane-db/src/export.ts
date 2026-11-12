// Plane database copy → import bundle (NDJSON, packages/schema/src/bundle.ts), one workspace per bundle.
//
//   node connectors/plane-db/src/export.ts --db postgres://…/plane_copy --workspace atlas --out .data/plane-db/atlas.ndjson
//
// Reads a restored copy of Plane's PostgreSQL (never the live one: the session is read-only anyway) and writes the
// bundle that `node apps/server/src/cli/import.ts <bundle>` imports. Ids and source match the API connector
// (connectors/plane), so either can update what the other imported.
//
// Options: --plane-url <https://…> is where images in descriptions and comments link to when their bytes are not here
// (Plane's asset endpoint; "" drops them). --assets <dir> holds uploads named by asset id
// (connectors/plane-db/assets.py): images and issue attachments then move as files, and --files-out <dir> gets the bytes
// the bundle needs, named by SHA-256, for `import --files`. Prints counts only: the bundle holds private data and goes
// to a git-ignored place.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { toNdjson } from "@rsva/schema/bundle";
import { toBundle } from "./map.ts";
import { connect, notMigrated, readWorkspace } from "./read.ts";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    workspace: { type: "string" },
    out: { type: "string" },
    "plane-url": { type: "string" },
    assets: { type: "string" },
    "files-out": { type: "string" },
  },
});
if (!values.db || !values.workspace || !values.out || values["plane-url"] === undefined) {
  throw new Error("usage: export.ts --db <postgres url> --workspace <slug> --out <file.ndjson> --plane-url <url, or \"\" for no files> [--assets <dir> --files-out <dir>]");
}
if (!values.assets !== !values["files-out"]) throw new Error("--assets and --files-out go together");
const slug = values.workspace;
const planeUrl = values["plane-url"].replace(/\/$/, "");

const started = performance.now();
const sql = connect(values.db);
try {
  const rows = await readWorkspace(sql, slug);
  const assetUrl = planeUrl ? (id: string) => `${planeUrl}/api/assets/v2/workspaces/${encodeURIComponent(slug)}/${id}/` : undefined;
  const assets = values.assets;
  const hashes = new Map(
    (assets ? readdirSync(assets) : []).map((id) => [id, createHash("sha256").update(readFileSync(join(assets!, id))).digest("hex")]),
  );
  const { header, lines, report } = toBundle(rows, { ...(assetUrl ? { assetUrl } : {}), assetHash: (id) => hashes.get(id) ?? null });
  mkdirSync(dirname(values.out), { recursive: true });
  if (assets) {
    const out = values["files-out"]!;
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const ids = new Map([...hashes].map(([id, sha]) => [sha, id]));
    for (const l of lines) if (l.m === "File") copyFileSync(join(assets, ids.get(l.sha256)!), join(out, l.sha256));
  }
  writeFileSync(values.out, toNdjson([header, ...lines]), { mode: 0o600 });
  const left = await notMigrated(sql, slug);
  console.error(`Plane DB → bundle "${slug}" in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  console.error("moved:", report);
  console.error("not migrated yet:", left);
} finally {
  await sql.end();
}
