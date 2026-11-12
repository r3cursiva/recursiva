// The one lazy chunk (edit-chunk.ts) is loaded through here only. A failed import means this tab asked for a file that
// is gone or stale: a deploy replaced the chunk's hashed name while the tab was open, or the dev server re-optimized its
// dependencies (Safari reports "Importing a module script failed"). The page reloads once to pick up the current
// shell; if the import fails again right after that reload, the error reaches the error boundary. So does the first failure
// when site storage is blocked: the mark of the try would not outlive the reload, and every load would reload again
// (PLNR-263: 439 loads in 4 s). The boundary's Reload button is the same reload, pressed once.
//
// Considered (2026-11-04) for keeping the try without storage: a mark in the URL shows in the address bar, is copied with
// a link and has to be taken out of the router's way; window.name outlives a reload too, but also a navigation to
// another site in the tab, and is the page's to read for whatever it opens. Blocked storage is rare; one press is enough.
import { observer } from "mobx-react-lite";
import { createElement, lazy, Suspense, useState, type ComponentType } from "react";
import { readSession, removeSession, writeSession } from "../lib/local-storage.ts";

const RELOADED = "rsva:chunk-reload";

type Chunk = typeof import("./edit-chunk.ts");
let pending: Promise<Chunk> | null = null;
let loaded: Chunk | null = null;

export function loadEditChunk(): Promise<Chunk> {
  return (pending ??= Promise.all([import("./edit-chunk.ts"), fullStylesheet()]).then(
    ([m]) => {
      removeSession(RELOADED);
      loaded = m;
      return m;
    },
    (e: unknown) => {
      pending = null;
      if (reloadOnce(() => location.reload())) return new Promise<never>(() => {});
      throw e;
    },
  ));
}

/**
 * The whole stylesheet, which the chunk's screens need: the page links only the rules of the startup chunks
 * (build/startup-css.ts) and names the whole one in a meta tag. It comes after the startup copy and holds every rule of
 * it in the same order, so adding it changes nothing on screen. No tag (the dev server) — the page has it all already.
 */
function fullStylesheet(): Promise<void> {
  const href = document.querySelector<HTMLMetaElement>('meta[name="rsva-css"]')?.content;
  if (!href || document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href });
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      reject(new Error(`the stylesheet ${href} did not load`));
    };
    document.head.append(link);
  });
}

/** After a failed import: reloads and says so, unless this tab already tried or cannot keep the mark of the try. */
export function reloadOnce(reload: () => void): boolean {
  if (readSession(RELOADED) === 1) return false;
  writeSession(RELOADED, 1);
  if (readSession(RELOADED) !== 1) return false;
  reload();
  return true;
}

/** The chunk once it is here, else null: for a key that cannot wait for it and does without it meanwhile. */
export function editChunk(): Chunk | null {
  return loaded;
}

/**
 * A component of the chunk. React.lazy suspends on its first render even with the module in memory, and React then holds
 * the content back behind the fallback for up to 300 ms (FALLBACK_THROTTLE_MS, PLNR-80): every screen's first opening
 * cost that, chunk loaded or not. So once the chunk is here the component renders directly. An instance keeps what it
 * started with: swapping the type under it would remount it.
 */
export function chunk<K extends keyof Chunk>(name: K): Chunk[K] {
  const Lazy = lazy(() => loadEditChunk().then((m) => ({ default: m[name] as ComponentType<object> })));
  return function Chunked(props: object) {
    const [Component] = useState(() => (loaded?.[name] as ComponentType<object> | undefined) ?? Lazy);
    return createElement(Component, props);
  } as Chunk[K];
}

/**
 * A component of the chunk drawn only while `when()` holds (it reads observables): for what most visits never show, such as
 * the card of a new version or a refused change, the startup JS keeps the check and the chunk the rest (RSVA-497). The
 * chunk is loaded right after the first paint, so by the time one shows it is here; if not, it shows once it is.
 */
export function chunkWhen<K extends keyof Chunk>(name: K, when: () => unknown): Chunk[K] {
  const Component = chunk(name) as ComponentType<object>;
  return observer(function ChunkedWhen(props: object) {
    return when() ? createElement(Suspense, null, createElement(Component, props)) : null;
  }) as unknown as Chunk[K];
}
