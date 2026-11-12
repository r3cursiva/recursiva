// Real descriptions through Markdown and back (packages/editor/perf/to-json.ts output on stdin): how many come back
// exactly as Markdown carries them, and the first difference otherwise. Reads local data, writes nothing.
import { Node } from "prosemirror-model";
import { sameDoc, type DocNode } from "../src/doc.ts";
import { fromMarkdown, markdownNormal, toMarkdown } from "../src/markdown.ts";
import { schema } from "../src/schema.ts";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const docs = input.split("\n").filter(Boolean).map((l) => JSON.parse(l) as DocNode);
const strip = (n: DocNode): DocNode => {
  if (!n.content) return n;
  const kids = n.content.map(strip).filter((c) => !(c.type === "paragraph" && !c.content));
  if (/item$/.test(n.type) && kids[0]?.type !== "paragraph") kids.unshift({ type: "paragraph" });
  return { ...n, content: kids.length ? kids : [{ type: "paragraph" }] };
};
let same = 0;
let stable = 0;
const bad: string[] = [];
for (const d of docs) {
  Node.fromJSON(schema, d).check();
  const md = toMarkdown(d);
  const back = fromMarkdown(md);
  if (sameDoc(strip(back), strip(markdownNormal(d)))) same++;
  else if (bad.length < 3) bad.push(md.slice(0, 300));
  if (toMarkdown(back) === md) stable++;
}
console.log({ docs: docs.length, sameAfterRoundTrip: same, markdownStable: stable });
for (const b of bad) console.log("---\n" + b);
