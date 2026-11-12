// Subscribe and Unsubscribe (PLNR-28) without the bell: the issue list's ⇧S is in the start chunk, the bell
// (subscribe.tsx) only in the chunks that show an issue.
import type { Issue } from "@rsva/schema/models";
import type { Subscription } from "@rsva/sync";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { store } from "../store.ts";
import { notice } from "./notice.ts";

/** Flips the viewer's subscription, and says so with Undo. */
export function toggleSubscription(issue: Issue): void {
  const on = !store.inbox.subscription(issue).following;
  store.inbox.subscribe(issue.id, on);
  const key = store.issueKey(issue);
  notice.show(on ? `Subscribed to ${key}` : `Unsubscribed from ${key}. Anything addressed to you still arrives.`, () => store.inbox.subscribe(issue.id, !on));
}

/** ⇧S on an open or selected issue; true when it was the key. */
export function subscribeKey(e: KeyboardEvent | ReactKeyboardEvent, issue: Issue | undefined): boolean {
  if (!issue || issue.deletedAt || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== "s") return false;
  toggleSubscription(issue);
  return true;
}

/** Unsubscribed from an issue they are involved in: shown under the activity. */
export function unsubscribedNote(s: Subscription): boolean {
  return !s.following && s.involved !== null;
}
