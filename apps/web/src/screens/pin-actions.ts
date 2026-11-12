// Favorites in the sidebar (PLNR-292; named Pinned until 2026-11-06), from a menu, ⌘K or a title's star
// (favorite-button.tsx). A toast says what happened: on a phone the sidebar is not in sight.
import type { PinRef } from "@rsva/protocol";
import { store } from "../store.ts";
import { notice } from "./notice.ts";

/** Undo puts the whole list back, so an unpinned one returns to its place. */
export function togglePin(ref: PinRef, name: string): void {
  const before = store.views.pins;
  const on = !before.includes(ref);
  store.views.pin(ref, on);
  notice.show(on ? `${name} added to favorites` : `${name} removed from favorites`, () => store.views.setPins(before));
}

/** The words for a thing that is a favorite or not, in a menu and on the star. */
export const pinLabel = (ref: PinRef): string => (store.views.pinned(ref) ? "Remove from favorites" : "Add to favorites");
