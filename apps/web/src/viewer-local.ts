// What one viewer keeps in this browser: list states, the inbox's view, My work's (view-state.ts, inbox-view.ts,
// my-work-view.ts). Each is saved under the viewer's id, so it is read only once the workspace data says who that is.
import { reaction, when } from "mobx";
import { readLocal, writeLocal } from "./lib/local-storage.ts";
import { store } from "./store.ts";

/**
 * Once the viewer is known: `restore` gets what was saved under `key(viewer id)` (null when nothing was), then every
 * change of `snapshot` is saved there.
 */
export function persistForViewer(key: (viewerId: string) => string, restore: (saved: unknown) => void, snapshot: () => unknown): void {
  when(
    () => store.me !== null,
    () => {
      const storageKey = key(store.me!.id);
      restore(readLocal(storageKey));
      reaction(snapshot, (s) => writeLocal(storageKey, s));
    },
  );
}
