// The editor as a React component: descriptions, the create modal, comments. Mounts ProseMirror once; props that are
// callbacks are read through refs, so a parent re-render never touches the view. Apps load it lazily: ProseMirror, the
// toolkit and the toolbar stay out of the startup JS.
import { cn } from "@rsva/ui/lib/utils";
import { useCallback, useLayoutEffect, useRef, useState, type Ref } from "react";
import type { DocNode } from "../doc.ts";
import { toMarkdown } from "../markdown.ts";
import { createEditor, type Cmd, type EditorHandle, type FileHandler, type IssueHref, type OpenIssue, type Trigger } from "../view/editor.ts";
import { blockMenu, CaretMenus, issueMenu, mentionMenu, type CaretMenu, type IssueSource, type MentionCandidate, type MentionSource } from "./caret-menu.tsx";
import { SelectionToolbar, type SelectionActions } from "./toolbar.tsx";

export type { Cmd, EditorHandle, FileHandler, IssueSource, MentionCandidate, MentionSource, SelectionActions };
export type { SelectionInfo } from "../view/editor.ts";
export { toMarkdown };

export interface RichEditorProps {
  initial: DocNode | null;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  editable?: boolean;
  onChange?: (editor: EditorHandle) => void;
  /** Every change of the document, the selection or the focus: what a toolbar outside the editor shows. */
  onUpdate?: (editor: EditorHandle) => void;
  onFocusChange?: (focused: boolean) => void;
  onSubmit?: () => void;
  /** Enter sends and Shift+Enter makes a new line (comments). Read once, when the editor mounts. */
  enterSends?: boolean;
  onEscape?: () => void;
  actions?: SelectionActions;
  /** Who "@" offers; without it, "@" is just a character. Read once, when the editor mounts. */
  mentions?: MentionSource;
  /** Where the matches of "@", "#" and "/" show as chips instead of a popup at the caret. */
  menuChips?: HTMLElement | null | undefined;
  /** Which issues "#" offers; a pick puts the key in the text. Without it, "#" is just a character. Read once, when the editor mounts. */
  issues?: IssueSource;
  /** "/" offers the toolbar's blocks. Read once, when the editor mounts. */
  blocks?: boolean;
  /** Issue keys that name an issue are drawn as links (view/issue-ref.ts). Read once, when the editor mounts. */
  issueHref?: IssueHref;
  /** A plain click on a key opens its issue this way; without it the click places the caret. Read once, when the editor mounts. */
  openIssue?: OpenIssue;
  /** Files dropped or pasted in (view/upload.ts); without it they do nothing. Read once, when the editor mounts. */
  onFiles?: FileHandler;
  editorRef?: Ref<EditorHandle | null>;
}

export function RichEditor(props: RichEditorProps) {
  const mount = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  const [links, setLinks] = useState(0);
  const listeners = useRef(new Set<() => void>());
  const [menus] = useState(() => {
    const p = latest.current;
    const m: Partial<Record<Trigger, CaretMenu>> = {};
    if (p.mentions) m["@"] = mentionMenu(p.mentions);
    if (p.issues) m["#"] = issueMenu(p.issues);
    if (p.blocks) m["/"] = blockMenu;
    return m;
  });

  useLayoutEffect(() => {
    const p = latest.current;
    const h = createEditor(mount.current!, {
      doc: p.initial,
      ...(p.placeholder ? { placeholder: p.placeholder } : {}),
      editable: p.editable !== false,
      menus: Object.keys(menus) as Trigger[],
      ...(p.issueHref ? { issueHref: p.issueHref } : {}),
      ...(p.openIssue ? { openIssue: p.openIssue } : {}),
      enterSends: !!p.enterSends,
      ...(p.onFiles ? { onFiles: (files: File[]) => latest.current.onFiles!(files) } : {}),
      onChange: () => latest.current.onChange?.(h),
      onUpdate: () => {
        for (const f of listeners.current) f();
        latest.current.onUpdate?.(h);
      },
      onFocusChange: (f) => latest.current.onFocusChange?.(f),
      onSubmit: () => latest.current.onSubmit?.(),
      onEscape: () => latest.current.onEscape?.(),
      onLink: () => setLinks((n) => n + 1),
    });
    if (p.ariaLabel) h.view.dom.setAttribute("aria-label", p.ariaLabel);
    h.view.dom.setAttribute("role", "textbox");
    h.view.dom.setAttribute("aria-multiline", "true");
    setRef(p.editorRef, h);
    setHandle(h);
    if (p.autoFocus) h.focus("end");
    return () => {
      setRef(latest.current.editorRef, null);
      h.destroy();
    };
  }, []);

  const editable = props.editable !== false;
  useLayoutEffect(() => handle?.view.setProps({ editable: () => editable }), [handle, editable]);

  const subscribe = useCallback((cb: () => void) => {
    listeners.current.add(cb);
    return () => void listeners.current.delete(cb);
  }, []);

  return (
    <>
      <div ref={mount} className={cn("rich-text-host", props.className)} />
      {handle && editable && <SelectionToolbar handle={handle} subscribe={subscribe} linkRequests={links} actions={props.actions} />}
      {handle && editable && Object.keys(menus).length > 0 && <CaretMenus handle={handle} subscribe={subscribe} menus={menus} chipsIn={props.menuChips} />}
    </>
  );
}

function setRef<T>(ref: Ref<T> | undefined, v: T): void {
  if (typeof ref === "function") ref(v);
  else if (ref) (ref as { current: T }).current = v;
}
