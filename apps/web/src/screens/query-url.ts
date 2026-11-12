// The list's filter in the address bar as ?q=<query text>, its order with it (`order:`, PLNR-401), and a ?q= the page
// was opened with applied to the list: the same text the View panel's query line, the CLI and agents take.
import { reaction } from "mobx";
import { useEffect } from "react";
import { router } from "../router.ts";
import { store } from "../store.ts";
import type { ProjectView } from "../view-state.ts";

/**
 * The ?q= a page was opened with, taken once by the first list that shows under its path. Switching tabs must not
 * carry it on: the address then holds the previous tab's filter, which would land in the next tab's view (PLNR-74).
 */
let opened: { path: string; q: string } | null = (() => {
  const q = new URLSearchParams(location.search).get("q");
  return q === null ? null : { path: location.pathname, q };
})();

/** `base`: the path the list lives under (a project's issues, a view's page); the URL of anything else is left alone. */
export function useQueryUrl(view: ProjectView, base: string): void {
  const ready = store.status === "ready";
  useEffect(() => {
    if (!ready) return;
    if (opened && opened.path.startsWith(base)) view.setQuery(opened.q);
    opened = null;
    // Runs on filter changes and on navigation (the router drops the search part), so ?q= survives opening an issue.
    return reaction(
      () => [view.query, router.path] as const,
      ([text]) => {
        // Navigation to another list fires this before the list unmounts: that URL belongs to the next one.
        if (!router.path.startsWith(base)) return;
        const params = new URLSearchParams(location.search);
        if (text) params.set("q", text);
        else params.delete("q");
        const search = params.toString().replace(/%3A/g, ":").replace(/%2C/g, ",").replace(/\+/g, "%20");
        const url = location.pathname + (search ? `?${search}` : "") + location.hash;
        if (url !== location.pathname + location.search + location.hash) history.replaceState(history.state, "", url);
      },
      { fireImmediately: true },
    );
  }, [ready, view, base]);
}
