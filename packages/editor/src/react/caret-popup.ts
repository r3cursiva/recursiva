// A popup that floats next to a spot in the editor's text: the selection toolbar above the selection, a caret menu under
// its @, # or /. Positioned with floating-ui's computePosition, the copy Base UI already ships (same version, no new bytes);
// the toolbar is rendered into the dialog around the editor if there is one (popupRoot), so a click on it is not a click
// outside the dialog; a caret menu goes into the body (caret-menu.tsx says why). The place is a `translate`, not a
// `transform`: a phone's bottom sheet (the `sheet` class) overrides it.
//
// The toolbar stays in the dialog (RSVA-343): it is one row high, so flip() always finds room for it above or below a
// selection the dialog's scroll still shows; the "/" list is too tall for that. What did cut it is a selection scrolled out
// of the dialog or out of the description's own scroll: the popup followed it to the edge. Now a popup whose spot is
// scrolled out of sight is hidden until the spot comes back (hide()), unless it is a bottom sheet; in the body it would
// have hung over the page instead.
import { autoUpdate, computePosition, flip, hide, offset, shift, type Placement } from "@floating-ui/dom";
import { useLayoutEffect, type CSSProperties, type RefObject } from "react";
import type { EditorView } from "prosemirror-view";

/** Hidden until the first placement lands, so it never flashes in the corner. */
export const CARET_POPUP_STYLE: CSSProperties = { position: "fixed", left: 0, top: 0, visibility: "hidden" };

/** Keeps `ref` placed by `rect` while `open`; runs after every render, as the rect follows the editor's state. */
export function useCaretPopup(ref: RefObject<HTMLElement | null>, view: EditorView, open: boolean, rect: () => DOMRect, placement: Placement, gap: number): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const reference = { contextElement: view.dom, getBoundingClientRect: rect };
    const place = () =>
      void computePosition(reference, el, { strategy: "fixed", placement, middleware: [offset(gap), flip(), shift({ padding: 8 }), hide()] }).then(({ x, y, middlewareData }) => {
        el.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
        // Hidden only when the spot is past an edge: hide()'s own referenceHidden counts a caret at the start of a line, zero
        // wide on the scroll's left edge, as gone. A bottom sheet overrides the place (translate: none): its spot does not matter.
        const offsets = middlewareData.hide?.referenceHiddenOffsets;
        const gone = !!offsets && Object.values(offsets).some((d) => d > 0) && getComputedStyle(el).translate !== "none";
        el.style.visibility = gone ? "hidden" : "visible";
      });
    return autoUpdate(reference, el, place, { animationFrame: false, elementResize: false });
  });
}

/** Where a popup of this editor is rendered. */
export const popupRoot = (view: EditorView): HTMLElement => view.dom.closest<HTMLElement>("[role=dialog]") ?? document.body;

/** A rectangle from coordsAtPos-style coordinates. */
export function rectOf(left: number, top: number, right: number, bottom: number): DOMRect {
  return { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top } as DOMRect;
}
