// The sidebar on this device: open, or collapsed to its icons (the button, ⌘\, ⌘K). The choice stays in localStorage, read
// before the first render, so the page never draws the other width first. And the projects' groups in the making
// (RSVA-566): a new group's name typed in place, a group renamed, the projects picked for one, and whether Quiet is
// open on this device.
//
// A narrow window collapses the sidebar too, on every screen beside it: below 70rem a project's header wraps and its rows
// crowd with the full sidebar (measured 2026-11-05: the header of a project's issues takes two lines under ~1100px), and
// two panes side by side (a list and its open issue, the inbox) need the room as well. Until 2026-11-05 only two panes
// did, below 64rem. That doesn't touch the stored choice: the window widens and the sidebar is back as it was.
// Expanding it by hand meanwhile holds it open until then.
import { makeAutoObservable } from "mobx";
import { readLocal, writeLocal } from "../lib/local-storage.ts";

const KEY = "rsva:sidebar-strip";
const QUIET = "rsva:sidebar-quiet";
/** Below this the full sidebar leaves a screen too little room: a project's header wraps, a list and its issue squeeze. */
const NARROW = "(width < 70rem)";

class SidebarState {
  /** The person's choice, kept. */
  chosen = readLocal(KEY) === true;
  narrow = typeof matchMedia === "function" && matchMedia(NARROW).matches;
  /** Expanded by hand while the window is narrow. */
  held = false;
  /** A new group's name is being typed under the ungrouped projects. */
  naming = false;
  /** The group whose name is being changed in place. */
  renaming: string | null = null;
  /** The group whose projects are being picked, right after it was made or from its menu. */
  picking: string | null = null;
  quietOpen = readLocal(QUIET) === true;
  /** A project's or a group's menu opened by a right click in the strip, at the pointer: the strip has no ⋯ to hold it. */
  menuAt: { kind: "project" | "group"; id: string; x: number; y: number } | null = null;

  constructor() {
    makeAutoObservable(this);
    if (typeof matchMedia === "function") matchMedia(NARROW).addEventListener("change", (e) => this.setNarrow(e.matches));
  }

  /** Collapsed to its icons, by choice or for a narrow window. */
  get strip(): boolean {
    return !this.held && (this.chosen || this.narrow);
  }

  toggle(): void {
    // In a narrow window the change lasts until the window widens.
    if (this.narrow) this.held = this.strip;
    else {
      this.chosen = !this.chosen;
      writeLocal(KEY, this.chosen);
    }
  }

  setNarrow(narrow: boolean): void {
    this.narrow = narrow;
    if (!narrow) this.held = false;
  }

  /** Starts a new group's name in place; the strip opens, as the name is typed in the full sidebar. */
  newGroup(): void {
    if (this.strip) this.toggle();
    this.renaming = null;
    this.naming = true;
  }

  rename(id: string | null): void {
    this.naming = false;
    this.renaming = id;
  }

  stopNaming(): void {
    this.naming = false;
    this.renaming = null;
  }

  pick(id: string | null): void {
    this.picking = id;
  }

  openMenuAt(menu: NonNullable<SidebarState["menuAt"]>): void {
    this.menuAt = menu;
  }

  closeMenu(): void {
    this.menuAt = null;
  }

  toggleQuiet(): void {
    this.quietOpen = !this.quietOpen;
    writeLocal(QUIET, this.quietOpen);
  }
}

export const sidebar = new SidebarState();
