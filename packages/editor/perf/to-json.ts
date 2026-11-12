// stdin: description rows as JSON lines ({ html, doc }); stdout: each as a document (ProseMirror JSON), one per line.
// Feeds the format comparisons in perf/formats.ts and the Yjs size check (docs/decisions/0007-description-storage.md).
import type { DocNode } from "../src/doc.ts";
import { fromHtml } from "../src/html.ts";

let input = "";
for await (const chunk of process.stdin) input += chunk;
for (const l of input.split("\n")) {
  if (!l) continue;
  const r = JSON.parse(l) as { html: string; doc: DocNode | null };
  if (r.doc || r.html) process.stdout.write(JSON.stringify(r.doc ?? fromHtml(r.html)) + "\n");
}
