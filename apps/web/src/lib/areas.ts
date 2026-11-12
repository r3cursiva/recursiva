// Keyboard areas (PLNR-304): Tab moves between areas, arrows move inside one, Enter goes in, Esc goes out.
//
// Tab stays the browser's: an area is one stop by a roving tabindex. An area (`data-roving`) keeps one control at
// tabindex 0, its stop, and every other control in it at -1, so Tab passes the area in one step and comes back to its
// stop. The stop is the current item (the selected row, the current page: `aria-current`, `aria-selected`), else the
// control last focused there, else the first; an area that is itself focusable (the Inbox and My work listboxes, which
// move aria-activedescendant) is its own stop. Inside, `data-roving="row"` takes ← →, `"column"` takes ↑ ↓, both Home
// and End; `"list"` leaves the arrows to its screen (J/K and the board's columns). `data-roving-item` limits the arrows
// to those controls where an area holds others (a row's link, not its cells). A region (`data-region`: the sidebar, the
// list, the pane) is what F6 and Shift+F6 go round.
//
// The focus coming into an area makes its control the stop; every Tab press settles the areas before the browser moves
// the focus, so rows that rendered since (a filter, a synced issue) get their -1 then: reads, and writes only for new
// controls, no render (0.4 ms on 121 rows).
//
// Compared (PLNR-304, 2026-11-06): the first version took Tab over, the order of stops rebuilt from the DOM on each press
// and the browser's step prevented, app-wide. This leaves the order to the browser, so Tab is the same before the edit
// chunk loads, in a dialog, in a form and for a screen reader; the rows' tabIndex in React (a row already re-renders when
// the selection moves) would leave the cells, the empty list and a list's new rows to handle by hand.

const ROVING = "[data-roving]";
/** What takes the arrows; a plain element with a tabindex (a scroller, a listbox) only takes the area's -1. */
const CONTROL = "a[href], button, input, select, textarea, summary, [contenteditable=''], [contenteditable=true]";
const FOCUSABLE = `${CONTROL}, [tabindex]`;
const CURRENT = "[aria-current]:not([aria-current=false]), [aria-selected=true]";
const FIELD = "input, textarea, select, [contenteditable=''], [contenteditable=true]";

/** Each area's stop, so a step inside it changes two tabindexes, not all of its rows'. */
const stopOf = new WeakMap<Element, HTMLElement>();

/** The controls in `area` and not in an area inside it. */
function controls(area: Element): HTMLElement[] {
  return [...area.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.closest(ROVING) === area);
}

/** On screen and for everyone: a select's hidden input (aria-hidden, Base UI) hands the focus back to its trigger. */
function shown(el: HTMLElement): boolean {
  return !el.closest("[inert], [aria-hidden=true]") && !(el as HTMLButtonElement).disabled && el.checkVisibility({ visibilityProperty: true });
}

/** The controls the arrows go through: the marked ones where the area marks them. */
function items(area: Element): HTMLElement[] {
  const own = controls(area).filter((el) => el.matches(CONTROL) && shown(el));
  const marked = own.filter((el) => el.hasAttribute("data-roving-item"));
  return marked.length ? marked : own;
}

/** Makes `stop` the area's one Tab stop, or picks it: the current item, the one before, the first. */
function settle(area: HTMLElement, stop?: HTMLElement): HTMLElement | null {
  if (area.hasAttribute("tabindex")) stop = area;
  else if (!stop) {
    const all = items(area);
    const before = stopOf.get(area);
    stop = all.find((el) => area.contains(el.closest(CURRENT))) ?? (before && all.includes(before) ? before : all[0]);
  }
  for (const el of controls(area)) {
    const want = el === stop ? 0 : -1;
    if (el.tabIndex !== want) el.tabIndex = want;
  }
  if (stop) stopOf.set(area, stop);
  return stop ?? null;
}

/**
 * Focus came into an area: the control focused is its stop now. Two tabindexes, not the area's every control: a click on
 * a row is on the way to opening its issue, and the next Tab press settles the rest.
 */
function onFocusIn(e: FocusEvent): void {
  const el = e.target as HTMLElement;
  const area = el.closest?.<HTMLElement>(ROVING);
  if (!area || el === area || area.hasAttribute("tabindex")) return;
  const before = stopOf.get(area);
  if (before && before !== el) before.tabIndex = -1;
  el.tabIndex = 0;
  stopOf.set(area, el);
}

/** The focus target in `root`: the stop of its entry area or first area, else its first control that takes Tab. */
function entryOf(root: Element): HTMLElement | null {
  const visible = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)].find((a) => a.checkVisibility());
  const area = visible("[data-region-entry]") ?? visible(ROVING);
  if (area?.matches(ROVING)) return settle(area);
  const scope = area ?? root;
  return [scope, ...scope.querySelectorAll(FOCUSABLE)].find((el): el is HTMLElement => el instanceof HTMLElement && el.tabIndex >= 0 && shown(el)) ?? null;
}

function enterRegion(region: Element): boolean {
  const el = entryOf(region);
  el?.focus();
  return !!el;
}

/** F6 and Shift+F6: the next region that takes the focus. */
function onRegion(e: KeyboardEvent): void {
  const regions = [...document.querySelectorAll<HTMLElement>("[data-region]")].filter((r) => r.checkVisibility());
  if (!regions.length) return;
  e.preventDefault();
  const by = e.shiftKey ? -1 : 1;
  const at = regions.findIndex((r) => r.contains(document.activeElement));
  const start = at >= 0 ? at : by > 0 ? -1 : 0;
  for (let i = 1; i <= regions.length; i++) {
    if (enterRegion(regions[(start + by * i + regions.length * 2) % regions.length]!)) return;
  }
}

const STEP: Record<string, Record<string, number>> = {
  row: { ArrowLeft: -1, ArrowRight: 1 },
  column: { ArrowUp: -1, ArrowDown: 1 },
};

/** ← → in a row, ↑ ↓ in a column, Home and End in both; stops at the ends, as a toolbar does. */
function onArrow(e: KeyboardEvent): boolean {
  const el = document.activeElement as HTMLElement | null;
  const area = el?.closest<HTMLElement>("[data-roving=row], [data-roving=column]");
  if (!el || !area || el.matches(FIELD)) return false;
  const all = items(area);
  const at = all.indexOf(el);
  const by = STEP[area.dataset.roving!]![e.key];
  const to = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : by !== undefined && at >= 0 ? at + by : -1;
  if (to < 0 || to >= all.length) return by !== undefined;
  all[to]!.focus();
  return true;
}

/**
 * Esc in a field of the issue pane (title, description, a comment) leaves the field as before, and the focus stays in the
 * pane instead of falling to the page: the next Esc then steps out of the pane, not straight out of the issue.
 */
function onFieldEscape(e: KeyboardEvent): void {
  const field = e.target instanceof Element ? e.target.closest(FIELD) : null;
  const pane = field?.closest<HTMLElement>("[data-pane]");
  if (!pane) return;
  setTimeout(() => {
    const now = document.activeElement;
    if ((!now || now === document.body) && pane.isConnected) pane.focus({ preventScroll: true });
  });
}

/**
 * Esc in an issue pane beside its list: the focus goes back to the list, on the selected row, and the issue stays open.
 * False when the focus was not in such a pane; then Esc closes the issue, as it always has for the mouse.
 */
export function leavePane(): boolean {
  const pane = document.activeElement?.closest("[data-slot=split-detail]");
  const list = pane?.parentElement?.querySelector("[data-slot=split-list]");
  return !!list && enterRegion(list);
}

/** Enter on the issue already open: the focus goes into its pane, on the properties. */
export function enterPane(): boolean {
  const pane = document.querySelector("[data-slot=split-detail]");
  return !!pane && enterRegion(pane);
}

export function watchAreas(): void {
  document.addEventListener("focusin", onFocusIn);
  // Capture, before the screens' own keys: an arrow in a row or a column of buttons is that area's, not the list's; and
  // Tab's areas are settled before the browser takes its step.
  addEventListener(
    "keydown",
    (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Tab") {
        // The area Tab leaves keeps the focused control as its stop; the others take their current item or keep theirs.
        const from = document.activeElement as HTMLElement | null;
        for (const area of document.querySelectorAll<HTMLElement>(ROVING)) {
          if (area.checkVisibility()) settle(area, from?.closest(ROVING) === area ? from : undefined);
        }
        return;
      }
      if (e.shiftKey) return;
      if (e.key === "Escape") return onFieldEscape(e);
      if ((e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") && onArrow(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  addEventListener("keydown", (e) => {
    if (!e.defaultPrevented && e.key === "F6" && !e.metaKey && !e.ctrlKey && !e.altKey) onRegion(e);
  });
}
