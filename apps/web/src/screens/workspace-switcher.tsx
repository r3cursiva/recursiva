// The workspace button at the top of the sidebar. Its menu (workspace-menu.tsx) brings Base UI's Menu, so it lives in
// the lazy edit chunk like the other popups (lazy-menu.tsx).
import { CaretDownIcon } from "@phosphor-icons/react";
import { LetterTile, tileTone, type TileTone } from "@rsva/ui/components/letter-tile";
import { cn } from "@rsva/ui/lib/utils";
import { observer } from "mobx-react-lite";
import { store } from "../store.ts";
import { workspaces } from "../workspaces.ts";
import { LazyMenu } from "./lazy-menu.tsx";
import { chunk, loadEditChunk } from "./load-edit-chunk.ts";
import { Tip } from "./sidebar-tip.tsx";

const WorkspaceMenu = chunk("WorkspaceMenu");

/** A workspace's tile tone: its own color; without one, ink for the open workspace and a tone from the name for others. */
export function workspaceTileTone(w: { name: string; color?: TileTone | null }, current: boolean): TileTone {
  return w.color ?? (current ? "ink" : tileTone(w.name));
}

/** A workspace's mark: a lettered tile. */
export function WorkspaceIcon({ workspace: w, current = false, className }: { workspace: { name: string; color?: TileTone | null }; current?: boolean; className?: string }) {
  return <LetterTile name={w.name} tone={workspaceTileTone(w, current)} className={cn("size-6 rounded-lg text-xs", className)} />;
}

/** Hovering the button is the cue to fetch what the menu shows, so it usually opens complete. */
function prefetch(): void {
  void loadEditChunk();
  if (!workspaces.list) void workspaces.load();
}

export const WorkspaceSwitcher = observer(function WorkspaceSwitcher({ ws }: { ws: string }) {
  const name = store.workspace?.name ?? ws;
  return (
    <LazyMenu
      menu={WorkspaceMenu}
      button={(props, open) => (
        <button
          type="button"
          onPointerEnter={prefetch}
          aria-label={`${name} workspace menu`}
          className="group/tip relative flex h-[calc(var(--nav-item)+4px)] min-w-0 flex-1 items-center gap-2 rounded-[5px] px-1.5 text-left outline-none transition-colors duration-120 hover:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-row-hover strip:size-[34px] strip:flex-none strip:justify-center strip:rounded-[9px] strip:px-0"
          {...props}
        >
          <WorkspaceIcon workspace={store.workspace ?? { name }} current className="size-[18px] rounded-[5px] text-[10px] strip:size-7 strip:rounded-lg strip:text-xs" />
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold strip:hidden">{name}</span>
          <CaretDownIcon className={cn("size-3 shrink-0 text-ink-3 transition-transform strip:hidden", open && "rotate-180")} />
          {!open && <Tip>{name}</Tip>}
        </button>
      )}
    />
  );
});
