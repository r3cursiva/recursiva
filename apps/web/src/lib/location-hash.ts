// The address's hash as state: following a link to a comment of the open issue changes nothing else.
import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  addEventListener("hashchange", onChange);
  return () => removeEventListener("hashchange", onChange);
}

export const useHash = (): string => useSyncExternalStore(subscribe, () => location.hash);
