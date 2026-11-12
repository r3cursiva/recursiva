// Server-side check of a document a client sent: it must fit the schema exactly (node and mark types, content rules,
// attributes, safe links), stay within the depth and size caps, and comes back in canonical form (toJSON), so stored
// documents compare equal when they are equal.
import { Node } from "prosemirror-model";
import { DOC_JSON_MAX, MAX_NODE_DEPTH, mentionMarks, TABLE_CELLS_MAX, TABLE_COLUMNS_MAX, withoutSections, type DocNode } from "./doc.ts";
import { schema } from "./schema.ts";
import { errorText } from "@rsva/schema/util";

export class DocError extends Error {}

export function validateDoc(raw: unknown): DocNode {
  if (!raw || typeof raw !== "object" || (raw as { type?: unknown }).type !== "doc") throw new DocError("a description must be a document");
  if (JSON.stringify(raw).length > DOC_JSON_MAX) throw new DocError(`the description is longer than ${DOC_JSON_MAX} characters of JSON`);
  if (depthOf(raw as DocNode, 0) > MAX_NODE_DEPTH) throw new DocError(`the description nests deeper than ${MAX_NODE_DEPTH} levels`);
  checkTables(raw as DocNode);
  let doc: Node;
  try {
    // A client that still has a collapsible section in a description sends it opened out (doc.ts).
    doc = Node.fromJSON(schema, stripMentionMarks(withoutSections(raw as DocNode)));
    doc.check();
  } catch (e) {
    throw new DocError(`the description does not fit the schema: ${errorText(e)}`);
  }
  return JSON.parse(JSON.stringify(doc.toJSON())) as DocNode;
}

/** Link and code marks come off mentions (mentionMarks): the schema cannot refuse them on an inline atom. */
function stripMentionMarks(n: DocNode): DocNode {
  if (n.type === "mention" && n.marks?.length) {
    const marks = mentionMarks(n.marks);
    const { marks: _, ...rest } = n;
    return marks.length ? { ...rest, marks } : rest;
  }
  return Array.isArray(n.content) ? { ...n, content: n.content.map(stripMentionMarks) } : n;
}

/**
 * Tables within their caps (doc.ts), counted as Markdown writes them: every row as wide as the widest. Without this a
 * stored table of one wide row and many short ones would be millions of cells once written out (markdown.ts).
 */
function checkTables(doc: DocNode): void {
  let cells = 0;
  const walk = (n: DocNode, d: number) => {
    if (d > MAX_NODE_DEPTH || !Array.isArray(n.content)) return;
    if (n.type === "table") {
      let width = 0;
      for (const r of n.content) width = Math.max(width, Array.isArray(r.content) ? r.content.length : 0);
      if (width > TABLE_COLUMNS_MAX) throw new DocError(`a table is wider than ${TABLE_COLUMNS_MAX} columns`);
      cells += width * n.content.length;
      if (cells > TABLE_CELLS_MAX) throw new DocError(`the tables have more than ${TABLE_CELLS_MAX} cells`);
      return;
    }
    for (const c of n.content) walk(c, d + 1);
  };
  walk(doc, 0);
}

function depthOf(n: DocNode, d: number): number {
  if (d > MAX_NODE_DEPTH) return d;
  let max = d;
  for (const c of Array.isArray(n.content) ? n.content : []) max = Math.max(max, depthOf(c, d + 1));
  return max;
}
