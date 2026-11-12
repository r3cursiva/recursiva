// The commands behind the toolbar and the shortcuts, and whether each is active at the selection.
import { lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { Fragment, type MarkType, type Node, type NodeType } from "prosemirror-model";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import { TextSelection, type Command, type EditorState } from "prosemirror-state";
import { safeHref } from "../doc.ts";
import { schema } from "../schema.ts";
import { insertTable, tableAt, tableCommand, type TableCmd } from "./table.ts";

const N = schema.nodes;
const M = schema.marks;

export type Cmd =
  | "paragraph"
  | "h1"
  | "h2"
  | "h3"
  | "bold"
  | "italic"
  | "strike"
  | "underline"
  | "code"
  | "link"
  | "quote"
  | "code_block"
  | "bullet_list"
  | "ordered_list"
  | "task_list"
  | "table"
  | TableCmd;

const LISTS = [N.bullet_list!, N.ordered_list!, N.task_list!];

function ancestor(state: EditorState, types: NodeType[]): { node: Node; depth: number } | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if (types.includes($from.node(d).type)) return { node: $from.node(d), depth: d };
  return null;
}

function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  return empty ? !!type.isInSet(state.storedMarks || $from.marks()) : state.doc.rangeHasMark(from, to, type);
}

/** The item type of the list the selection is in: Enter, Tab and Shift-Tab work on it. */
export function itemType(state: EditorState): NodeType {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const t = $from.node(d).type;
    if (t === N.list_item || t === N.task_item) return t;
  }
  return N.list_item!;
}

/** Into a list, out of it (same type), or the list switches type in place. */
function toggleList(type: NodeType): Command {
  return (state, dispatch) => {
    const cur = ancestor(state, LISTS);
    const item = type === N.task_list ? N.task_item! : N.list_item!;
    if (cur && cur.node.type === type) return liftListItem(item)(state, dispatch);
    if (cur) {
      // Rebuilt whole: the list and its items change type together (the schema keeps tasks and bullets apart).
      const pos = state.selection.$from.before(cur.depth);
      const items: Node[] = [];
      cur.node.forEach((c) => items.push(item.create(item === N.task_item ? { checked: c.attrs.checked ?? false } : null, c.content)));
      const tr = state.tr.replaceWith(pos, pos + cur.node.nodeSize, type.create(type === N.ordered_list ? { order: 1 } : null, items));
      dispatch?.(tr.setSelection(TextSelection.create(tr.doc, state.selection.from, state.selection.to)));
      return true;
    }
    return wrapInList(type)(state, dispatch);
  };
}

/** A code block from the selected textblocks (their lines joined), or back to a paragraph. */
const toggleCodeBlock: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if ($from.parent.type === N.code_block) return setBlockType(N.paragraph!)(state, dispatch);
  if ($from.sameParent($to)) return setBlockType(N.code_block!)(state, dispatch);
  const range = $from.blockRange($to);
  if (!range) return false;
  const lines: string[] = [];
  for (let i = range.startIndex; i < range.endIndex; i++) {
    const c = range.parent.child(i);
    if (!c.isTextblock) return setBlockType(N.code_block!)(state, dispatch);
    lines.push(c.textContent);
  }
  const text = lines.join("\n");
  const code = N.code_block!.create(null, text ? schema.text(text) : null);
  if (!range.parent.canReplace(range.startIndex, range.endIndex, Fragment.from(code))) return false;
  dispatch?.(state.tr.replaceWith(range.start, range.end, code).scrollIntoView());
  return true;
};

/** Sets the link on the selection, or removes it when the URL is empty; an unsafe URL does nothing. */
export function setLink(url: string): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    // A bare domain gets a scheme; a file of the workspace (⌘K on one) is a path and stays one.
    const href = url.trim() ? safeHref(/^[a-z][\w+.-]*:|^\/files\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`) : null;
    if (url.trim() && !href) return false;
    const tr = state.tr;
    if (empty) {
      // At a caret: the whole link around it.
      const r = linkRange(state);
      if (!r) return false;
      tr.removeMark(r.from, r.to, M.link);
      if (href) tr.addMark(r.from, r.to, M.link!.create({ href }));
    } else {
      tr.removeMark(from, to, M.link);
      if (href) tr.addMark(from, to, M.link!.create({ href }));
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

/** The run of text around the caret that carries one link. */
function linkRange(state: EditorState): { from: number; to: number } | null {
  const $pos = state.selection.$from;
  const start = $pos.start();
  let runFrom = -1;
  let runHref: unknown = null;
  let found: { from: number; to: number } | null = null;
  $pos.parent.forEach((child, offset) => {
    if (found) return;
    const href = M.link!.isInSet(child.marks)?.attrs.href;
    if (href !== runHref) {
      runFrom = href ? offset : -1;
      runHref = href ?? null;
    }
    const end = offset + child.nodeSize;
    if (runFrom >= 0 && runFrom <= $pos.parentOffset && $pos.parentOffset <= end) {
      // Extend over following children with the same link.
      let to = end;
      for (let i = $pos.parent.childCount, o = 0, k = 0; k < i; k++) {
        const c = $pos.parent.child(k);
        if (o >= end && M.link!.isInSet(c.marks)?.attrs.href === href && o === to) to = o + c.nodeSize;
        o += c.nodeSize;
      }
      found = { from: start + runFrom, to: start + to };
    }
  });
  return found;
}

export function commandFor(c: Cmd): Command {
  switch (c) {
    case "paragraph":
      return setBlockType(N.paragraph!);
    case "h1":
    case "h2":
    case "h3":
      return (s, d) => {
        const level = Number(c[1]);
        const p = s.selection.$from.parent;
        return p.type === N.heading && p.attrs.level === level ? setBlockType(N.paragraph!)(s, d) : setBlockType(N.heading!, { level })(s, d);
      };
    case "bold":
    case "italic":
    case "strike":
    case "underline":
    case "code":
      return toggleMark(M[c]!);
    case "link":
      return setLink("");
    case "quote":
      return (s, d) => (ancestor(s, [N.blockquote!]) ? lift(s, d) : wrapIn(N.blockquote!)(s, d));
    case "code_block":
      return toggleCodeBlock;
    case "bullet_list":
    case "ordered_list":
    case "task_list":
      return toggleList(N[c]!);
    case "table":
      return insertTable;
    default:
      return tableCommand(c);
  }
}

export function isActive(state: EditorState, c: Cmd): boolean {
  const parent = state.selection.$from.parent;
  switch (c) {
    case "paragraph":
      return parent.type === N.paragraph;
    case "h1":
    case "h2":
    case "h3":
      return parent.type === N.heading && parent.attrs.level === Number(c[1]);
    case "bold":
    case "italic":
    case "strike":
    case "underline":
    case "code":
    case "link":
      return markActive(state, M[c]!);
    case "quote":
      return !!ancestor(state, [N.blockquote!]);
    case "code_block":
      return parent.type === N.code_block;
    case "bullet_list":
    case "ordered_list":
    case "task_list":
      return ancestor(state, LISTS)?.node.type === N[c];
    case "table":
      return !!tableAt(state);
    default:
      return false;
  }
}

/** The link at the selection, for the link input. */
export function linkAt(state: EditorState): string {
  const { $from, from, to } = state.selection;
  let href = "";
  state.doc.nodesBetween(from, Math.max(to, from + 1), (n) => {
    const l = M.link!.isInSet(n.marks);
    if (l && !href) href = l.attrs.href as string;
  });
  return href || ((M.link!.isInSet($from.marks())?.attrs.href as string | undefined) ?? "");
}
