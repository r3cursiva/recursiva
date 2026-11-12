// Shared by the popups. Their surface and motion (RSVA-427), and class strings for list popups that are not a Base UI menu (the editor's @ menu) and those that
// are (Combobox): one look for a highlighted row however the list is driven. And where the focus goes as a popup closes.

/** A row; `data-highlighted` marks the active one. */
export const MENU_ITEM =
  "relative flex min-h-7 w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-menu outline-hidden select-none max-md:min-h-[52px] max-md:gap-3.5 max-md:rounded-none max-md:px-[18px] max-md:[&_svg:not([class*='size-'])]:size-[18px] data-highlighted:bg-accent data-highlighted:text-accent-foreground not-data-[variant=destructive]:data-highlighted:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5";

/** The dimmed page behind a popup that is a bottom sheet on a phone (the `sheet` class, globals.css); wider, no backdrop. */
export const SHEET_BACKDROP = "fixed inset-0 z-50 bg-ink/30 duration-200 md:hidden dark:bg-black/55 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0";

/** A floating popup's surface: menus, popovers, the combobox, the preview card. Its padding is the popup's own. */
export const POPUP_SURFACE = "rounded-(--float-radius) bg-popover text-popover-foreground shadow-pop ring-1 ring-rule";

/** The surface of a list popup, with the padding round its rows. */
export const MENU_SURFACE = `${POPUP_SURFACE} p-1`;

/** How a popup opens and closes: fades and grows from its anchor. The duration is the popup's own. */
export const POPUP_MOTION = "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

/** Slides a popup in from its anchor, on whichever side it opened. */
export const POPUP_SIDES = "data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2";

/**
 * A popup's `finalFocus` (PLNR-245): back to its trigger after a key, as WAI-ARIA asks; after a press, nowhere. Back on
 * the trigger, it would ring there at the next key, as Chrome counts any key as keyboard use. Base UI returns the focus
 * only while it is still in the closing popup or nowhere, but skips that check for a function: it is repeated here, so a
 * dialog a menu item opened keeps its focus.
 */
export function focusBackOnKeys(closeType: string): boolean {
  if (closeType === "mouse" || closeType === "touch" || closeType === "pen") return false;
  const held = document.activeElement;
  return !held || held === document.body || !!held.closest("[data-closed]");
}
