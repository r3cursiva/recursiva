// The editor's behaviour: Markdown shortcuts as you type, keys, paste cleanup, placeholder, node views.
import { baseKeymap, chainCommands, exitCode, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { InputRule, inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { Fragment, Node, Slice, type MarkType, type NodeType, type ResolvedPos } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";
import { Plugin, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView, type NodeView, type ViewMutationRecord } from "prosemirror-view";
import { safeHref } from "../doc.ts";
import { fromMarkdown, urlSpans } from "../markdown.ts";
import { schema } from "../schema.ts";
import { commandFor, itemType } from "./commands.ts";
import type { IssueHref } from "../issue-ref.ts";
import { issueRefPlugin, type OpenIssue } from "./issue-ref.ts";
import { caretQueryPlugin, type Trigger } from "./caret-query.ts";
import { cellBelow, nextCell, typedTable, verticalArrow } from "./table.ts";

const N = schema.nodes;
const M = schema.marks;

// ── Markdown shortcuts ────────────────────────────────────────────────────────────────────────────────────────

/** `**x**` → bold x: the delimiters go, the mark stays off for what is typed next. */
function markRule(re: RegExp, type: MarkType): InputRule {
  return new InputRule(re, (state, match, start, end) => {
    const tr = state.tr.replaceWith(start, end, schema.text(match[1]!, [...state.doc.resolve(start).marks().filter((m) => m.type !== type), type.create()]));
    return tr.removeStoredMark(type);
  });
}

/** A typed URL ending at the caret: after a space or at the line's start, without the punctuation that ends a sentence. */
const TYPED_URL = /(?:^|\s)(https?:\/\/[^\s]+[^\s.,;:!?)'"])$/;

/** Links the URL that ends at `end`, unless it is not safe or is a link already. */
function linkTyped(state: EditorState, end: number, url: string): Transaction | null {
  const href = safeHref(url);
  const from = end - url.length;
  if (!href || state.doc.rangeHasMark(from, end, M.link!)) return null;
  return state.tr.addMark(from, end, M.link!.create({ href }));
}

/** A URL followed by a space becomes a link. The typed space is not in the document yet: the URL ends at `end`. */
const autolink = new InputRule(new RegExp(`${TYPED_URL.source.slice(0, -1)}\\s$`), (state, m, _start, end) => linkTyped(state, end, m[1]!)?.insertText(" ", end) ?? null);

/**
 * Enter after a URL links it, as a space does (RSVA-627): the link first, then the key's own command on the state it leaves.
 * An input rule sees typed text only, and Enter is a key.
 */
const linkingUrl =
  (cmd: Command): Command =>
  (state, dispatch, view) => {
    const $c = state.selection.$from;
    const m = state.selection.empty && !$c.parent.type.spec.code ? TYPED_URL.exec($c.parent.textBetween(Math.max(0, $c.parentOffset - 4096), $c.parentOffset, undefined, "￼")) : null;
    const tr = m ? linkTyped(state, $c.pos, m[1]!) : null;
    if (!tr || !dispatch || !view) return cmd(state, dispatch, view);
    dispatch(tr);
    return cmd(view.state, view.dispatch, view);
  };

/** "[ ] " or "[x] " at the start of a paragraph, or of a bullet item, makes a task. */
const taskRule = new InputRule(/^\[( |x)\]\s$/, (state, m, start, end) => {
  const $s = state.doc.resolve(start);
  const checked = m[1] === "x";
  const li = $s.node(-1);
  const list = $s.node(-2);
  if (li?.type === N.list_item && list?.type === N.bullet_list && list.childCount === 1) {
    const listPos = $s.before(-2);
    const tr = state.tr.delete(start, end);
    const item = tr.doc.nodeAt(listPos)!.firstChild!;
    tr.replaceWith(listPos, listPos + tr.doc.nodeAt(listPos)!.nodeSize, N.task_list!.create(null, N.task_item!.create({ checked }, item.content)));
    return tr.setSelection(TextSelection.create(tr.doc, listPos + 3));
  }
  const tr = state.tr.delete(start, end);
  const range = tr.doc.resolve(start).blockRange();
  return range ? tr.wrap(range, [{ type: N.task_list! }, { type: N.task_item!, attrs: { checked } }]) : null;
});

const rules = inputRules({
  rules: [
    textblockTypeInputRule(/^(#{1,3})\s$/, N.heading!, (m) => ({ level: m[1]!.length })),
    wrappingInputRule(/^\s*>\s$/, N.blockquote!),
    wrappingInputRule(/^\s*([-+*])\s$/, N.bullet_list!),
    wrappingInputRule(/^(\d+)[.)]\s$/, N.ordered_list!, (m) => ({ order: +m[1]! }), (m, n) => n.childCount + (n.attrs.order as number) === +m[1]!),
    taskRule,
    new InputRule(/^\|--$/, (state, _m, start, end) => typedTable(state, start, end)),
    textblockTypeInputRule(/^```([\w+#.-]*)\s$/, N.code_block!, (m) => ({ language: m[1] ?? "" })),
    new InputRule(/^(?:---|\*\*\*|___)$/, (state, _m, start, end) => {
      const $s = state.doc.resolve(start);
      if ($s.parent.type !== N.paragraph || $s.parent.content.size !== end - start) return null;
      const tr = state.tr.replaceWith($s.before(), $s.after(), [N.horizontal_rule!.create(), N.paragraph!.create()]);
      return tr.setSelection(TextSelection.create(tr.doc, $s.before() + 2));
    }),
    markRule(/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, M.bold!),
    markRule(/__([^_\s](?:[^_]*[^_\s])?)__$/, M.bold!),
    markRule(/(?<![*\w])\*([^*\s](?:[^*]*[^*\s])?)\*$/, M.italic!),
    markRule(/(?<![_\w])_([^_\s](?:[^_]*[^_\s])?)_$/, M.italic!),
    markRule(/~~([^~\s](?:[^~]*[^~\s])?)~~$/, M.strike!),
    markRule(/`([^`]+)`$/, M.code!),
    autolink,
  ],
});

// ── Keys ──────────────────────────────────────────────────────────────────────────────────────────────────────

const inList = (fn: (t: NodeType) => Command): Command => (s, d, v) => fn(itemType(s))(s, d, v);

const hardBreak: Command = (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(N.hard_break!.create()).scrollIntoView());
  return true;
};

export interface KeyHooks {
  submit?: () => void;
  /** Enter sends, as in a chat (comments); Shift+Enter then does what Enter does in a description. */
  enterSends?: boolean;
  link?: () => void;
}

function keys(hooks: KeyHooks): Plugin[] {
  const run = (c: Parameters<typeof commandFor>[0]): Command => commandFor(c);
  // An IME's Enter, which picks a candidate, never gets here: ProseMirror ignores keys in and right after composition.
  const send: Command = () => {
    if (!hooks.submit) return false;
    hooks.submit();
    return true;
  };
  const newLine = inList(splitListItem);
  return [
    keymap({
      "Mod-z": undo,
      "Shift-Mod-z": redo,
      "Mod-y": redo,
      Backspace: undoInputRule,
      "Mod-b": toggleMark(M.bold!),
      "Mod-i": toggleMark(M.italic!),
      "Mod-u": toggleMark(M.underline!),
      "Mod-e": toggleMark(M.code!),
      "Shift-Mod-x": toggleMark(M.strike!),
      "Mod-Alt-0": run("paragraph"),
      "Mod-Alt-1": run("h1"),
      "Mod-Alt-2": run("h2"),
      "Mod-Alt-3": run("h3"),
      "Shift-Mod-7": run("ordered_list"),
      "Shift-Mod-8": run("bullet_list"),
      "Shift-Mod-9": run("task_list"),
      "Shift-Mod-b": run("quote"),
      "Mod-k": () => {
        hooks.link?.();
        return !!hooks.link;
      },
      "Mod-Enter": linkingUrl(send),
      // A cell is one line: Enter (Shift+Enter where Enter sends) goes to the cell below, as a break has no place there.
      Enter: linkingUrl(hooks.enterSends ? send : chainCommands(cellBelow, newLine)),
      Tab: chainCommands(nextCell(1), inList(sinkListItem)),
      "Shift-Tab": chainCommands(nextCell(-1), inList(liftListItem)),
      "Shift-Enter": linkingUrl(hooks.enterSends ? chainCommands(cellBelow, newLine, baseKeymap.Enter!) : chainCommands(exitCode, cellBelow, hardBreak)),
      ArrowUp: verticalArrow("up"),
      ArrowDown: verticalArrow("down"),
    }),
    keymap(baseKeymap),
  ];
}

// ── Paste ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Plain text that looks like Markdown (copied from a terminal, an agent's answer, a README) pastes formatted. */
const MARKDOWN_HINT = /^(#{1,3} |[-*+] |\d+[.)] |> |```|- \[[ x]\] |\|? *:?-+:? *\|)|\*\*\S|__\S|~~\S|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`/m;

export function markdownSlice(text: string): Slice | null {
  if (!MARKDOWN_HINT.test(text)) return null;
  const doc = Node.fromJSON(schema, fromMarkdown(text));
  return Slice.maxOpen(doc.content);
}

/** A line of pasted text, its bare URLs linked. */
function linkedText(line: string): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const { from, to, href } of urlSpans(line)) {
    if (from > at) out.push(schema.text(line.slice(at, from)));
    out.push(schema.text(line.slice(from, to), [M.link!.create({ href })]));
    at = to;
  }
  if (at < line.length) out.push(schema.text(line.slice(at)));
  return out;
}

const paste = new Plugin({
  props: {
    // A URL pasted over selected text links it.
    handlePaste(view, e) {
      const text = e.clipboardData?.getData("text/plain")?.trim() ?? "";
      const href = /^\S+$/.test(text) ? safeHref(text) : null;
      if (view.state.selection.empty || !href || view.state.selection.$from.parent.type.spec.code) return false;
      const { from, to } = view.state.selection;
      view.dispatch(view.state.tr.removeMark(from, to, M.link).addMark(from, to, M.link!.create({ href })));
      return true;
    },
    clipboardTextParser(text: string, $context: ResolvedPos, plain: boolean): Slice {
      const md = !plain && !$context.parent.type.spec.code ? markdownSlice(text) : null;
      if (md) return md;
      // ProseMirror's default for plain text: a paragraph per line; its bare URLs are links (RSVA-627).
      const blocks = text.replace(/\r\n?/g, "\n").split(/\n/);
      if ($context.parent.type.spec.code) return new Slice(Fragment.from(schema.text(text.replace(/\r\n?/g, "\n"))), 0, 0);
      return Slice.maxOpen(Fragment.from(blocks.map((l) => N.paragraph!.create(null, l ? linkedText(l) : null))));
    },
    // Links in pasted HTML that are not http(s) or mailto are dropped by the schema's parse rules (text stays).
    transformPastedHTML(html: string) {
      // Word's conditional comments and Office namespaces carry nothing we keep.
      return html.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "").replace(/<\/?o:p>/gi, "");
    },
  },
});

/** ⌘/Ctrl-click opens a link in a new tab (a plain click places the caret, as in Linear). */
const linkClick = new Plugin({
  props: {
    handleClick(view, pos, e) {
      if (!(e.metaKey || e.ctrlKey)) return false;
      const link = view.state.doc.resolve(pos).marks().find((m) => m.type === M.link);
      if (!link) return false;
      window.open(link.attrs.href as string, "_blank", "noopener,noreferrer");
      return true;
    },
  },
});

// ── Placeholder ───────────────────────────────────────────────────────────────────────────────────────────────

function placeholder(text: string): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const d = state.doc;
        if (d.childCount !== 1 || !d.firstChild!.isTextblock || d.firstChild!.content.size) return null;
        return DecorationSet.create(d, [Decoration.node(0, d.firstChild!.nodeSize, { class: "is-empty", "data-placeholder": text })]);
      },
    },
  });
}

export function plugins(
  opts: { placeholder?: string; menus?: { triggers: readonly Trigger[]; keys: (e: KeyboardEvent) => boolean }; issueHref?: IssueHref; openIssue?: OpenIssue } & KeyHooks,
): Plugin[] {
  return [
    ...(opts.menus?.triggers.length ? [caretQueryPlugin(opts.menus.triggers, opts.menus.keys)] : []),
    ...(opts.issueHref ? [issueRefPlugin(opts.issueHref, opts.openIssue)] : []),
    rules,
    ...keys(opts),
    history(),
    paste,
    linkClick,
    ...(opts.placeholder ? [placeholder(opts.placeholder)] : []),
  ];
}

// ── Node views ────────────────────────────────────────────────────────────────────────────────────────────────

/** A task: a real checkbox before the text; toggling it is a change like typing. */
class TaskView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private box: HTMLInputElement;
  private node: Node;
  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.dom = document.createElement("li");
    this.dom.dataset.checked = String(node.attrs.checked);
    const box = (this.box = document.createElement("input"));
    box.type = "checkbox";
    box.checked = node.attrs.checked as boolean;
    box.contentEditable = "false";
    box.setAttribute("aria-label", "Done");
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      const p = getPos();
      if (p != null && view.editable) view.dispatch(view.state.tr.setNodeAttribute(p, "checked", !this.node.attrs.checked));
    });
    this.contentDOM = document.createElement("div");
    this.dom.append(box, this.contentDOM);
  }
  update(n: Node): boolean {
    if (n.type !== this.node.type) return false;
    this.node = n;
    this.box.checked = n.attrs.checked as boolean;
    this.dom.dataset.checked = String(n.attrs.checked);
    return true;
  }
  ignoreMutation(m: ViewMutationRecord): boolean {
    return m.type !== "selection" && !this.contentDOM.contains(m.target);
  }
}

export const nodeViews = {
  task_item: (n: Node, v: EditorView, g: () => number | undefined) => new TaskView(n, v, g),
};
