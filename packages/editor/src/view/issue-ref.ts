// Issue keys in the editor (PLNR-43): the text stays text (../issue-ref.ts); a decoration draws a key that names an
// issue like a link. ⌘/Ctrl-click opens it in a new tab; a plain click opens it in place where the app says how
// (`open`, RSVA-484: a key looks like a link, so it acts as one), and otherwise places the caret. Arrow keys still walk
// into a key, a drag over it still selects (ProseMirror calls handleClick only for a click that did not move). A
// transaction rescans only the blocks it touched: the ranges its steps replaced (mapping drops their decorations) and the
// difference of the documents (mark steps have empty maps, yet code or a link over a key unlinks it). A keystroke in a
// 50 KB description reads one paragraph.
import type { Node } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { issueRefs, type IssueHref } from "../issue-ref.ts";
import { schema } from "../schema.ts";

const key = new PluginKey<DecorationSet>("issueRefs");

/** A key split by marks ("PLNR-<b>27</b>") or inside a link or code is not a reference, as in the reader (render.ts). */
function blockRefs(block: Node, pos: number, href: IssueHref, out: Decoration[]): void {
  if (block.type.spec.code) return;
  block.forEach((child, offset) => {
    if (!child.isText || child.marks.some((m) => m.type === schema.marks.link || m.type === schema.marks.code)) return;
    const at = pos + 1 + offset;
    for (const r of issueRefs(child.text!, href))
      out.push(Decoration.inline(at + r.from, at + r.to, { class: "issue-ref", "data-issue": r.key }, { href: r.href }));
  });
}

function scan(doc: Node, from: number, to: number, href: IssueHref): { from: number; to: number; decos: Decoration[] } {
  const decos: Decoration[] = [];
  let lo = to;
  let hi = from;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    lo = Math.min(lo, pos);
    hi = Math.max(hi, pos + node.nodeSize);
    blockRefs(node, pos, href, decos);
    return false;
  });
  return { from: lo, to: hi, decos };
}

/** The span of the new document the transaction touched, or null for none. */
function touched(tr: Transaction): [number, number] | null {
  let from = Infinity;
  let to = -Infinity;
  const widen = (a: number, b: number) => {
    from = Math.min(from, a, b);
    to = Math.max(to, a, b);
  };
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_a, _b, start, end) => widen(rest.map(start, -1), rest.map(end, 1)));
  });
  const start = tr.before.content.findDiffStart(tr.doc.content);
  if (start !== null) widen(start, tr.before.content.findDiffEnd(tr.doc.content)?.b ?? start);
  return from <= to ? [from, to] : null;
}

/** Opens the issue at an address in place: the app's navigation. */
export type OpenIssue = (href: string) => void;

export function issueRefPlugin(href: IssueHref, open?: OpenIssue): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => DecorationSet.create(state.doc, scan(state.doc, 0, state.doc.content.size, href).decos),
      apply(tr, set) {
        if (!tr.docChanged) return set;
        const next = set.map(tr.mapping, tr.doc);
        const span = touched(tr);
        if (!span) return next;
        const s = scan(tr.doc, Math.max(0, span[0] - 1), Math.min(tr.doc.content.size, span[1] + 1), href);
        return s.from < s.to ? next.remove(next.find(s.from, s.to)).add(tr.doc, s.decos) : next;
      },
    },
    props: {
      decorations: (state) => key.getState(state),
      handleClick(_view, _pos, e) {
        const newTab = e.metaKey || e.ctrlKey;
        if (!newTab && (!open || e.shiftKey || e.altKey || e.button !== 0)) return false;
        // The key under the pointer, not the one at the caret: a click just past a key puts the caret at its end.
        const key = (e.target as Element | null)?.closest?.<HTMLElement>(".issue-ref")?.dataset.issue;
        const to = key && href(key);
        if (!to) return false;
        if (newTab) window.open(to, "_blank", "noopener,noreferrer");
        else open!(to);
        return true;
      },
    },
  });
}

/** The keys drawn as references, in document order (tests). */
export const issueRefKeys = (state: EditorState): string[] =>
  (key.getState(state)?.find() ?? []).sort((a, b) => a.from - b.from).map((d) => state.doc.textBetween(d.from, d.to));
