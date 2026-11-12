// Kept apart from doc.ts: it has no runtime imports or top-level code, so the web startup bundle can use it alone.
import type { DocNode } from "./doc.ts";

/** The text of a document, blocks separated by newlines. */
export function docText(node: DocNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hard_break") return "\n";
  if (node.type === "mention") return `@${node.attrs?.label ?? ""}`;
  if (node.type === "image") return "";
  const parts = (node.content ?? []).map(docText);
  if (node.type === "table_row") return parts.join(" | ");
  return node.type === "doc" || !(node.content ?? []).some((c) => c.type === "text") ? parts.join("\n") : parts.join("");
}
