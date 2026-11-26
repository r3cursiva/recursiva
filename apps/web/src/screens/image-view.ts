// A picture in text (a description, a comment) opens at the size of the window (image-viewer-host.tsx, in the lazy edit
// chunk). Readers and editors draw pictures as plain <img>, so this is one listener on the document, as for issue keys
// (issue-ref.ts), not a component per picture. In text being edited a click selects the picture, as before, and a
// double click opens it; in text being read a click does.
import type { ViewedImage } from "@rsva/ui/components/image-viewer";
import { makeAutoObservable, observableRef } from "mobx";

export interface Viewed {
  images: ViewedImage[];
  index: number;
}

class ImageView {
  current: Viewed | null = null;

  constructor() {
    makeAutoObservable(this, { current: observableRef });
  }

  show(viewed: Viewed): void {
    this.current = viewed;
  }

  step(index: number): void {
    if (this.current) this.current = { ...this.current, index };
  }

  close(): void {
    this.current = null;
  }
}

export const imageView = new ImageView();

/** Whether a click opens the picture: any plain click in text being read, the second of a double click in an editor. */
export const opensImage = (editable: boolean, clicks: number): boolean => !editable || clicks === 2;

/** The pictures to step through, in the page's order, each once (a picture quoted in a reply is the same file), and where the clicked one is. */
export function gallery(images: Viewed["images"], clicked: string): Viewed {
  const seen = new Set<string>();
  const unique = images.filter((i) => !seen.has(i.src) && seen.add(i.src));
  return { images: unique, index: Math.max(0, unique.findIndex((i) => i.src === clicked)) };
}

const shown = (img: HTMLImageElement): ViewedImage => ({ src: img.getAttribute("src") ?? "", alt: img.alt });

function onClick(e: MouseEvent): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const img = e.target instanceof HTMLImageElement && e.target.closest(".rich-text") ? e.target : null;
  if (!img || !opensImage(!!img.closest("[contenteditable=true]"), e.detail)) return;
  e.preventDefault();
  imageView.show(gallery([...document.querySelectorAll<HTMLImageElement>(".rich-text img")].map(shown), shown(img).src));
}

/** Installs the listener; returns its removal. */
export function watchImages(): () => void {
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}
