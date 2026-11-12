// Drag and drop of board cards and settings rows on pointer events, without a library.
//
// Compared (weights: esbuild --minify, brotli):
// - Pragmatic drag and drop (Plane uses it): core 6.2 KB, with auto-scroll and hitbox 8.7 KB; native HTML5 DnD
//   underneath, so the dragged image is the browser's translucent snapshot and touch needs a polyfill;
// - native HTML5 DnD by hand: ~1 KB, same snapshot image, dragover fires at the browser's pace, no styling of the
//   preview, no auto-scroll control;
// - pointer events by hand (this file): ~1.6 KB, a real DOM clone as the preview moved by transform in rAF, our own
//   drop line and edge auto-scroll, one listener set on the board instead of one per card.
// Measured on INFRA (scripts in the report): drop → repaint within one frame, see the commit message.
//
// The DOM contract: a drop cell is `[data-cell]` with `data-group` (and `data-sub` in swimlanes); its cards are direct
// children `[data-card]` holding the dragged row's id (an issue, a workflow state). Cells are position: relative, for
// the drop line. A card's controls (buttons, fields, selects, `[data-no-drag]`) do not start a drag. A card may be a
// table row, its cell the table's body. Links in a card need `draggable={false}`, or the browser drags the link instead.
// Two drags can share a root with other attribute names (`card`, `cell`): the sidebar's projects and its groups, whose
// cards hold the projects' cells. A `handle` lets a drag start only there, a button included (a group's name).

export interface DropPlace {
  groupKey: string;
  subKey: string | null;
  /** Position among the cell's cards without the dragged one. */
  index: number;
}

export interface DragOptions {
  /** The scrolling board: auto-scrolled near its edges. */
  scroller: HTMLElement;
  onDrop(id: string, from: DropPlace, to: DropPlace): void;
  /** A vertical list of rows: the preview moves only up and down, without the card's tilt; only the height counts. */
  vertical?: boolean;
  /** For a card with no background or corners of its own. */
  previewClass?: string;
  /** The attributes of a card, a cell and the cell under the pointer: data-card, data-cell, data-drop-over unless given. */
  card?: string;
  cell?: string;
  over?: string;
  /** Where a drag may start (a selector inside the card); without one, anywhere in it but its controls. */
  handle?: string;
}

const THRESHOLD = 5;
const EDGE = 56;
const MAX_SPEED = 18;

function placeOf(cell: HTMLElement, index: number): DropPlace {
  return { groupKey: cell.dataset.group!, subKey: cell.dataset.sub || null, index };
}

/**
 * The card's copy that follows the pointer, out in the body. It keeps the look of the collapsed sidebar, and a table row
 * gets a table of its own with the cells' widths: alone it has no columns.
 */
function previewOf(card: HTMLElement, cardAttr: string): HTMLElement {
  const copy = card.cloneNode(true) as HTMLElement;
  copy.removeAttribute("data-issue");
  copy.removeAttribute(cardAttr);
  if (card.closest("[data-strip]")) copy.dataset.strip = "";
  if (!(card instanceof HTMLTableRowElement)) return copy;
  for (const [i, cell] of [...card.cells].entries()) (copy as HTMLTableRowElement).cells[i]!.style.width = `${cell.offsetWidth}px`;
  const table = document.createElement("table");
  table.style.borderCollapse = "collapse";
  table.style.tableLayout = "fixed";
  table.append(copy);
  return table;
}

/** Wires dragging of the cards inside `root`; returns the cleanup. */
export function attachDragDrop(root: HTMLElement, opts: DragOptions): () => void {
  const cardAttr = opts.card ?? "data-card";
  const cellAttr = opts.cell ?? "data-cell";
  const overAttr = opts.over ?? "data-drop-over";
  const isCard = (c: Element): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute(cardAttr);
  let start: { x: number; y: number; card: HTMLElement; id: string; pointer: number } | null = null;
  let drag: {
    preview: HTMLElement;
    line: HTMLElement;
    dx: number;
    dy: number;
    from: DropPlace;
    cell: HTMLElement | null;
    index: number;
    x: number;
    y: number;
    frame: number;
    /** Midpoints of each cell's other cards, in the cell's own coordinates; layout does not move during a drag. */
    mids: Map<HTMLElement, { mids: number[]; cards: HTMLElement[] }>;
  } | null = null;

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    const t = e.target as Element;
    if (opts.handle ? !t.closest(opts.handle) : t.closest("button, input, textarea, select, [data-no-drag]")) return;
    const card = t.closest<HTMLElement>(`[${cardAttr}]`);
    if (!card || !root.contains(card)) return;
    start = { x: e.clientX, y: e.clientY, card, id: card.getAttribute(cardAttr)!, pointer: e.pointerId };
    addEventListener("pointermove", onMove);
    addEventListener("pointerup", onUp);
    addEventListener("pointercancel", cancel);
    addEventListener("keydown", onKey, true);
  };

  const begin = (e: PointerEvent) => {
    const { card } = start!;
    const cell = card.parentElement!;
    const r = card.getBoundingClientRect();
    const preview = previewOf(card, cardAttr);
    if (opts.previewClass) preview.classList.add(...opts.previewClass.split(" "));
    preview.setAttribute("aria-hidden", "true");
    Object.assign(preview.style, {
      position: "fixed",
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      margin: "0",
      zIndex: "60",
      pointerEvents: "none",
      contentVisibility: "visible",
      boxShadow: "0 12px 28px -6px rgb(0 0 0 / 0.25)",
      willChange: "transform",
    });
    document.body.append(preview);
    const line = document.createElement("div");
    line.className = "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary";
    card.dataset.dragging = "";
    document.documentElement.dataset.dragging = "";
    const cards = [...cell.children].filter(isCard);
    drag = {
      preview,
      line,
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      from: placeOf(cell, cards.indexOf(card)),
      cell: null,
      index: 0,
      x: e.clientX,
      y: e.clientY,
      frame: 0,
      mids: new Map(),
    };
    tick();
  };

  const onMove = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.pointer) return;
    if (!drag) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < THRESHOLD) return;
      begin(e);
    }
    drag!.x = e.clientX;
    drag!.y = e.clientY;
    e.preventDefault();
  };

  /** One frame: move the preview, find the drop place, scroll near the edges. Runs while dragging. */
  const tick = () => {
    if (!drag) return;
    const d = drag;
    const dx = opts.vertical ? 0 : d.x - d.dx - parseFloat(d.preview.style.left);
    d.preview.style.transform = `translate(${dx}px, ${d.y - d.dy - parseFloat(d.preview.style.top)}px)${opts.vertical ? "" : " rotate(1.5deg)"}`;
    const cell = document.elementFromPoint(opts.vertical ? start!.x : d.x, d.y)?.closest<HTMLElement>(`[${cellAttr}]`) ?? null;
    if (cell !== d.cell) {
      d.cell?.removeAttribute(overAttr);
      cell?.setAttribute(overAttr, "");
      d.cell = cell;
      if (cell) cell.append(d.line);
      else d.line.remove();
    }
    if (cell) {
      let m = d.mids.get(cell);
      if (!m) {
        const cards = [...cell.children].filter((c): c is HTMLElement => isCard(c) && c !== start!.card);
        m = { cards, mids: cards.map((c) => c.offsetTop + c.offsetHeight / 2) };
        d.mids.set(cell, m);
      }
      const y = d.y - cell.getBoundingClientRect().top;
      let lo = 0;
      let hi = m.mids.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (m.mids[mid]! < y) lo = mid + 1;
        else hi = mid;
      }
      d.index = lo;
      const before = m.cards[lo];
      const after = m.cards[lo - 1];
      const top = before ? before.offsetTop - 5 : after ? after.offsetTop + after.offsetHeight + 3 : 0;
      d.line.style.top = `${top}px`;
    }
    autoScroll(opts.scroller, d.x, d.y);
    d.frame = requestAnimationFrame(tick);
  };

  const finish = (drop: boolean) => {
    const d = drag;
    const s = start;
    start = null;
    drag = null;
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerup", onUp);
    removeEventListener("pointercancel", cancel);
    removeEventListener("keydown", onKey, true);
    if (!d || !s) return;
    cancelAnimationFrame(d.frame);
    d.preview.remove();
    d.line.remove();
    d.cell?.removeAttribute(overAttr);
    delete s.card.dataset.dragging;
    delete document.documentElement.dataset.dragging;
    // The click that ends a drag must not open the card.
    const swallow = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener("click", swallow, true), 0);
    if (drop && d.cell) opts.onDrop(s.id, d.from, placeOf(d.cell, d.index));
  };

  const onUp = (e: PointerEvent) => {
    if (start && e.pointerId === start.pointer) finish(true);
  };
  const cancel = () => finish(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && drag) {
      e.preventDefault();
      e.stopImmediatePropagation();
      finish(false);
    }
  };

  root.addEventListener("pointerdown", onDown);
  return () => {
    finish(false);
    root.removeEventListener("pointerdown", onDown);
  };
}

/** Scrolls the container when the pointer is near its edges, faster closer to the edge. */
function autoScroll(el: HTMLElement, x: number, y: number): void {
  const r = el.getBoundingClientRect();
  const speed = (d: number) => (d < EDGE ? Math.ceil(((EDGE - Math.max(d, 0)) / EDGE) * MAX_SPEED) : 0);
  const dx = speed(r.right - x) - speed(x - r.left);
  const dy = speed(r.bottom - y) - speed(y - r.top);
  if (dx || dy) el.scrollBy(dx, dy);
}
