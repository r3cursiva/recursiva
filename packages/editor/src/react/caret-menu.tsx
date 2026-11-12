// The menus at the caret: "@" for people (PLNR-27), "#" for issues and "/" for blocks (PLNR-116). The editor reports
// which query the caret is in (view/caret-query.ts); the host says who can be mentioned and which issues there are, and
// "/" offers the selection toolbar's blocks. Arrows move, Enter or Tab picks, Esc closes; the editor keeps the focus
// throughout, as with the selection toolbar. On a phone the popup is a bottom sheet, as every popup (the `sheet` class):
// it is placed with `translate`, which the sheet's rules override. A phone's comment field shows all three as a row of
// chips over it instead (`chipsIn`, PLNR-341).
//
// Rendered into the body, not into the dialog around the editor as the toolbar is: the create panel is placed with
// `translate`, which makes it the box of a fixed popup inside it, and its scrolling cut the list of "/" in half. A press
// on a row still counts as inside the dialog: Base UI follows React's events, which pass through the portal.
import { DropdownMenuShortcut } from "@rsva/ui/components/dropdown-menu";
import { UserAvatar } from "@rsva/ui/components/user-avatar";
import { MENU_ITEM, MENU_SURFACE } from "@rsva/ui/lib/menu";
import { cn } from "@rsva/ui/lib/utils";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { EditorHandle, Trigger } from "../view/editor.ts";
import { matchBlocks } from "./blocks.ts";
import { CARET_POPUP_STYLE, rectOf, useCaretPopup } from "./caret-popup.ts";
import { highlighted, menuKey, sessionFor, type Chosen, type Session } from "./menu-state.ts";

export interface MentionCandidate {
  id: string;
  /** The name: what the mention shows. */
  label: string;
  /** A second line: an email, "agent". */
  detail?: string;
  /** Their picture's address; none draws initials. */
  src?: string | null;
}

/** Who can be mentioned, best matches first. */
export interface MentionSource {
  search(query: string): MentionCandidate[];
}

interface IssueCandidate {
  /** "PLNR-27": what a pick puts in the text. */
  key: string;
  title: string;
}

/**
 * Which issues "#" offers: `open` once for each "#", as the palette builds its index once per opening, and what it returns
 * for each query typed after it, best matches first; none for an empty query, so "# " for a heading opens nothing.
 */
export interface IssueSource {
  open(): (query: string) => IssueCandidate[];
}

/** A row of a menu: what it shows and what picking it does. */
interface MenuItem {
  id: string;
  row: ReactNode;
  /** The row as a chip over a phone's comment field; the row itself if none. */
  chip?: ReactNode;
  pick: (handle: EditorHandle) => boolean;
}

/** One trigger's menu: its name for screen readers, its width, and its search: `open` once per trigger, then the rows for each query. */
export interface CaretMenu {
  label: string;
  className: string;
  open: (handle: EditorHandle) => (query: string) => MenuItem[];
}

const SHOWN = 8;

export function mentionMenu(source: MentionSource): CaretMenu {
  return {
    label: "Mention someone",
    className: "w-64",
    open: () => (query) =>
      source
        .search(query)
        .slice(0, SHOWN)
        .map((c) => ({
          id: c.id,
          row: (
            <>
              <UserAvatar name={c.label} src={c.src} className="size-4" />
              <span className="truncate">{c.label}</span>
              {c.detail && <span className="ml-auto truncate text-muted-foreground">{c.detail}</span>}
            </>
          ),
          chip: (
            <>
              <UserAvatar name={c.label} src={c.src} />
              {c.label}
            </>
          ),
          pick: (h) => h.insertMention(c.id, c.label),
        })),
  };
}

export function issueMenu(source: IssueSource): CaretMenu {
  return {
    label: "Link an issue",
    className: "w-80",
    open() {
      const search = source.open();
      return (query) =>
        search(query)
          .slice(0, SHOWN)
          .map((c) => ({
            id: c.key,
            row: (
              <>
                <span className="shrink-0 font-mono text-muted-foreground">{c.key}</span>
                <span className="truncate">{c.title}</span>
              </>
            ),
            chip: (
              <>
                <span className="font-mono text-muted-foreground">{c.key}</span>
                <span className="max-w-40 truncate">{c.title}</span>
              </>
            ),
            pick: (h) => h.insertIssueKey(c.key),
          }));
    },
  };
}

export const blockMenu: CaretMenu = {
  label: "Turn into",
  className: "w-56",
  // In a table cell, what can be done to the table: a cell holds no other block.
  open: (h) => {
    const inTable = h.isActive("table");
    return (query) =>
      matchBlocks(query, inTable).map((b) => ({
        id: b.cmd,
        row: (
          <>
            {b.icon}
            {b.label}
            {b.keys && <DropdownMenuShortcut>{b.keys}</DropdownMenuShortcut>}
          </>
        ),
        pick: (handle) => handle.applyBlock(b.cmd),
      }));
  },
};

export function CaretMenus({
  handle,
  subscribe,
  menus,
  chipsIn,
}: {
  handle: EditorHandle;
  subscribe: (cb: () => void) => () => void;
  /** The menu of each trigger the editor tracks. */
  menus: Partial<Record<Trigger, CaretMenu>>;
  /** Where to draw the matches as a row of chips, instead of a popup at the caret (a phone's comment field). */
  chipsIn?: HTMLElement | null | undefined;
}) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  // A row chosen with the arrows or the mouse belongs to one query: a new query (or a new trigger) starts over.
  const [chosen, setChosen] = useState<Chosen>({ query: "", index: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const session = useRef<Session<(query: string) => MenuItem[]> | null>(null);
  useEffect(() => subscribe(redraw), [subscribe]);

  const q = handle.caretQuery();
  const menu = q ? menus[q.trigger] : undefined;
  session.current = sessionFor(session.current, q ? `${q.trigger}${q.from}` : null, menu && (() => menu.open(handle)));
  const items = q && session.current ? session.current.find(q.query) : [];
  const open = items.length > 0;
  const query = q ? `${q.from}:${q.query}` : "";
  const at = highlighted(chosen, query, q?.query ?? "", items.length);

  // Keys reach the menu only while it shows: with no match, Esc and Enter do what they do in the editor.
  const latest = useRef({ open, items, at, query });
  latest.current = { open, items, at, query };
  useEffect(() => {
    handle.setMenuKeys((e) => {
      const { open, items, at, query } = latest.current;
      return menuKey(e, at, open ? items.length : 0, {
        dismiss: () => handle.dismissQuery(),
        move: (index) => setChosen({ query, index }),
        pick: (index) => items[index]!.pick(handle),
      });
    });
    return () => handle.setMenuKeys(null);
  }, [handle]);

  useCaretPopup(
    ref,
    handle.view,
    open && !chipsIn,
    () => {
      const r = handle.view.coordsAtPos(q!.from);
      return rectOf(r.left, r.top, r.left, r.bottom);
    },
    "bottom-start",
    4,
  );

  if (!open || !menu) return null;
  if (chipsIn) {
    return createPortal(
      <div role="listbox" aria-label={menu.label} data-caret-menu={q!.trigger} className="no-scrollbar flex gap-1.5 overflow-x-auto px-0.5 pb-2" onMouseDown={(e) => e.preventDefault()}>
        {items.map((it, i) => (
          <button
            key={it.id}
            type="button"
            role="option"
            aria-selected={i === at}
            className="flex h-8 shrink-0 items-center gap-[7px] rounded-2xl border border-control-border bg-ground px-2.5 text-[13px] whitespace-nowrap aria-selected:border-ink-3 aria-selected:bg-panel"
            onClick={() => it.pick(handle)}
          >
            {it.chip ?? it.row}
          </button>
        ))}
      </div>,
      chipsIn,
    );
  }
  return createPortal(
    <div
      ref={ref}
      role="listbox"
      aria-label={menu.label}
      data-caret-menu={q!.trigger}
      style={CARET_POPUP_STYLE}
      className={cn("sheet z-50", menu.className, MENU_SURFACE)}
      onMouseDown={(e) => e.preventDefault()}
      // A sheet pulled down sends it Esc (sheet-drag.ts): the menu closes, and the page or dialog behind it stays.
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        handle.dismissQuery();
      }}
    >
      {items.map((it, i) => (
        <div
          key={it.id}
          role="option"
          aria-selected={i === at}
          data-highlighted={i === at ? "" : undefined}
          className={MENU_ITEM}
          onMouseEnter={() => setChosen({ query, index: i })}
          onClick={() => it.pick(handle)}
        >
          {it.row}
        </div>
      ))}
    </div>,
    document.body,
  );
}
