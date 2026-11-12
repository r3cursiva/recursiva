// A mouse press on a button, a link or another control without text does not give it the focus, as in Safari and in
// native macOS apps (PLNR-245). Chrome gives it, and then any key turns on :focus-visible (the WICG polyfill and
// React Aria do the same): this app runs on single keys, so the ring stood on whatever was clicked last.
//
// Compared:
// - the ring only after Tab (an own focus-visible variant): one rule for all, but a person on shortcuts loses the mark
//   the standard gives;
// - blur() of the control after its click: two focus moves a click, and a control a component focuses on click loses it;
// - no focus on a mouse press (taken): Safari's rule, by design; the keys and Tab work as before.
//
// The focus leaves a field or a control it was in, as a press does in Safari, but stays in a container that holds the
// pressed control (a list and the buttons of its rows). A press a component prevents itself keeps its own rule (the
// editor's toolbar keeps the editor's focus); popups and text being edited (a link in a description) manage their focus
// themselves. Touch is left alone.

const CONTROL =
  "button, a[href], summary, [role=button], [role=link], [role=tab], [role=switch], [role=checkbox], [role=radio], input[type=checkbox], input[type=radio], input[type=button], input[type=submit], input[type=reset]";
const OWN_FOCUS = "[role=dialog], [role=alertdialog], [role=menu], [role=listbox]:not([data-page-list]), [contenteditable=''], [contenteditable=true]";

export function keepFocusOnPress(): void {
  let mouse = false;
  document.addEventListener("pointerdown", (e) => (mouse = e.pointerType === "mouse"), true);
  // Bubbling on the document, after React's handlers on the root: a press they prevented is theirs.
  document.addEventListener("mousedown", (e) => {
    if (!mouse || e.button !== 0 || e.defaultPrevented || !(e.target instanceof Element)) return;
    const control = e.target.closest(CONTROL);
    if (!control || control.closest(OWN_FOCUS)) return;
    e.preventDefault();
    const held = document.activeElement;
    if (held instanceof HTMLElement && !held.contains(control)) held.blur();
  });
}
