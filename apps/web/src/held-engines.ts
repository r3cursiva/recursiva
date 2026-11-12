// The engines of several workspaces at once, for the screens that read every workspace: My work (PLNR-41) and the inbox
// (RSVA-613). Held open while the screen is (store.ts, holdEngines); the one on screen is there from the first render.
import type { WorkspaceListItem } from "@rsva/protocol";
import type { SyncStore } from "@rsva/sync";
import { useEffect, useState } from "react";
import { holdEngines, store } from "./store.ts";
import { workspaces } from "./workspaces.ts";

/** `slugs` comma-joined, so that a new array with the same workspaces holds nothing again. */
export function useEngines(ws: string, slugs: string): Map<string, SyncStore> {
  const [held, setHeld] = useState<Map<string, SyncStore>>(() => new Map([[ws, store]]));
  useEffect(() => {
    const h = holdEngines(slugs.split(","));
    setHeld(h.engines);
    return h.release;
  }, [slugs]);
  return held;
}

export type Workspace = Pick<WorkspaceListItem, "slug" | "name" | "color">;

/** The viewer's workspaces, asked for when the list lacks the one on screen; that one alone until the list is here. */
export function useWorkspaceList(ws: string): Workspace[] {
  useEffect(() => {
    if (!workspaces.list?.some((w) => w.slug === ws)) void workspaces.load();
  }, [ws]);
  return workspaces.list?.length ? workspaces.list : [{ slug: ws, name: store.workspace?.name ?? ws, color: store.workspace?.color ?? null }];
}
