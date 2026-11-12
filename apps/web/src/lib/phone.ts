// The phone layout's query (the max-md variant, globals.css) for the few things CSS cannot switch, and whether the screen
// is touched.
import { useSyncExternalStore } from "react";

const phone = matchMedia("(width < 48rem), (pointer: coarse) and (height < 30rem)");

export const isPhone = (): boolean => phone.matches;

export const isTouch = (): boolean => matchMedia("(pointer: coarse)").matches;

const subscribers = new WeakMap<MediaQueryList, (onChange: () => void) => () => void>();

/** Whether the query matches, re-rendering the caller when that flips (a window resized, a phone turned). */
export function useMatches(query: MediaQueryList): boolean {
  let subscribe = subscribers.get(query);
  if (!subscribe) {
    subscribe = (onChange) => {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    };
    subscribers.set(query, subscribe);
  }
  return useSyncExternalStore(subscribe, () => query.matches);
}

export const useIsPhone = (): boolean => useMatches(phone);
