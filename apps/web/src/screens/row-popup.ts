// One popup for the whole list or board: a property picker or the row menu, placed at the clicked chip or the pointer.
//
// Plane mounts a dropdown per property per row. Considered for 240 rows × 5 properties:
// - a Base UI picker root per cell: ~1 200 extra components on every render of the list, and Base UI's combobox in the
//   startup JS (it is ~25 KB brotli and lives in the lazy edit chunk today);
// - this: rows render plain buttons that write { kind, issue, anchor } here, and one host (row-popup-host.tsx, lazy)
//   renders the picker. No per-row cost; the first click waits for a chunk that is already prefetched after paint.
//
// The popup has no trigger of its own, so two things a trigger would give are done here (PLNR-163): a second click on the
// cell closes it, and leaving the page does too.
import { makeAutoObservable, observableRef, reaction } from "mobx";
import type { PopupAnchor } from "@rsva/ui/components/search-select";
import { router } from "../router.ts";

export type RowPopupKind = "state" | "priority" | "assignees" | "labels" | "cycle" | "startDate" | "dueDate" | "menu";

export interface RowPopupState {
  kind: RowPopupKind;
  issueId: string;
  anchor: NonNullable<PopupAnchor>;
}

class RowPopup {
  current: RowPopupState | null = null;

  constructor() {
    makeAutoObservable(this, { current: observableRef });
  }

  /** Opens the popup at `anchor`; a click that began on the anchor of the open popup closes it instead. */
  open(kind: RowPopupKind, issueId: string, anchor: NonNullable<PopupAnchor>): void {
    const again = anchor === pressed;
    pressed = null;
    this.current = again ? null : { kind, issueId, anchor };
  }

  close(): void {
    this.current = null;
  }
}

export const rowPopup = new RowPopup();

/**
 * The open popup's anchor, when a press began on it. Base UI closes the popup on that press, as on any press outside it,
 * and the click that follows would open it again. Read on the window's capture phase, before Base UI's listeners on the
 * document close the popup. Considered: Base UI's onOpenChange details (reason "outside-press", cancel()) to keep it open
 * and let the click close it, but the picker, date and menu wrappers each pass only a boolean today; a time window after
 * a close, which a slow press outlasts. A key, or a press anywhere else, clears it, so Enter on the cell still opens.
 */
let pressed: Element | null = null;
const onPress = (e: Event) => {
  const a = rowPopup.current?.anchor;
  pressed = e.type === "pointerdown" && a instanceof Element && e.target instanceof Node && a.contains(e.target) ? a : null;
};
addEventListener("pointerdown", onPress, true);
addEventListener("keydown", onPress, true);

// A route change takes the page the anchor was on: a picker stayed open in the screen's corner, the row menu at the pointer
// over the next page.
reaction(
  () => router.path,
  () => rowPopup.close(),
);

/** A zero-size anchor at the pointer, for the context menu. */
export function pointAnchor(x: number, y: number): { getBoundingClientRect(): DOMRect } {
  return { getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) };
}
