/** What takes text. */
const FIELDS = "input, textarea, select, [contenteditable=''], [contenteditable=true]";
/** Popups with keys of their own. */
const POPUPS = "[role=dialog], [role=menu], [role=listbox]";

/**
 * Whether the focus is in a field or a popup: a key goes there instead of to a shortcut, and a reload would drop what is
 * being written or picked (new-version.ts). A screen's own list (My work, Inbox: `data-page-list`) is a listbox that takes
 * the focus but no letters, so it does not count unless `pageList` says so (RSVA-258).
 */
export function typing(t: EventTarget | null, pageList = false): boolean {
  return t instanceof Element && !!t.closest(pageList ? `${FIELDS}, ${POPUPS}` : `${FIELDS}, [role=dialog], [role=menu], [role=listbox]:not([data-page-list])`);
}

/**
 * The key went to a field, list, menu or dialog (the Escape of a sheet pulled down, sheet-drag.ts), which has its own use
 * for it; a screen's own list counts too. A radio or a checkbox takes no text: it keeps only its own keys (the arrows of a
 * Segmented, Space), so after a click on List or Board, or Active or Archived, the screen's letters and digits still work.
 */
export function typedInto(e: KeyboardEvent): boolean {
  const t = e.target;
  if (t instanceof Element && !t.closest(POPUPS) && t.matches("input[type=radio], input[type=checkbox]")) return /^Arrow/.test(e.key) || e.key === " ";
  return typing(t, true);
}
