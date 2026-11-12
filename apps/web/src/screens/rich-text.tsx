// Rich text for reading: comment bodies. One renderer and one Markdown dialect with the editor (packages/editor):
// documents become DOM nodes one by one, nothing is ever parsed as HTML. The styles are shared (content.css).
import type { DocNode } from "@rsva/editor/doc";
import { fromMarkdown } from "@rsva/editor/markdown";
import { renderDoc } from "@rsva/editor/render";
import type { DocJSON } from "@rsva/schema/models";
import { cn } from "@rsva/ui/lib/utils";
import { useLayoutEffect, useMemo, useRef } from "react";
import { formatSize } from "../lib/upload.ts";
import { store } from "../store.ts";
import { issueHref } from "./issue-ref.ts";

/** A mention shows the person's name as it is now; someone no longer here keeps the name it was written with. */
const mentionName = (id: string) => store.users.get(id)?.name;

/** A document as stored (DocJSON, checked by the server against the editor's schema) or as parsed here. */
function RichText({ doc, className, comment }: { doc: DocJSON | DocNode | null | undefined; className?: string; comment?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.replaceChildren(doc ? renderDoc(doc as DocNode, { mentionName, issueHref, ...(comment ? { foldCode: true, fileSize: formatSize } : {}) }) : "");
  }, [doc, comment]);
  return <div ref={ref} className={cn("rich-text", className)} />;
}

/** A comment: Markdown, as the composer and agents write it. */
export function MarkdownBody({ body, className }: { body: string; className?: string }) {
  const doc = useMemo(() => fromMarkdown(body), [body]);
  return <RichText doc={doc} comment {...(className ? { className } : {})} />;
}
