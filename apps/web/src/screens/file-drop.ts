// An element that takes dropped files: an issue's attachments (files.tsx) and the profile's picture (account-picture.tsx);
// and the page's guard (guardFileDrops), which keeps a file dropped anywhere else from opening in the browser.
import { useState, type DragEvent } from "react";
import { carriesFiles, droppableFiles, PAGE_DRAG } from "@rsva/editor/drag";

const hasFiles = (e: DragEvent) => droppableFiles(e.dataTransfer.types);

/** Whether the page cancels a drag: it carries files and no drop target took it (`taken`: its default was prevented). */
export const strayFiles = (types: readonly string[], taken: boolean): boolean => !taken && carriesFiles(types);

/**
 * A file dropped outside a drop target would open in the browser and leave the app (PLNR-257). Bubbling on the window,
 * after the targets (React's on the root, the editor's on its element): a drag a target prevented is theirs. The rest
 * shows "no drop" and drops nothing; text and links are left to the browser, and the app's own drags are pointer events.
 * A drag the page starts is marked (PAGE_DRAG) at the window, after the source's own handlers, so a clearData() of theirs
 * cannot drop the mark.
 */
export function guardFileDrops(): void {
  window.addEventListener("dragstart", (e) => e.dataTransfer?.setData(PAGE_DRAG, ""));
  for (const t of ["dragover", "drop"] as const) {
    window.addEventListener(t, (e) => {
      if (!e.dataTransfer || !strayFiles(e.dataTransfer.types, e.defaultPrevented)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
    });
  }
}

/** `over` while files are dragged over the element; spread `drop` on it. `alt`: Alt was held at the drop. */
export function useFileDrop(onFiles: (files: File[], alt: boolean) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    drop: {
      onDragOver: (e: DragEvent) => hasFiles(e) && (e.preventDefault(), setOver(true)),
      onDragLeave: (e: DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false),
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(false);
        onFiles([...e.dataTransfer.files], e.altKey);
      },
    },
  };
}
