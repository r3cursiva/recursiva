// Sign-in state in the browser. The session cookie is HttpOnly; the server sets rsva_in=1 beside it, so the shell
// knows before any request whether to start the workspace or the sign-in screen (apps/server/src/auth/actor.ts). The
// marker is only a hint: a session that ended on the server comes back as 401 or a socket closed with
// CLOSE_UNAUTHORIZED, and the store's errorCode switches the app to the sign-in screen (App.tsx).
//
// Local copies (IndexedDB, saved lists and views) belong to the person who signed in. Signing out deletes them, and the
// server's answer tells the browser to drop its cached files and pictures (Clear-Site-Data, RSVA-620); signing
// in as someone else than last time deletes the previous person's first. The same person keeps them, with any
// changes still queued, across an expired session.
//
// A tab holding a person's unsent changes keeps them in memory too, and another person's sign-in in the same browser
// deletes the database under it (the wipe). So the person signing in gets the copy of their open tab's engines written
// back before the page reloads, whether a wipe ran or not: the changes survive in that tab, and only there.
import { copySlug } from "@rsva/sync";
import { readLocal, writeLocal } from "./lib/local-storage.ts";
import { forgetSignedIn } from "./lib/signed-in.ts";
import { closeEngines, enginesOf } from "./store.ts";

const USER_KEY = "rsva:user";
/** Device preferences, not data: kept when the person changes. */
const KEEP = new Set(["rsva:theme", "rsva:ui"]);

/** Who signed in last in this browser, as signedInAs saved it; null after a sign-out. */
export const signedInUser = (): unknown => readLocal(USER_KEY);

/** Deletes every local copy of workspace data and the saved lists, views and drafts. */
async function wipeLocalData(): Promise<void> {
  await closeEngines();
  try {
    // Session storage too: comment drafts handed over a reload (rich-editors.tsx) wait there for the next page.
    for (const s of [localStorage, sessionStorage]) for (const key of Object.keys(s)) if (key.startsWith("rsva:") && !KEEP.has(key)) s.removeItem(key);
  } catch {
    // Storage blocked: nothing was saved there either.
  }
  const dbs = await indexedDB.databases?.().catch(() => []);
  await Promise.all(
    (dbs ?? [])
      .filter((d) => copySlug(d.name) !== null)
      .map(
        (d) =>
          new Promise<void>((resolve) => {
            const r = indexedDB.deleteDatabase(d.name!);
            r.onsuccess = r.onerror = r.onblocked = () => resolve();
          }),
      ),
  );
}

/** After a successful sign-in, before the app starts: a different person than last time starts from a clean slate. */
export async function signedInAs(userId: string): Promise<void> {
  const last = readLocal(USER_KEY);
  // Taken before the wipe closes and forgets every engine; they keep their queue in memory after that.
  const own = enginesOf(userId);
  if (last !== null && last !== userId) await wipeLocalData();
  writeLocal(USER_KEY, userId);
  await Promise.all(own.map((e) => e.rewrite().catch(() => undefined)));
}

/** Ends the session and wipes this device's copies; then `next` opens (an invite link signs in as its address). */
export async function signOut(next = "/"): Promise<void> {
  // The local data goes even if the server cannot be reached: the person asked to leave this device.
  await fetch("/auth/sign-out", { method: "POST" }).catch(() => {});
  forgetSignedIn();
  await wipeLocalData();
  location.assign(next);
}
