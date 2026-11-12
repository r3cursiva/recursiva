// A deployed version reaching a tab that is open (PLNR-107).
//
// The Service Worker answers a navigation from its cache and installs a new version in the background (build/shell.ts):
// the first reload after a deploy showed the old version, and a tab left open never even asked whether there was a new one.
// - The tab asks whenever its socket is back (checkForNewVersion, the sync engine's onReconnect): a deploy restarts the
//   server, and that drops every socket.
// - A new worker takes over open tabs at once (skipWaiting, clients.claim), and `controllerchange` tells the page it is
//   behind. A reload pressed by hand from then on gets the new shell.
// - The page reloads by itself at a moment that interrupts nobody: hidden or in a window without focus, with no input for
//   IDLE_MS (a file picker, a passkey prompt or the find bar take the focus too, right after a click); or opened or brought
//   back less than FRESH_MS ago, with no input since (a start on the old shell, an installed app resumed). And only when a
//   reload loses nothing: the focus in no field or popup (typing.ts), no write request or upload on its way
//   (holdReloadFor), nothing a holder of holdReload still needs (a change the server has not confirmed). What lives only
//   in memory goes to the next page (beforeReload, handover: comment drafts, and a reply's or an edit's composer opens
//   again for its draft, lib/drafts.ts).
// - While the page waits in front of someone using it, a card by the avatar says so (RSVA-459, update-card.tsx): a tab
//   kept in use never got the quiet moment, and nothing told the person a new version was there. Reload takes the same
//   way as the quiet reload, as soon as nothing would be lost; Later hides the card until the next version, and leaving
//   the tab still reloads it.
// - Accepted (PLNR-262): a reload drops the scroll of a long list and an open popover, with nothing typed in them lost. A
//   file picker or a passkey prompt left open over IDLE_MS has the page reload under it: the person picks the file again
//   or signs in again. The passkey requests go past `call()`, so no write hold covers them, and one around the ceremony is
//   not worth it.
//
// Considered (2026-11-04): the network first for the shell, with a timeout, costs every warm start a round trip (280 ms on
// the owner's line, perf:net) and does nothing for a tab left open; a "new version, reload" prompt in place of the quiet
// reload asks for a click the page can make itself while nobody is looking (the card is in addition to it, for the time
// somebody is); the server naming its build in `hello` would spare a reconnect its conditional sw.js request (a few
// hundred bytes), for a build id the page and the server would both have to carry.
// Not taken from the UpdateAvailable/UpdateRequired artboards (owner 2026-11-07): the line Later folds the card into
// (leaving the tab reloads it anyway), a "sync paused" strip for another protocol (the page reloads at once, and the
// queue on disk goes out from the new version), a toast after the reload, What's new (no changelog), a ⌘R hint (the
// browser's own reload skips the handover).
import { observable, runInAction } from "mobx";
import { typing } from "./typing.ts";

/** Opened or brought back this recently, with no input since: nobody is in the middle of anything yet. */
const FRESH_MS = 10_000;
/** Away (hidden, no focus) with no input for this long: not a picker or a prompt opened from the page a moment ago. */
const IDLE_MS = 30_000;
/** How often a waiting reload looks again while time passing or a holder letting go can change the answer. */
const RETRY_MS = 1000;

const holds = new Set<() => boolean>();
const handovers = new Set<() => void>();
let writes = 0;

/** While `loses()` says a reload now would lose something, a reload for a new version waits. */
export function holdReload(loses: () => boolean): void {
  holds.add(loses);
}

/** A write request or an upload: a reload for a new version waits until it settles. */
export async function holdReloadFor<T>(work: Promise<T>): Promise<T> {
  writes++;
  try {
    return await work;
  } finally {
    writes--;
  }
}

/** Runs just before a reload for a new version: what lives only in memory goes where the next page finds it. */
export function beforeReload(save: () => void): void {
  handovers.add(save);
}

/** A value handed over a reload, with the person whose page it was. */
interface Handover {
  by: string;
  value: unknown;
}

export const handover = (by: string, value: unknown): Handover => ({ by, value });

/**
 * The value handed over, if the person signed in now is the one it came from. Another person may have signed in in this
 * browser meanwhile (the cookie is the browser's), and the next page is theirs.
 */
export function handedOver(saved: unknown, signedIn: unknown): unknown {
  const h = saved as Partial<Handover> | null;
  return typeof h?.by === "string" && h.by === signedIn ? (h.value ?? null) : null;
}

/** What the watcher needs of the browser; a test passes stand-ins. */
export interface Page {
  sw: Pick<ServiceWorkerContainer, "controller" | "getRegistration" | "register" | "addEventListener">;
  document: Pick<Document, "visibilityState" | "hasFocus" | "activeElement" | "addEventListener">;
  /** Where input and the window's blur arrive. */
  window: Pick<Window, "addEventListener">;
  reload(): void;
}

/** The card by the avatar: a new version waits for a reload, or is being reloaded into at the person's word. */
export type UpdateCard = "ready" | "reloading" | null;

export interface NewVersion {
  /** What the card shows; observable. */
  readonly card: UpdateCard;
  /** Reload as soon as nothing would be lost: the card's button. */
  reloadNow(): void;
  /** Hide the card until the next version; the quiet reload still comes. */
  later(): void;
  /** Asks the server whether there is a newer worker. */
  check(): void;
  /** The server speaks another protocol: reload as soon as the new version is here, without waiting for a quiet moment. */
  reloadSoon(): void;
}

/** Registers the worker and reloads the page into each new version that takes over. */
export function watch(page: Page): NewVersion {
  const { sw, document: doc } = page;
  // A worker in control of this load, or one registered before it (a hard reload leaves the page without one), makes a
  // takeover a newer version; a hard reload that already fetched it costs one needless reload, at a quiet moment. With
  // neither this is a first visit, and the first worker to take over is this very version.
  const known = sw.controller ? Promise.resolve(true) : sw.getRegistration().then((r) => !!r?.active, () => false);
  const registration = known.then(() => sw.register("/sw.js"));
  registration.catch(() => {}); // no worker: no new versions either, and nothing to report
  let firstTakeover = true;
  let behind = false;
  let urgent = false;
  let asked = false;
  let dismissed = false;
  const card = observable.box<UpdateCard>(null);
  let shownAt = Date.now();
  let inputAt = -Infinity;
  let retry: ReturnType<typeof setInterval> | undefined;
  let updating: Promise<ServiceWorkerRegistration> | null = null;

  const away = () => doc.visibilityState === "hidden" || !doc.hasFocus();
  const idle = () => away() && Date.now() - inputAt >= IDLE_MS;
  const fresh = () => inputAt < shownAt && Date.now() - shownAt < FRESH_MS;
  const loses = () => typing(doc.activeElement) || writes > 0 || [...holds].some((h) => h());

  function reload(): void {
    clearInterval(retry);
    retry = undefined;
    behind = false;
    for (const save of handovers) save();
    page.reload();
  }

  function attempt(): void {
    if (!behind) return;
    if (urgent || ((asked || idle() || fresh()) && !loses())) return reload();
    // In front and in use, only leaving can change the answer, and blur and visibilitychange say when; asked, a write
    // settling or a holder letting go.
    if (asked || away() || fresh()) retry ??= setInterval(attempt, RETRY_MS);
    else {
      clearInterval(retry);
      retry = undefined;
    }
    const shown: UpdateCard = dismissed ? null : asked ? "reloading" : "ready";
    if (card.get() !== shown) runInAction(() => card.set(shown));
  }

  /** Overlapping calls share one request: every open workspace's socket comes back after a restart. */
  function update(): Promise<ServiceWorkerRegistration> {
    return (updating ??= registration
      .then(async (r) => {
        await r.update();
        return r;
      })
      .finally(() => (updating = null)));
  }

  sw.addEventListener("controllerchange", () => {
    void known.then((was) => {
      if (!was && firstTakeover) return void (firstTakeover = false);
      behind = true;
      dismissed = false;
      attempt();
    });
  });
  const input = () => void (inputAt = Date.now());
  for (const type of ["pointerdown", "keydown", "wheel"] as const) page.window.addEventListener(type, input, { capture: true, passive: true });
  doc.addEventListener("visibilitychange", () => {
    // Back after a real absence, not from a picker or a glance at another tab a moment after a click.
    if (doc.visibilityState === "visible" && Date.now() - inputAt >= IDLE_MS) shownAt = Date.now();
    attempt();
  });
  page.window.addEventListener("blur", attempt);

  return {
    get card() {
      return card.get();
    },
    reloadNow() {
      asked = true;
      attempt();
    },
    later() {
      dismissed = true;
      runInAction(() => card.set(null));
    },
    check: () => void update().catch(() => {}),
    reloadSoon() {
      urgent = true;
      if (behind) return attempt();
      // The new worker's takeover reloads (controllerchange). With none on its way, a plain reload, as before.
      update().then((r) => void (!behind && !r.installing && !r.waiting && reload()), reload);
    },
  };
}

/** The running watcher, observable: it starts after the first render, and the card reads it. */
const active = observable.box<NewVersion | null>(null, { deep: false });

/** Starts the watcher; only a production build has the worker. */
export function watchNewVersion(): void {
  const watcher = watch({ sw: navigator.serviceWorker, document, window, reload: () => location.reload() });
  runInAction(() => active.set(watcher));
}

/** What the card by the avatar shows; observable. */
export const updateCard = (): UpdateCard => active.get()?.card ?? null;

export const reloadNow = (): void => active.get()?.reloadNow();

export const later = (): void => active.get()?.later();

/** The socket is back, perhaps from a server a deploy restarted. */
export const checkForNewVersion = (): void => active.get()?.check();

/** The server speaks another protocol version: the sync engine's reload hook. */
export const reloadForNewVersion = (): void => {
  const watcher = active.get();
  if (watcher) watcher.reloadSoon();
  else location.reload();
};
