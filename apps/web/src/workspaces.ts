// The workspaces the viewer can open, for the switcher, the palette and the "not found" screen, and where switching to
// each one lands: the project last open there, so the cold snapshot sends that project first and there is no redirect.
// Also whether the viewer may create workspaces (RSVA_WORKSPACE_CREATORS on the server): the "Create" entries
// show only then.
import type { WorkspaceListItem } from "@rsva/protocol";
import { compareStructural, makeAutoObservable, observableRef, reaction, runInAction } from "mobx";
import { account } from "./account.ts";
import { readLocal, writeLocal } from "./lib/local-storage.ts";
import { sessionEnded } from "./lib/signed-in.ts";
import { paths, routeProject, router } from "./router.ts";
import { currentWs, store } from "./store.ts";

const LIST_KEY = "rsva:workspaces";
const MAY_CREATE_KEY = "rsva:may-create";

/** The last list the server sent, so the menus show every workspace at start without a request. */
function savedList(): WorkspaceListItem[] | null {
  const v = readLocal(LIST_KEY);
  return Array.isArray(v) ? (v as WorkspaceListItem[]) : null;
}

class Workspaces {
  /**
   * The last known list (saved locally), else null until the first answer. Not in the start path: the app asks for it
   * after the first paint only when nothing is saved; the menus refresh it on open.
   */
  list: WorkspaceListItem[] | null = savedList();
  /**
   * May the viewer create workspaces. Saved like the list and set by every sign-in, so no request at start; false
   * until known. Asked again once a page, when the viewer reaches for workspaces (account.refresh).
   */
  mayCreate = readLocal(MAY_CREATE_KEY) === true;
  private loading: Promise<void> | null = null;

  constructor() {
    makeAutoObservable<Workspaces, "loading">(this, { list: observableRef, loading: false });
  }

  setMayCreate(may: boolean): void {
    this.mayCreate = may;
    writeLocal(MAY_CREATE_KEY, may);
  }

  /** Puts the open workspace's name and color into the list, so the menus show a change at once. */
  patch(w: Pick<WorkspaceListItem, "slug" | "name" | "color">): void {
    const i = this.list?.findIndex((x) => x.slug === w.slug) ?? -1;
    if (i < 0 || (this.list![i]!.name === w.name && (this.list![i]!.color ?? null) === w.color)) return;
    this.list = this.list!.with(i, { ...this.list![i]!, name: w.name, color: w.color ?? null });
    writeLocal(LIST_KEY, this.list);
  }

  /** Fetches the list; the old one stays on screen meanwhile. Concurrent calls share one request. */
  load(): Promise<void> {
    return (this.loading ??= fetch("/sync/workspaces")
      .then((r) => {
        // The session ended: removed from the last workspace, or the last invite revoked.
        if (r.status === 401) sessionEnded();
        return r.ok ? (r.json() as Promise<WorkspaceListItem[]>) : Promise.reject(new Error(`HTTP ${r.status}`));
      })
      .then(
        (list) => {
          runInAction(() => (this.list = list));
          writeLocal(LIST_KEY, list);
        },
        (e: unknown) => {
          console.warn("rsva workspaces:", e);
          runInAction(() => (this.list ??= []));
        },
      )
      .finally(() => (this.loading = null)));
  }
}

export const workspaces = new Workspaces();
account.onMe = (me) => workspaces.setMayCreate(!!me.mayCreateWorkspaces);

const lastKey = (slug: string) => `rsva:last-project:${slug}`;

/** Where switching to a workspace lands. */
export function workspacePath(slug: string): string {
  const key = readLocal(lastKey(slug));
  return typeof key === "string" ? paths.issues(slug, key) : `/${slug}/`;
}

// The open workspace's engine knows its name and color first (snapshot, deltas, local edits).
reaction(
  () => store.workspace && { slug: store.workspace.slug, name: store.workspace.name, color: store.workspace.color },
  (w) => w && workspaces.patch(w),
  { fireImmediately: true, equals: compareStructural },
);

reaction(
  () => {
    const r = router.route;
    const key = routeProject(r);
    return key ? { ws: currentWs(), key } : null;
  },
  (last) => last && writeLocal(lastKey(last.ws), last.key),
  { fireImmediately: true, equals: compareStructural },
);
