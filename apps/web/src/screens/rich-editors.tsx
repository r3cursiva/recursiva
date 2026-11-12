// The three places that edit rich text: the issue pane's description, the comment composer and the create modal's
// description, on the editor of packages/editor (ProseMirror, our toolkit and toolbar). It lives in the edit chunk,
// which loads after the list has painted: a separate editor chunk was measured and lost (commit message, "Chunks").
import { emptyDoc, sameDoc, type DocNode } from "@rsva/editor/doc";
import { fromMarkdown } from "@rsva/editor/markdown";
import { RichEditor, toMarkdown, type Cmd, type EditorHandle, type IssueSource, type MentionCandidate, type MentionSource, type SelectionActions, type SelectionInfo } from "@rsva/editor/editor";
import type { DocJSON, Issue } from "@rsva/schema/models";
import { observer } from "mobx-react-lite";
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { readSession, removeSession, writeSession } from "../lib/local-storage.ts";
import { drafts } from "../lib/drafts.ts";
import { beforeReload, handedOver, handover } from "../lib/new-version.ts";
import { isTouch, useIsPhone } from "../lib/phone.ts";
import { signedInUser } from "../auth.ts";
import type { Uploaded } from "../lib/upload.ts";
import { currentEngine, store } from "../store.ts";
import { followsServer } from "../lib/description-base.ts";
import { commentQuote } from "./comment-quote.ts";
import { ArrowUpIcon, AtIcon, CodeIcon, LinkSimpleIcon, ListBulletsIcon, ListChecksIcon, PaperclipIcon, PlusIcon, TextBIcon, TextItalicIcon } from "@phosphor-icons/react";
import { Button } from "@rsva/ui/components/button";
import { keys } from "@rsva/ui/lib/keys";
import { cn } from "@rsva/ui/lib/utils";
import { createIssue } from "./create-state.ts";
import { filesFor } from "./files.tsx";
import { issueHref, openIssueRef } from "./issue-ref.ts";
import { liveIssueIndex } from "./issue-index.ts";
import { search } from "@rsva/display/search";
import { mentionCandidates } from "@rsva/display/mention";
import { copyIssueLink } from "./issue-actions.ts";
import { face } from "../lib/face.ts";
import { useFilePicker } from "./file-picker.tsx";

/**
 * Who "@" offers: the workspace's members but guests, read when the menu opens, so a member who joins shows at once. A name that
 * starts with the query comes first, then a word of the name, then the email.
 */
const mentionSource: MentionSource = {
  search(query): MentionCandidate[] {
    return mentionCandidates(store.users.values(), query).map((u) => ({ id: u.id, label: u.name, src: face(u).src, detail: u.kind === "agent" ? "agent" : u.email }));
  },
};

/** Which issues "#" offers: the palette's search over the live issues, by key or words of the title, indexed once per "#". */
const issueSource: IssueSource = {
  open() {
    const index = liveIssueIndex();
    return (query) => search(index, query, 8).map((i) => ({ key: store.issueKey(i), title: i.title }));
  },
};

/** Idle time before a description is saved, and the longest it waits while someone keeps typing. */
const SAVE_IDLE_MS = 600;
const SAVE_MAX_MS = 4000;

/** Selection actions over an issue's text: a new issue from it, a link to this issue, a quote in a comment. */
function selectionActions(issue: Issue): SelectionActions {
  return {
    createIssue: (s) => createIssue.show({}, issue.projectId, fromSelection(s)),
    share: () => copyIssueLink(issue),
    comment: (s) => commentQuote.request(issue.id, toMarkdown({ type: "doc", content: [{ type: "blockquote", content: (s.doc.content ?? []) as DocNode[] }] })),
  };
}

/** The first line is the title (cut at a word near 120 characters); longer or multi-line text also goes in as the description. */
function fromSelection(s: Pick<SelectionInfo, "text" | "doc">): { title: string; description: DocJSON | null } {
  const lines = s.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const title = first.length > 120 ? first.slice(0, first.lastIndexOf(" ", 120) > 60 ? first.lastIndexOf(" ", 120) : 120).trimEnd() + "…" : first;
  const more = lines.length > 1 || title !== first;
  return { title, description: more ? (s.doc as DocJSON) : null };
}

/** "New issue from comment": as if the whole comment had been selected in it. */
export function issueFromComment(body: string, projectId: string): void {
  createIssue.show({}, projectId, fromSelection({ text: body, doc: fromMarkdown(body) as SelectionInfo["doc"] }));
}

type SaveState = "idle" | "editing" | "saved";

/**
 * The open issue's description. Changes save after a short pause (and at most every few seconds while typing, and on leaving
 * the editor) through the optimistic queue: they show everywhere at once and survive going offline. A save from
 * elsewhere (another tab, an agent) replaces the text when there are no unsaved changes here; until Yjs, the last save
 * wins.
 */
export const DescriptionEditor = observer(function DescriptionEditor({ issue, className }: { issue: Issue; className?: string | undefined }) {
  const row = store.description(issue.id);
  // A save replaces the whole text: not on top of a copy known to be out of date.
  const behind = store.feed(issue.id).behind;
  const handle = useRef<EditorHandle | null>(null);
  const dirty = useRef(false);
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const max = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [state, setState] = useState<SaveState>("idle");
  const initial = useMemo(() => (row?.doc as DocNode | null | undefined) ?? null, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The save this text grew from, and the last text sent from here: a save refused because the text moved on loses nothing
  // in silence, and one of ours coming back is not "someone else's".
  const seen = useRef(row?.tx);
  const sent = useRef<DocNode | null>(null);
  // The engine of this issue: leaving the workspace saves the last words there, not in the one on screen by then.
  const engine = useRef(currentEngine()).current;

  const flush = () => {
    clearTimeout(idle.current);
    clearTimeout(max.current);
    max.current = undefined;
    const h = handle.current;
    if (!h || !dirty.current) return;
    dirty.current = false;
    // A save replaces the whole text. Whatever marked this dirty, it does not go over a text that may be newer.
    if (store.feed(issue.id).behind) return;
    const doc = (h.isEmpty() ? emptyDoc() : h.getDoc()) as DocJSON;
    sent.current = doc as DocNode;
    engine.updateDescription(issue.id, doc, seen.current);
    setState("saved");
  };
  const latestFlush = useRef(flush);
  latestFlush.current = flush;
  useEffect(() => {
    // Closing the tab is leaving too: up to four seconds of typing wait for the timers.
    const save = () => latestFlush.current();
    addEventListener("pagehide", save);
    return () => {
      removeEventListener("pagehide", save);
      save();
    };
  }, []);

  // Someone else's save: take it unless there is unsaved typing here, which then goes out as an edit of the older text.
  const saving = store.isPending(issue.id, "Document");
  useEffect(() => {
    const h = handle.current;
    if (!h || !row) return;
    const text = (row.doc as DocNode | null) ?? emptyDoc();
    if (followsServer(saving, dirty.current, sent.current !== null && sameDoc(text, sent.current))) seen.current = row.tx;
    if (!saving && !dirty.current && !sameDoc(h.getDoc(), text)) h.setDoc((row.doc as DocNode | null) ?? null);
  }, [row?.doc, row?.tx, saving]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cn("relative mt-4", className)}>
      <RichEditor
        editorRef={handle}
        initial={initial}
        placeholder="Add description…"
        ariaLabel="Description"
        className="min-h-12"
        editable={!behind}
        actions={selectionActions(issue)}
        mentions={mentionSource}
        issues={issueSource}
        blocks
        issueHref={issueHref}
        openIssue={openIssueRef}
        onFiles={filesFor(issue.id)}
        onChange={() => {
          dirty.current = true;
          setState("editing");
          clearTimeout(idle.current);
          idle.current = setTimeout(() => latestFlush.current(), SAVE_IDLE_MS);
          max.current ??= setTimeout(() => latestFlush.current(), SAVE_MAX_MS);
        }}
        onFocusChange={(focused) => {
          if (!focused) latestFlush.current();
        }}
      />
      <SaveStatus issueId={issue.id} state={state} />
    </div>
  );
});

/** Quiet: "Saving…" while typing or unconfirmed, "Offline · will sync" without a connection, "Saved" briefly after. */
const SaveStatus = observer(function SaveStatus({ issueId, state }: { issueId: string; state: SaveState }) {
  const pending = store.isPending(issueId, "Document");
  const offline = store.connection !== "online";
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (state !== "saved" || pending) return;
    setShown(true);
    const t = setTimeout(() => setShown(false), 1500);
    return () => clearTimeout(t);
  }, [state, pending]);
  const text = pending && offline ? "Offline · will sync" : state === "editing" || pending ? "Saving…" : shown && !store.lastRejection ? "Saved" : "";
  return (
    <p aria-live="polite" data-save-state={text ? text.split(" ")[0]!.toLowerCase() : "idle"} className="pointer-events-none absolute -bottom-5 right-0 h-4 text-xs text-muted-foreground">
      {text}
    </p>
  );
});

const DRAFTS_KEY = "rsva:drafts";
/** Drafts survive closing the issue or switching issues, until sent, and a reload for a new version (lib/drafts.ts). */
const handed = drafts(handedOver(readSession(DRAFTS_KEY), signedInUser()));
removeSession(DRAFTS_KEY);
const texts = handed.texts;
beforeReload(() => {
  const me = store.me?.id;
  if (me && texts.size) writeSession(DRAFTS_KEY, handover(me, [...texts]));
});
/** A reply's or an edit's composer with a draft a reload handed over: open it again (lib/drafts.ts). */
export const reopensDraft = handed.reopens;

type Tool = Cmd | "mention" | "attach" | "sep";
type Tools = "comment" | "reply" | "edit";

/** A wide pane's buttons under the text, as the artboard gives each field. A phone has its toolbar over a selection. */
const TOOLS: Record<Tools, readonly Tool[]> = {
  comment: ["bold", "italic", "code", "bullet_list", "task_list", "link", "sep", "mention", "attach"],
  reply: ["bold", "code", "mention", "attach"],
  edit: ["bold", "italic", "code", "bullet_list"],
};
const TOOL: Partial<Record<Tool, { label: string; icon: ReactNode }>> = {
  bold: { label: "Bold", icon: <TextBIcon /> },
  italic: { label: "Italic", icon: <TextItalicIcon /> },
  code: { label: "Code", icon: <CodeIcon /> },
  bullet_list: { label: "Bulleted list", icon: <ListBulletsIcon /> },
  task_list: { label: "Checklist", icon: <ListChecksIcon /> },
  link: { label: "Link", icon: <LinkSimpleIcon /> },
  mention: { label: "Mention", icon: <AtIcon /> },
  attach: { label: "Attach file", icon: <PaperclipIcon /> },
};
const isCmd = (t: Tool): t is Cmd => t !== "mention" && t !== "attach" && t !== "sep";
/** The commands lit at the caret, and whether text is selected: a string, so an unchanged state sets nothing. */
const litOf = (h: EditorHandle, tools: readonly Tool[]): string => [...tools.filter((t) => isCmd(t) && h.isActive(t)), h.hasSelection() ? "selection" : ""].join();

/** The buttons. They keep the editor's focus (mousedown is prevented), so the selection stays. */
function ComposerTools({ tools, lit, handle, onAttach }: { tools: readonly Tool[]; lit: string; handle: RefObject<EditorHandle | null>; onAttach?: (() => void) | undefined }) {
  const on = new Set(lit.split(","));
  const press = (t: Tool) => {
    const h = handle.current;
    if (!h) return;
    if (t === "attach") onAttach?.();
    else if (t === "mention") h.startMention();
    else if (t === "link") h.requestLink();
    else if (isCmd(t)) h.run(t);
  };
  return (
    <div className="flex flex-wrap items-center gap-px max-md:hidden">
      {tools.map((t, i) => {
        if (t === "sep") return <span key={i} aria-hidden className="mx-1 h-3.5 w-px bg-rule" />;
        if (t === "attach" && !onAttach) return null;
        const { label, icon } = TOOL[t]!;
        return (
          <Button
            key={t}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            title={t === "link" && !on.has("selection") ? "Select text to link it" : label}
            {...(isCmd(t) && t !== "link" ? { "aria-pressed": on.has(t) } : {})}
            disabled={t === "link" && !on.has("selection")}
            className="size-[26px] text-ink-3 hover:text-ink aria-pressed:bg-row-selected aria-pressed:text-ink"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => press(t)}
          >
            {icon}
          </Button>
        );
      })}
    </div>
  );
}

/** The composer's box: the editor and the send row; on a phone `above` over them, `attach` before the field. */
function ComposerFrame({
  submitLabel,
  canSubmit,
  onSubmit,
  onCancel,
  above,
  attach,
  tools,
  hint,
  children,
}: {
  submitLabel: string;
  canSubmit: boolean;
  onSubmit: () => void;
  onCancel?: (() => void) | undefined;
  above: ReactNode;
  attach: ReactNode;
  tools: ReactNode;
  hint: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="rounded-(--float-radius) border border-control-border bg-field transition-[border-color,box-shadow] duration-120 focus-within:border-ink-3 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-ink)_7%,transparent)] max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:shadow-none! max-md:focus-within:border-0" data-composer="">
      <div className="md:hidden">{above}</div>
      <div className="max-md:flex max-md:items-end max-md:gap-1.5">
        {attach}
        <div className="max-md:min-w-0 max-md:flex-1 max-md:rounded-[20px] max-md:border max-md:border-control-border max-md:bg-field max-md:transition-colors max-md:focus-within:border-ink-3">{children}</div>
        {/* A narrow pane wraps the send button under the tools rather than past the border. */}
        <div className="flex flex-wrap items-center gap-1 px-1.5 pt-[3px] pb-1.5 max-md:shrink-0 max-md:flex-nowrap max-md:p-0">
          {tools}
          {hint && <span className="ml-auto text-[11.5px] text-ink-3 max-md:hidden">{hint}</span>}
          {onCancel && (
            <Button variant="ghost" size="sm" className={cn(hint ? "ml-1" : "ml-auto", "max-md:ml-0 max-md:h-10")} onClick={onCancel}>
              Cancel
            </Button>
          )}
          {/* On a phone the round send button of the IssuePhone artboard. */}
          <Button size="sm" aria-label={submitLabel} className={cn(!onCancel && "ml-auto", "max-md:ml-0 max-md:size-10 max-md:rounded-full max-md:bg-inverse max-md:p-0 max-md:text-inverse-ink max-md:disabled:opacity-30")} disabled={!canSubmit} onMouseDown={(e) => e.preventDefault()} onClick={onSubmit}>
            <ArrowUpIcon weight="bold" className="size-[18px]! md:hidden" />
            <span className="max-md:hidden">{submitLabel}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The comment composer: Markdown in (a draft or the comment being edited) and out, the same dialect agents write.
 * Enter sends and Shift+Enter makes a new line, as in a chat (⌘/Ctrl+Enter sends too); Esc leaves the editor (or cancels
 * an edit or a reply).
 */
export function Composer({
  issue,
  draftKey,
  initial = "",
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus,
  quotes,
  above,
  tools = "comment",
}: {
  issue?: Issue | undefined;
  draftKey: string;
  initial?: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string) => void;
  onCancel?: (() => void) | undefined;
  autoFocus?: boolean | undefined;
  /** Take quote requests for this issue (the issue's main composer). */
  quotes?: boolean | undefined;
  /** On a phone, over the field: what a reply answers. */
  above?: ReactNode;
  /** Which buttons a wide pane has under the text. */
  tools?: Tools;
}) {
  const handle = useRef<EditorHandle | null>(null);
  const picker = useFilePicker((files) => handle.current?.addFiles(files));
  const phone = useIsPhone();
  // On a phone the matches of "@", "#" and "/" are chips over the field: a popup at the caret would land under the finger.
  const [chips, setChips] = useState<HTMLElement | null>(null);
  const start = texts.get(draftKey) ?? initial;
  const [empty, setEmpty] = useState(!start.trim());
  const [lit, setLit] = useState("");
  const doc = useMemo(() => (start.trim() ? fromMarkdown(start) : null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    const h = handle.current;
    if (!h || h.isEmpty()) return;
    const body = toMarkdown(h.getDoc()).trim();
    if (!body) return;
    onSubmit(body);
    texts.delete(draftKey);
    h.setDoc(null);
    setEmpty(true);
  };

  useEffect(() => handed.opened(draftKey), [draftKey]);

  // "Comment on selection": the quote goes in front of what is already typed, the caret after it.
  useEffect(() => {
    if (!quotes || !issue) return;
    return commentQuote.listen(issue.id, (md) => {
      const h = handle.current;
      if (!h) return;
      const current = h.isEmpty() ? "" : toMarkdown(h.getDoc());
      const doc = fromMarkdown(`${md}\n${current}`);
      // With nothing after the quote, an empty paragraph: what is typed next is the reply, not more of the quote.
      if (doc.content?.at(-1)?.type === "blockquote") doc.content.push({ type: "paragraph" });
      h.setDoc(doc);
      h.focus("end");
      h.view.dom.scrollIntoView({ block: "nearest" });
      setEmpty(false);
    });
  }, [quotes, issue]);

  return (
    <ComposerFrame
      submitLabel={submitLabel}
      canSubmit={!empty}
      onSubmit={submit}
      onCancel={onCancel}
      hint={tools === "reply" ? "Esc to cancel" : tools === "edit" ? `Esc · ${keys("mod", "↵")}` : undefined}
      tools={!phone && <ComposerTools tools={TOOLS[tools]} lit={lit} handle={handle} {...(issue ? { onAttach: picker.pick } : {})} />}
      above={
        <>
          {above}
          <div ref={setChips} />
        </>
      }
      attach={
        issue && (
          <>
            {picker.field}
            <Button variant="ghost" size="icon" aria-label="Attach files" className="size-10 shrink-0 text-ink-2 md:hidden [&_svg]:size-5!" onClick={picker.pick}>
              <PlusIcon />
            </Button>
          </>
        )
      }
    >
      <RichEditor
        editorRef={handle}
        initial={doc}
        placeholder={placeholder}
        ariaLabel={placeholder}
        autoFocus={!!autoFocus}
        className={cn("max-h-80 overflow-y-auto px-3 pt-[9px] pb-0.5 max-md:max-h-[120px] max-md:min-h-0 max-md:px-3.5 max-md:py-[9px]", tools === "comment" ? "min-h-[74px]" : "min-h-14")}
        mentions={mentionSource}
        issues={issueSource}
        blocks
        menuChips={phone ? chips : null}
        issueHref={issueHref}
        openIssue={openIssueRef}
        {...(issue ? { actions: { createIssue: selectionActions(issue).createIssue! }, onFiles: filesFor(issue.id, true) } : {})}
        onUpdate={(h) => setLit(litOf(h, TOOLS[tools]))}
        onChange={(h) => {
          const md = h.isEmpty() ? "" : toMarkdown(h.getDoc());
          if (md && md !== initial) texts.set(draftKey, md);
          else texts.delete(draftKey);
          setEmpty(h.isEmpty());
        }}
        onSubmit={submit}
        // A phone's Enter makes a new line: its send button is one tap away, and its keyboard has no Shift+Enter.
        enterSends={!isTouch()}
        {...(onCancel ? { onEscape: onCancel } : {})}
      />
    </ComposerFrame>
  );
}

/**
 * The create modal's description, a field of the LedgerNewIssue artboard: five lines tall, dragged taller by its corner, or
 * the whole height of the expanded panel, with the artboard's hint. Files that are not images wait for the issue in `onFile`.
 */
export function ModalDescription({
  initial,
  editorRef,
  expanded,
  onSubmit,
  onChange,
  onFile,
}: {
  initial: DocJSON | null;
  editorRef: Ref<EditorHandle | null>;
  expanded: boolean;
  onSubmit: () => void;
  onChange: (editor: EditorHandle) => void;
  onFile: (file: Uploaded) => void;
}) {
  const phone = useIsPhone();
  return (
    <RichEditor
      editorRef={editorRef}
      initial={(initial as DocNode | null) ?? null}
      placeholder={phone ? "Add description…" : "Add a description. Type / for blocks, @ to mention someone, # to link an issue."}
      ariaLabel="Description"
      className={cn(
        "rich-new-description flex min-h-28 flex-col overflow-y-auto max-md:max-h-[24dvh] max-md:min-h-16 [&>.ProseMirror]:flex-1",
        expanded ? "flex-1" : "md:max-h-[50vh] md:resize-y",
      )}
      mentions={mentionSource}
      issues={issueSource}
      blocks
      issueHref={issueHref}
      onFiles={filesFor(onFile)}
      onSubmit={onSubmit}
      onChange={onChange}
    />
  );
}
