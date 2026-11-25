// Push on this device (RSVA-647): the browser's subscription with its push service, made with the server's VAPID key
// and handed to the server (POST /auth/push), which pushes what the rules send to every device of the person. The
// Service Worker shows a push and opens its issue (build/shell.ts).
//
// iPhone and iPad take push only in an app added to the Home Screen (iOS 16.4 and later): Safari's tab has no
// PushManager, and the page says how to add it. A development build runs no Service Worker, so it has no push either.
import type { PushView } from "@rsva/protocol";
import { call } from "./api.ts";

/** Whether this browser can take push: yes, after adding the app to the Home Screen (iOS), or not at all. */
export type PushSupport = "yes" | "home-screen" | "no";

const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export function pushSupport(): PushSupport {
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "yes";
  return ios() && !standalone() ? "home-screen" : "no";
}

/** Whether the person blocked notifications for this site: then only the browser's own settings let them in again. */
export const pushBlocked = () => "Notification" in window && Notification.permission === "denied";

const registration = async () => (pushSupport() === "yes" ? ((await navigator.serviceWorker.getRegistration()) ?? null) : null);

/** This browser's subscription's address, to find this device among the person's: null while it has none. */
export async function thisEndpoint(): Promise<string | null> {
  const sub = await (await registration())?.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}

const bytes = (b64url: string) => Uint8Array.from(atob(b64url.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const sameKey = (a: ArrayBuffer | null, key: Uint8Array) => !!a && a.byteLength === key.length && new Uint8Array(a).every((x, i) => x === key[i]);

/**
 * Asks the browser for permission (from the click itself: iOS asks only then), subscribes with the server's key and
 * hands the subscription to the server. A subscription made with another key (the server's changed) is made again: its
 * push service would refuse the server's messages.
 */
export async function turnOnPush(key: string): Promise<PushView> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "Notifications are blocked for this site. Allow them in the browser’s settings, then try again." : "Notifications were not allowed.");
  const reg = await registration();
  if (!reg) throw new Error("This build of the app has no service worker, so it cannot take push.");
  const applicationServerKey = bytes(key);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, applicationServerKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  return call<PushView>("POST", "/auth/push", sub.toJSON());
}

/** Removes one of the person's devices; this one's subscription goes with it, so the browser keeps none. */
export async function removePushDevice(id: string, isThis: boolean): Promise<PushView> {
  if (isThis) await (await (await registration())?.pushManager.getSubscription())?.unsubscribe();
  return call<PushView>("DELETE", `/auth/push/${id}`);
}

export const testPush = (id: string) => call<{ sent: boolean; view: PushView }>("POST", `/auth/push/${id}/test`);
