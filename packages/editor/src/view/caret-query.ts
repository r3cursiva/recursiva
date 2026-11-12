// The caret menus' half in ProseMirror: which `@query` (people, PLNR-27), `#query` (issues) or `/query` (blocks, PLNR-116)
// the caret is in, and the edits the menus make. The lists, their keys and what is in them belong to the host
// (react/caret-menu.tsx gets them from the app): the editor knows only that something after a trigger is being typed.
//
// Considered: an input rule on the trigger that opens the menu once (Tiptap's suggestion does it by tracking a range from
// the trigger). Reading the query off the text before the caret on every transaction is simpler and recovers by itself:
// clicking into "@ann" again, undo or a paste all land in the same state, and there is no range to keep in step.
import { Plugin, PluginKey, type Command, type EditorState, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { mentionLabelOf } from "../doc.ts";
import { schema } from "../schema.ts";

export type Trigger = "@" | "#" | "/";

/** The `@query`, `#query` or `/query` before the caret: `from` is the trigger, `to` the caret. */
export interface CaretQuery {
  trigger: Trigger;
  from: number;
  to: number;
  query: string;
}

interface QueryState {
  q: CaretQuery | null;
  /** The trigger whose menu Esc closed: it stays closed until the caret leaves that query. */
  dismissed: number | null;
}

const queryKey = new PluginKey<QueryState>("caret-query");

/**
 * Each trigger at a word start. "@": up to 40 characters with no space or another @ (names are matched by their words).
 * "#": a key or words of a title, so spaces too, but not right after the # ("# " at a line's start is a heading). "/": a
 * block's name, after a space or at the start only, so a URL or "and/or" opens nothing.
 */
const QUERIES: Record<Trigger, RegExp> = {
  "@": /(?:^|[\s([{"'«])@([^\s@]{0,40})$/u,
  "#": /(?:^|[\s([{"'«])#((?:[^\s#][^#]{0,39})?)$/u,
  "/": /(?:^|\s)\/([^\s/]{0,20})$/u,
};

function queryAt(state: EditorState, triggers: readonly Trigger[]): CaretQuery | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $at = selection.$from;
  if (!$at.parent.isTextblock || $at.parent.type.spec.code || $at.marks().some((m) => m.type === schema.marks.code)) return null;
  // Text before the caret in this block, a mention or a break read as a space so a trigger right after one still starts a query.
  const before = $at.parent.textBetween(Math.max(0, $at.parentOffset - 64), $at.parentOffset, undefined, " ");
  let found: CaretQuery | null = null;
  for (const trigger of triggers) {
    const m = QUERIES[trigger].exec(before);
    const from = m ? $at.pos - m[1]!.length - 1 : -1;
    // "#fix @an": the trigger nearest the caret is the one being typed.
    if (m && (!found || from > found.from)) found = { trigger, from, to: $at.pos, query: m[1]! };
  }
  return found;
}

export function caretQueryPlugin(triggers: readonly Trigger[], onKey: (e: KeyboardEvent) => boolean): Plugin<QueryState> {
  return new Plugin<QueryState>({
    key: queryKey,
    state: {
      init: (_, state) => ({ q: queryAt(state, triggers), dismissed: null }),
      apply(tr: Transaction, prev: QueryState, _old, state): QueryState {
        const q = queryAt(state, triggers);
        let dismissed = tr.getMeta(queryKey) === "dismiss" ? (prev.q?.from ?? null) : prev.dismissed;
        if (dismissed !== null) dismissed = tr.mapping.map(dismissed);
        if (dismissed !== null && q?.from !== dismissed) dismissed = null;
        return { q: q && q.from !== dismissed ? q : null, dismissed };
      },
    },
    props: {
      // Before the keymaps: Enter and Tab pick from the menu instead of splitting the block or indenting.
      handleKeyDown: (view, e) => !!queryKey.getState(view.state)?.q && onKey(e),
    },
  });
}

export const caretQuery = (state: EditorState): CaretQuery | null => queryKey.getState(state)?.q ?? null;

/** Replaces the `@query` with the mention and a space after it. */
export function insertMention(view: EditorView, id: string, label: string): boolean {
  const q = caretQuery(view.state);
  if (q?.trigger !== "@") return false;
  const marks = view.state.doc.resolve(q.from).marks().filter((m) => m.type !== schema.marks.link && m.type !== schema.marks.code);
  const tr = view.state.tr.replaceWith(q.from, q.to, schema.nodes.mention!.create({ id, label: mentionLabelOf(label) }, null, marks));
  view.dispatch(tr.insertText(" ", tr.mapping.map(q.to)).scrollIntoView());
  return true;
}

/** Replaces the `#query` with the issue's key and a space: a key stays plain text (PLNR-43, issue-ref.ts), not in a link. */
export function insertIssueKey(view: EditorView, key: string): boolean {
  const q = caretQuery(view.state);
  if (q?.trigger !== "#") return false;
  const marks = view.state.doc.resolve(q.from).marks().filter((m) => m.type !== schema.marks.link);
  view.dispatch(view.state.tr.replaceWith(q.from, q.to, schema.text(`${key} `, marks)).scrollIntoView());
  return true;
}

/** Removes the `/query` and runs the block's command where it was. */
export function applyBlock(view: EditorView, command: Command): boolean {
  const q = caretQuery(view.state);
  if (q?.trigger !== "/") return false;
  view.dispatch(view.state.tr.delete(q.from, q.to));
  command(view.state, view.dispatch, view);
  return true;
}

/** Closes the menu over the current query; typing on in it does not reopen it. */
export function dismissQuery(view: EditorView): boolean {
  if (!caretQuery(view.state)) return false;
  view.dispatch(view.state.tr.setMeta(queryKey, "dismiss"));
  return true;
}
