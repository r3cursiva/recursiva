// Description storage formats compared on a real workspace (docs/decisions/0007-description-storage.md):
//   psql "$DATABASE_URL" -At -c "select json_build_object('html', d.html, 'doc', d.doc) from document d
//     join workspace w on w.id = d.workspace_id where w.slug = 'atlas'" | node packages/editor/perf/formats.ts
// Sizes raw and brotli per format, and the time to turn the stored form into a ProseMirror document.
import { brotliCompressSync } from "node:zlib";
import { Node } from "prosemirror-model";
import type { DocNode } from "../src/doc.ts";
import { fromHtml } from "../src/html.ts";
import { fromMarkdown, toMarkdown } from "../src/markdown.ts";
import { schema } from "../src/schema.ts";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const rows = input
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { html: string; doc: DocNode | null })
  .filter((r) => r.html || r.doc);
const docs = rows.map((r) => r.doc ?? fromHtml(r.html));
const html = rows.map((r) => r.html).filter(Boolean);
const json = docs.map((d) => JSON.stringify(d));
const md = docs.map((d) => toMarkdown(d));
const size = (xs: string[]) => {
  const raw = xs.reduce((n, x) => n + Buffer.byteLength(x), 0);
  const br = xs.reduce((n, x) => n + brotliCompressSync(x).length, 0);
  return { raw, br, maxRaw: Math.max(...xs.map((x) => Buffer.byteLength(x))) };
};
const time = (f: () => void) => {
  f();
  const t = performance.now();
  for (let i = 0; i < 5; i++) f();
  return (performance.now() - t) / 5;
};
console.log(`${rows.length} descriptions`);
console.table({
  "Plane HTML": html.length ? size(html) : null,
  "ProseMirror JSON": size(json),
  Markdown: size(md),
});
console.log("to a ProseMirror document, all descriptions, ms:");
console.table({
  "JSON.parse + Node.fromJSON": time(() => json.forEach((j) => Node.fromJSON(schema, JSON.parse(j)))),
  "Markdown parse + Node.fromJSON": time(() => md.forEach((m) => Node.fromJSON(schema, fromMarkdown(m)))),
  "HTML (DOM-free) + Node.fromJSON": html.length ? time(() => html.forEach((h) => Node.fromJSON(schema, fromHtml(h)))) : null,
});
