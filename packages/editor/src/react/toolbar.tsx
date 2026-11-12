// The floating toolbar over a selection, Linear's set: text style menu, B I S U, link (⌘K), quote, collapsible, inline
// code, code block, list menu, and after a divider the selection actions (new issue, send, comment).
//
// Placed by useCaretPopup (caret-popup.ts). Buttons keep the editor's focus (mousedown is prevented), so the selection
// stays visible while formatting. The toolbar redraws only while it shows: typing (an empty selection) costs it one
// check per keystroke.
import {
  CaretDownIcon,
  ChatCircleTextIcon,
  LinkSimpleIcon,
  ListBulletsIcon,
  NotePencilIcon,
  PaperPlaneTiltIcon,
  TextAaIcon,
  TextBIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TextUnderlineIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { Button } from "@rsva/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { Separator } from "@rsva/ui/components/separator";
import { Hint, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@rsva/ui/components/tooltip";
import { keys } from "@rsva/ui/lib/keys";
import { cn } from "@rsva/ui/lib/utils";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Cmd, EditorHandle, SelectionInfo } from "../view/editor.ts";
import { BLOCKS, LISTS, STYLES } from "./blocks.ts";
import { CARET_POPUP_STYLE, popupRoot, rectOf, useCaretPopup } from "./caret-popup.ts";

/** What the host does with a selection. Each is optional; the toolbar shows the ones given. */
export interface SelectionActions {
  createIssue?: (s: SelectionInfo) => void;
  share?: (s: SelectionInfo) => void;
  comment?: (s: SelectionInfo) => void;
}

const MARKS: { cmd: Cmd; label: string; icon: ReactNode; keys?: string }[] = [
  { cmd: "bold", label: "Bold", icon: <TextBIcon weight="bold" />, keys: keys("mod", "B") },
  { cmd: "italic", label: "Italic", icon: <TextItalicIcon />, keys: keys("mod", "I") },
  { cmd: "strike", label: "Strikethrough", icon: <TextStrikethroughIcon />, keys: keys("mod", "shift", "X") },
  { cmd: "underline", label: "Underline", icon: <TextUnderlineIcon />, keys: keys("mod", "U") },
];

const keep = (e: { preventDefault(): void }) => e.preventDefault();

export function SelectionToolbar({
  handle,
  subscribe,
  linkRequests,
  actions,
}: {
  handle: EditorHandle;
  /** Calls back on every editor update; returns the unsubscribe. */
  subscribe: (cb: () => void) => () => void;
  /** Bumped by ⌘K in the editor. */
  linkRequests: number;
  actions?: SelectionActions | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [link, setLink] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const shown = useRef(false);
  const pointerDown = useRef(false);

  const visible = () => {
    const view = handle.view;
    if (!handle.hasSelection() || pointerDown.current) return false;
    const active = document.activeElement;
    return view.hasFocus() || menu || link !== null || (!!active && !!ref.current?.contains(active));
  };

  // Redraw on updates only while shown or about to show; an empty selection while typing costs one check.
  useEffect(
    () =>
      subscribe(() => {
        const v = visible();
        if (v || shown.current) redraw();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subscribe, menu, link],
  );

  // Not while a selection is being dragged out: the toolbar appears once the mouse is released.
  useEffect(() => {
    const dom = handle.view.dom;
    const down = () => {
      pointerDown.current = true;
      if (shown.current) redraw();
    };
    const up = () => {
      if (!pointerDown.current) return;
      pointerDown.current = false;
      redraw();
    };
    dom.addEventListener("mousedown", down);
    document.addEventListener("mouseup", up);
    return () => {
      dom.removeEventListener("mousedown", down);
      document.removeEventListener("mouseup", up);
    };
  }, [handle]);

  useEffect(() => {
    if (linkRequests && handle.hasSelection()) setLink(handle.linkAt());
  }, [linkRequests, handle]);

  const show = visible();
  shown.current = show;
  if (!show && link !== null && !handle.hasSelection()) queueMicrotask(() => setLink(null));

  useCaretPopup(
    ref,
    handle.view,
    show,
    () => {
      const view = handle.view;
      const { from, to } = view.state.selection;
      const a = view.coordsAtPos(from);
      const b = view.coordsAtPos(to, -1);
      // One line: over the selected text; several lines: over the first line, from the selection's start.
      const left = a.top === b.top ? Math.min(a.left, b.left) : a.left;
      const right = a.top === b.top ? Math.max(a.right, b.right) : a.left + 1;
      return rectOf(left, Math.min(a.top, b.top), right, Math.max(a.bottom, b.bottom));
    },
    "top",
    8,
  );

  if (!show) return null;
  const run = (c: Cmd) => {
    handle.run(c);
    redraw();
  };
  const act = (fn?: (s: SelectionInfo) => void) => () => {
    const s = handle.selection();
    if (s && fn) fn(s);
  };
  const style = STYLES.find((s) => s.cmd !== "paragraph" && handle.isActive(s.cmd));
  const list = LISTS.find((l) => handle.isActive(l.cmd));
  // A table cell takes text and marks only: no style, block or list to turn it into.
  const inTable = handle.isActive("table");

  return createPortal(
    <TooltipProvider delay={400}>
      <div
        ref={ref}
        role="toolbar"
        aria-label="Formatting"
        data-editor-toolbar=""
        style={CARET_POPUP_STYLE}
        className="z-50 flex h-8 items-center gap-0.5 rounded-(--float-radius) border bg-popover p-0.5 text-popover-foreground shadow-md ring-1 ring-foreground/5"
        onMouseDown={(e) => {
          // Keep the editor's selection, except for the link field.
          if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
        }}
      >
        {link !== null ? (
          <LinkField
            initial={link}
            apply={(url) => {
              // False for a URL setLink refuses (another scheme, not a URL): the field stays, marked invalid.
              if (!handle.setLink(url)) return false;
              setLink(null);
              return true;
            }}
            cancel={() => {
              setLink(null);
              handle.focus();
            }}
          />
        ) : (
          <>
            {!inTable && <BlockMenu label="Text style" items={STYLES} current={style} fallback={<TextAaIcon />} isActive={handle.isActive} run={run} onOpenChange={setMenu} />}
            {!inTable && <Divider />}
            {MARKS.map((m) => (
              <ToolButton key={m.cmd} cmd={m.cmd} label={m.label} keys={m.keys} active={handle.isActive(m.cmd)} onClick={() => run(m.cmd)}>
                {m.icon}
              </ToolButton>
            ))}
            <ToolButton cmd="link" label="Link" keys={keys("mod", "K")} active={handle.isActive("link")} onClick={() => setLink(handle.linkAt())}>
              <LinkSimpleIcon />
            </ToolButton>
            <Divider />
            {BLOCKS.filter((b) => !inTable || b.cmd === "code").map((b) => (
              <ToolButton key={b.cmd} cmd={b.cmd} label={b.label} keys={b.keys} active={handle.isActive(b.cmd)} onClick={() => run(b.cmd)}>
                {b.icon}
              </ToolButton>
            ))}
            {!inTable && <BlockMenu label="Lists" items={LISTS} current={list} fallback={<ListBulletsIcon />} isActive={handle.isActive} run={run} onOpenChange={setMenu} />}
            {actions && (actions.createIssue || actions.share || actions.comment) && <Divider />}
            {actions?.createIssue && (
              <ToolButton action="createIssue" label="New issue from selection" onClick={act(actions.createIssue)}>
                <NotePencilIcon />
              </ToolButton>
            )}
            {actions?.share && (
              <ToolButton action="share" label="Copy link to issue" onClick={act(actions.share)}>
                <PaperPlaneTiltIcon />
              </ToolButton>
            )}
            {actions?.comment && (
              <ToolButton action="comment" label="Comment on selection" onClick={act(actions.comment)}>
                <ChatCircleTextIcon />
              </ToolButton>
            )}
          </>
        )}
      </div>
    </TooltipProvider>,
    popupRoot(handle.view),
  );
}

type Block = (typeof STYLES)[number];

/** A menu of blocks (text styles, lists): its trigger shows the one the selection is in, else `fallback`. */
function BlockMenu({
  label,
  items,
  current,
  fallback,
  isActive,
  run,
  onOpenChange,
}: {
  label: string;
  items: readonly Block[];
  current: Block | undefined;
  fallback: ReactNode;
  isActive: (c: Cmd) => boolean;
  run: (c: Cmd) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DropdownMenu modal={false} onOpenChange={onOpenChange}>
      <Hint label={label}>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm" aria-label={label} className="gap-0.5 px-1.5" onMouseDown={keep}>
              {current ? current.icon : fallback}
              <CaretDownIcon className="size-2.5! text-muted-foreground" />
            </Button>
          }
        />
      </Hint>
      <DropdownMenuContent align="start" className="w-48" finalFocus={false}>
        {items.map((b) => (
          <DropdownMenuItem key={b.cmd} data-cmd={b.cmd} onClick={() => run(b.cmd)} className={cn(isActive(b.cmd) && "bg-accent/60")}>
            {b.icon}
            {b.label}
            <DropdownMenuShortcut>{b.keys}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Divider() {
  return <Separator aria-hidden orientation="vertical" className="mx-0.5 h-4 bg-border data-vertical:self-center" />;
}

function ToolButton({
  cmd,
  action,
  label,
  keys,
  active,
  onClick,
  children,
}: {
  cmd?: Cmd;
  action?: string;
  label: string;
  keys?: string | undefined;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-pressed={active}
            data-cmd={cmd}
            data-action={action}
            onMouseDown={keep}
            onClick={onClick}
            className={cn("size-7", active && "bg-muted text-foreground")}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {label}
        {keys && <span className="text-background/60">{keys}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/** The link field in place of the buttons: Enter applies (empty removes), Esc goes back to the text. */
function LinkField({ initial, apply, cancel }: { initial: string; apply: (url: string) => boolean; cancel: () => void }) {
  const [url, setUrl] = useState(initial);
  const [bad, setBad] = useState(false);
  return (
    <div className="flex items-center gap-1 pr-0.5 pl-1">
      <LinkSimpleIcon className="size-3.5 text-muted-foreground" />
      <input
        autoFocus
        data-link-input=""
        aria-label="Link URL"
        placeholder="Paste or type a link…"
        value={url}
        aria-invalid={bad}
        onChange={(e) => {
          setUrl(e.target.value);
          setBad(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (!apply(url.trim())) setBad(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }
        }}
        onBlur={cancel}
        className="h-6 w-60 bg-transparent text-xs outline-none placeholder:text-muted-foreground aria-invalid:text-destructive"
      />
      {initial && (
        <Hint label="Remove link">
          <Button variant="ghost" size="icon-sm" aria-label="Remove link" onMouseDown={keep} onClick={() => apply("")}>
            <TrashIcon />
          </Button>
        </Hint>
      )}
    </div>
  );
}
