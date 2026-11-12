import { useEffect, useState } from "react";

/** Fades in what came from the network after its placeholder; what was already here, or a step of J/K, shows at once. */
export const LATE = "animate-in duration-200 fade-in-0 in-data-[walked]:animate-none";

/** Longer than a read of IndexedDB, shorter than any round trip: a shorter wait is not "after a placeholder". */
const NOTICED_MS = 50;

/** True once `loading` has lasted for `key` long enough to be seen and is over: the content arrived after its placeholder. */
export function useLate(loading: boolean, key: string): boolean {
  const [seen, setSeen] = useState<string | null>(null);
  if (seen !== null && seen !== key) setSeen(null);
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setSeen(key), NOTICED_MS);
    return () => clearTimeout(t);
  }, [loading, key]);
  return !loading && seen === key;
}
