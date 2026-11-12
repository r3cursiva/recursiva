// Tables in the editor (doc.ts, PLNR-367): insert one, add and delete rows and columns, and the keys that move between
// cells. Our own small set instead of prosemirror-tables: GitHub's tables have no merged cells, so a row is a list of
// cells and a column is the same index in every row, and nothing here needs a table map.
import { Fragment, type Node } from "prosemirror-model";
import { Selection, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { tableCells } from "../markdown.ts";
import { TABLE_CELLS_MAX, TABLE_COLUMNS_MAX } from "../doc.ts";
import { schema } from "../schema.ts";

const N = schema.nodes;

/** Where the caret is in a table: the table and its position, the row and the column. */
interface At {
  table: Node;
  pos: number;
  row: number;
  col: number;
}

export function tableAt(state: EditorState): At | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 2; d--) {
    if ($from.node(d).type !== N.table_cell) continue;
    return { table: $from.node(d - 2), pos: $from.before(d - 2), row: $from.index(d - 2), col: $from.index(d - 1) };
  }
  return null;
}

/** Cells the document's tables hold as Markdown writes them (every row as wide as the widest): the server's cap. */
function cellsIn(doc: Node): number {
  let n = 0;
  doc.descendants((t) => {
    if (t.type !== N.table) return true;
    let width = 0;
    t.forEach((r) => (width = Math.max(width, r.childCount)));
    n += width * t.childCount;
    return false;
  });
  return n;
}
/** Whether `more` cells still fit under TABLE_CELLS_MAX. */
const room = (state: EditorState, more: number) => cellsIn(state.doc) + more <= TABLE_CELLS_MAX;

const cellOf = (align: unknown, content?: Fragment) => N.table_cell!.create({ align: typeof align === "string" ? align : "" }, content);
/** The column's alignment, from its header cell: new cells in it take it. */
const alignOf = (table: Node, col: number) => table.firstChild!.maybeChild(col)?.attrs.align ?? "";

/** The position inside a cell's text: at its end, or selecting all of it. */
function cellPos(doc: Node, tablePos: number, row: number, col: number): { from: number; to: number } {
  let pos = tablePos + 1;
  const table = doc.nodeAt(tablePos)!;
  for (let r = 0; r < row; r++) pos += table.child(r).nodeSize;
  pos += 1;
  const tr = table.child(row);
  for (let c = 0; c < col; c++) pos += tr.child(c).nodeSize;
  return { from: pos + 1, to: pos + 1 + tr.child(col).content.size };
}

function goTo(tr: Transaction, tablePos: number, row: number, col: number, select: boolean): Transaction {
  const { from, to } = cellPos(tr.doc, tablePos, row, col);
  return tr.setSelection(TextSelection.create(tr.doc, select ? from : to, to)).scrollIntoView();
}

/** A new table: the header given (or three empty columns) and one empty row, or two without a header. */
function newTable(header: Fragment[]): Node {
  const width = header.length || 3;
  const row = (cells: (Fragment | undefined)[]) => N.table_row!.create(null, Array.from({ length: width }, (_, k) => cellOf("", cells[k])));
  return N.table!.create(null, [row(header), row([]), ...(header.length ? [] : [row([])])]);
}

/** A table replacing an empty paragraph, or after the block with the caret; the caret goes into its first cell. */
export const insertTable: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if (tableAt(state) || $from.depth < 1) return false;
  const empty = $from.parent.type === N.paragraph && !$from.parent.content.size;
  const index = $from.index(-1) + (empty ? 0 : 1);
  if (!$from.node(-1).canReplaceWith(index, $from.index(-1) + 1, N.table!) || !room(state, 9)) return false;
  if (!dispatch) return true;
  const at = empty ? $from.before() : $from.after();
  const tr = empty ? state.tr.replaceWith(at, $from.after(), newTable([])) : state.tr.insert(at, newTable([]));
  dispatch(goTo(tr, at, 0, 0, false));
  return true;
};

export type TableCmd = "row_above" | "row_below" | "col_left" | "col_right" | "delete_row" | "delete_col" | "delete_table";

export function tableCommand(c: TableCmd): Command {
  return (state, dispatch) => {
    const at = tableAt(state);
    if (!at) return false;
    if (!dispatch) return true;
    const { table, pos, row, col } = at;
    const rows: Node[] = [];
    table.forEach((r) => rows.push(r));
    const width = table.firstChild!.childCount;
    // Within the caps the server keeps (validate.ts): a column more is a cell more in every row.
    if ((c === "row_above" || c === "row_below") && !room(state, width)) return false;
    if ((c === "col_left" || c === "col_right") && (width >= TABLE_COLUMNS_MAX || !room(state, table.childCount))) return false;
    let to = { row, col };
    let next: Node[] | null = rows;
    switch (c) {
      case "row_above":
      case "row_below": {
        const at2 = c === "row_above" ? row : row + 1;
        const fresh = N.table_row!.create(null, Array.from({ length: width }, (_, k) => cellOf(alignOf(table, k))));
        next = [...rows.slice(0, at2), fresh, ...rows.slice(at2)];
        to = { row: at2, col };
        break;
      }
      case "col_left":
      case "col_right": {
        const at2 = c === "col_left" ? col : col + 1;
        next = rows.map((r) => {
          const cells: Node[] = [];
          r.forEach((x) => cells.push(x));
          cells.splice(at2, 0, cellOf(""));
          return r.type.create(r.attrs, cells);
        });
        to = { row, col: at2 };
        break;
      }
      case "delete_row":
        next = rows.length > 1 ? rows.filter((_, i) => i !== row) : null;
        to = { row: Math.min(row, rows.length - 2), col };
        break;
      case "delete_col":
        next =
          width > 1
            ? rows.map((r) => {
                const cells: Node[] = [];
                r.forEach((x, _o, i) => i !== col && cells.push(x));
                return r.type.create(r.attrs, cells);
              })
            : null;
        to = { row, col: Math.min(col, width - 2) };
        break;
      case "delete_table":
        next = null;
    }
    if (!next) {
      // The last row or column takes the table with it: an empty paragraph stands in its place.
      const tr = state.tr.replaceWith(pos, pos + table.nodeSize, N.paragraph!.create());
      dispatch(tr.setSelection(TextSelection.create(tr.doc, pos + 1)).scrollIntoView());
      return true;
    }
    const tr = state.tr.replaceWith(pos, pos + table.nodeSize, table.type.create(table.attrs, next));
    dispatch(goTo(tr, pos, to.row, to.col, false));
    return true;
  };
}

/** Tab and Shift-Tab: the next or previous cell, its text selected; Tab in the last cell adds a row. */
export function nextCell(dir: 1 | -1): Command {
  return (state, dispatch) => {
    const at = tableAt(state);
    if (!at) return false;
    const width = at.table.firstChild!.childCount;
    const i = at.row * width + at.col + dir;
    if (i < 0) return true;
    if (!dispatch) return true;
    // At the cap no row is added and the caret stays.
    if (i >= at.table.childCount * width) return tableCommand("row_below")(state, (tr) => dispatch(goTo(tr, at.pos, at.row + 1, 0, false))) || true;
    dispatch(goTo(state.tr, at.pos, Math.floor(i / width), i % width, true));
    return true;
  };
}

/** Enter in a cell: the cell below; in the last row, a new row first. A cell holds one line. */
export const cellBelow: Command = (state, dispatch) => {
  const at = tableAt(state);
  if (!at) return false;
  if (!dispatch) return true;
  if (at.row + 1 >= at.table.childCount) return tableCommand("row_below")(state, dispatch) || true;
  dispatch(goTo(state.tr, at.pos, at.row + 1, at.col, false));
  return true;
};

/**
 * Up and Down at a cell's first or last line: the cell above or below, and past the first or last row out of the
 * table, into the block there or a new paragraph when there is none (text above and below a table, as in Linear).
 */
export function verticalArrow(dir: "up" | "down"): Command {
  return (state, dispatch, view?: EditorView) => {
    const at = tableAt(state);
    if (!at || !state.selection.empty || (view && !view.endOfTextblock(dir))) return false;
    if (!dispatch) return true;
    const row = at.row + (dir === "up" ? -1 : 1);
    if (row >= 0 && row < at.table.childCount) {
      dispatch(goTo(state.tr, at.pos, row, Math.min(at.col, at.table.child(row).childCount - 1), false));
      return true;
    }
    const outside = dir === "up" ? at.pos : at.pos + at.table.nodeSize;
    const $out = state.doc.resolve(outside);
    if (dir === "up" ? $out.nodeBefore : $out.nodeAfter) {
      const sel = Selection.findFrom($out, dir === "up" ? -1 : 1, true);
      if (sel) {
        dispatch(state.tr.setSelection(sel).scrollIntoView());
        return true;
      }
    }
    const tr = state.tr.insert(outside, N.paragraph!.create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, outside + 1)).scrollIntoView());
    return true;
  };
}

/**
 * `|--` typed in an empty paragraph: a table. When the paragraph before is a Markdown header row (`| Name | Status |`),
 * its cells become the header, so a table typed as Markdown turns into one at its delimiter row.
 */
export function typedTable(state: EditorState, start: number, end: number): Transaction | null {
  const $s = state.doc.resolve(start);
  if ($s.parent.type !== N.paragraph || $s.parent.content.size !== end - start || tableAt(state)) return null;
  const parent = $s.node(-1);
  const index = $s.index(-1);
  if (!parent.canReplaceWith(index, index + 1, N.table!)) return null;
  const before = index > 0 ? parent.child(index - 1) : null;
  const text = before?.type === N.paragraph ? before.textContent : "";
  const header = text.includes("|") ? tableCells(text).slice(0, TABLE_COLUMNS_MAX).map((t) => (t ? Fragment.from(schema.text(t)) : Fragment.empty)) : [];
  if (!room(state, header.length ? header.length * 2 : 9)) return null;
  const from = header.length ? $s.before() - before!.nodeSize : $s.before();
  return goTo(state.tr.replaceWith(from, $s.after(), newTable(header)), from, header.length ? 1 : 0, 0, false);
}
