// Overlays that are simply open or closed: the command palette (⌘/Ctrl+K), New project (PLNR-59, admins only) and the
// sheet of keyboard shortcuts (`?`, PLNR-304). All are lazy (overlays.tsx).
import { makeAutoObservable } from "mobx";

class Overlay {
  open = false;

  constructor() {
    makeAutoObservable(this);
  }

  show(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }
}

export const palette = new Overlay();

/**
 * The issues "Move to project…" opened the palette for (PLNR-448): an issue's menu, the selected ones, ⌘⇧M. The palette
 * opens on its project page and forgets them when it closes.
 */
class MoveRequest {
  ids: string[] = [];

  constructor() {
    makeAutoObservable(this);
  }

  show(ids: string[]): void {
    this.ids = ids;
    palette.show();
  }

  clear(): void {
    this.ids = [];
  }
}

export const moveRequest = new MoveRequest();
export const newProject = new Overlay();
export const shortcutSheet = new Overlay();
