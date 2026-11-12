// An editor on a DOM element: the ProseMirror view with our schema and plugins, behind a small handle the React layer
// and tests use. No React here.
import { Node } from "prosemirror-model";
import { EditorState, Selection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { emptyDoc, withoutSections, type DocNode } from "../doc.ts";
import type { IssueHref } from "../issue-ref.ts";
import { schema } from "../schema.ts";
import { commandFor, isActive, linkAt, setLink, type Cmd } from "./commands.ts";
import { applyBlock, caretQuery, dismissQuery, insertIssueKey, insertMention, type CaretQuery, type Trigger } from "./caret-query.ts";
import type { OpenIssue } from "./issue-ref.ts";
import { nodeViews, plugins } from "./plugins.ts";
import { upload, uploadPlugin, type FileHandler } from "./upload.ts";

export type { Cmd, FileHandler, IssueHref, OpenIssue, Trigger };

export interface EditorOptions {
  doc: DocNode | null;
  placeholder?: string;
  editable?: boolean;
  /** The document changed (typing, a command, a checkbox). Read it with getDoc() when needed: toJSON costs on big ones. */
  onChange?: () => void;
  /** Selection or document changed: the toolbar redraws. */
  onUpdate?: () => void;
  onFocusChange?: (focused: boolean) => void;
  /** ⌘/Ctrl+Enter, and Enter with `enterSends`. */
  onSubmit?: () => void;
  /** Enter sends and Shift+Enter makes a new line, as in a chat (comments). */
  enterSends?: boolean;
  /** Esc, after the editor has given up focus. */
  onEscape?: () => void;
  /** ⌘/Ctrl+K: the toolbar opens its link field. */
  onLink?: () => void;
  /** The menus at the caret to track a query for (caretQuery, insertMention, insertIssueKey, applyBlock). */
  menus?: readonly Trigger[];
  /** Draw issue keys that name an issue as links (view/issue-ref.ts). */
  issueHref?: IssueHref;
  /** A plain click on a drawn key opens its issue this way; without it the click places the caret (view/issue-ref.ts). */
  openIssue?: OpenIssue;
  /** Files dropped or pasted in: the app uploads them and gives back images to insert (view/upload.ts). */
  onFiles?: FileHandler;
}

export interface SelectionInfo {
  text: string;
  /** The selected part as a document (lists and blocks closed around it). */
  doc: DocNode;
}

export interface EditorHandle {
  readonly view: EditorView;
  getDoc(): DocNode;
  /** Replaces the content (a change from elsewhere); keeps the caret near where it was. Undo history starts over. */
  setDoc(doc: DocNode | null): void;
  isEmpty(): boolean;
  focus(at?: "start" | "end"): void;
  run(c: Cmd): boolean;
  isActive(c: Cmd): boolean;
  setLink(url: string): boolean;
  linkAt(): string;
  /** A non-empty selection: cheap, called on every update. */
  hasSelection(): boolean;
  /** What is selected, as text and as a document; null for an empty selection. */
  selection(): SelectionInfo | null;
  /** The `@query`, `#query` or `/query` the caret is in, for the menus option; null otherwise or after Esc. */
  caretQuery(): CaretQuery | null;
  /** Puts the person in place of the `@query`. */
  insertMention(id: string, label: string): boolean;
  /** Puts the issue's key in place of the `#query`. */
  insertIssueKey(key: string): boolean;
  /** Removes the `/query` and turns the text there into the block. */
  applyBlock(c: Cmd): boolean;
  /** Closes the menu over the current query (Esc); typing on in it does not reopen it. */
  dismissQuery(): boolean;
  /** Keys while a query is open (arrows, Enter, Tab): the menu takes them, or returns false to let them through. */
  setMenuKeys(fn: ((e: KeyboardEvent) => boolean) | null): void;
  /** Files picked with a button: handled at the caret as if they were dropped there. Needs the onFiles option. */
  addFiles(files: File[]): void;
  /** A button's "@": at the caret, after a space if it follows a word, so the menu opens as for a typed one. */
  startMention(): void;
  /** Opens the link field over the selection, as ⌘K does. */
  requestLink(): void;
  destroy(): void;
}

// A stored description with a collapsible section opens with it opened out, and is saved so on its next edit (doc.ts).
const toNode = (doc: DocNode | null) => Node.fromJSON(schema, doc ? withoutSections(doc) : emptyDoc());

export function createEditor(mount: HTMLElement, o: EditorOptions): EditorHandle {
  let menuKeys: ((e: KeyboardEvent) => boolean) | null = null;
  const make = (doc: DocNode | null) =>
    EditorState.create({
      doc: toNode(doc),
      plugins: [...(o.onFiles ? [uploadPlugin(o.onFiles)] : []), ...plugins({
        ...(o.placeholder ? { placeholder: o.placeholder } : {}),
        ...(o.menus ? { menus: { triggers: o.menus, keys: (e: KeyboardEvent) => menuKeys?.(e) ?? false } } : {}),
        ...(o.issueHref ? { issueHref: o.issueHref } : {}),
        ...(o.openIssue ? { openIssue: o.openIssue } : {}),
        ...(o.onSubmit ? { submit: o.onSubmit } : {}),
        ...(o.enterSends ? { enterSends: true } : {}),
        ...(o.onLink ? { link: o.onLink } : {}),
      })],
    });
  const view: EditorView = new EditorView(mount, {
    state: make(o.doc),
    editable: () => o.editable !== false,
    nodeViews,
    attributes: { class: "rich-text", spellcheck: "true" },
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr));
      if (tr.docChanged) o.onChange?.();
      o.onUpdate?.();
    },
    handleDOMEvents: {
      focus: () => {
        o.onFocusChange?.(true);
        o.onUpdate?.();
        return false;
      },
      blur: () => {
        o.onFocusChange?.(false);
        o.onUpdate?.();
        return false;
      },
    },
    handleKeyDown(v, e) {
      if (e.key !== "Escape" || e.defaultPrevented) return false;
      // Esc leaves the editor, or closes a caret menu while it shows; the peek or dialog around it stays open either way.
      e.stopPropagation();
      if (menuKeys?.(e)) return true;
      (v.dom as HTMLElement).blur();
      o.onEscape?.();
      return true;
    },
  });

  /** A menu's pick leaves the focus in the editor. */
  const focused = (ok: boolean) => {
    view.focus();
    return ok;
  };

  const handle: EditorHandle = {
    view,
    getDoc: () => JSON.parse(JSON.stringify(view.state.doc.toJSON())) as DocNode,
    setDoc(doc) {
      const at = view.state.selection.from;
      const state = make(doc);
      const pos = Math.min(at, state.doc.content.size);
      view.updateState(state.apply(state.tr.setSelection(Selection.near(state.doc.resolve(pos)))));
      o.onUpdate?.();
    },
    isEmpty() {
      const d = view.state.doc;
      return d.childCount === 1 && d.firstChild!.type === schema.nodes.paragraph && d.firstChild!.content.size === 0;
    },
    focus(at) {
      if (at) {
        const sel = at === "start" ? Selection.atStart(view.state.doc) : Selection.atEnd(view.state.doc);
        view.dispatch(view.state.tr.setSelection(sel));
      }
      view.focus();
    },
    run(c) {
      const ok = commandFor(c)(view.state, view.dispatch, view);
      view.focus();
      return ok;
    },
    isActive: (c) => isActive(view.state, c),
    setLink(url) {
      const ok = setLink(url)(view.state, view.dispatch, view);
      // A refused URL keeps the focus where it is: the toolbar's link field stays to be corrected.
      if (ok) view.focus();
      return ok;
    },
    linkAt: () => linkAt(view.state),
    hasSelection: () => !view.state.selection.empty,
    selection() {
      const { from, to, empty } = view.state.selection;
      if (empty) return null;
      return {
        text: view.state.doc.textBetween(from, to, "\n", " "),
        doc: JSON.parse(JSON.stringify(view.state.doc.cut(from, to).toJSON())) as DocNode,
      };
    },
    caretQuery: () => caretQuery(view.state),
    addFiles: (files) => {
      if (o.onFiles) upload(view, files, view.state.selection.from, o.onFiles);
    },
    startMention() {
      const { $from } = view.state.selection;
      const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset);
      view.dispatch(view.state.tr.insertText(before && !/\s/.test(before) ? " @" : "@"));
      view.focus();
    },
    requestLink: () => o.onLink?.(),
    insertMention: (id, label) => focused(insertMention(view, id, label)),
    insertIssueKey: (key) => focused(insertIssueKey(view, key)),
    applyBlock: (c) => focused(applyBlock(view, commandFor(c))),
    dismissQuery: () => dismissQuery(view),
    setMenuKeys(fn) {
      menuKeys = fn;
    },
    destroy: () => view.destroy(),
  };
  return handle;
}
