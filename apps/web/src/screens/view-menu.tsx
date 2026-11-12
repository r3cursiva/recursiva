// A saved view's "⋯" menu (PLNR-74, the ViewsTabMenu artboard): edit (its name too), duplicate, move the tab, the viewer's
// sidebar, who sees it, its link, delete. In the lazy edit chunk, opened through LazyMenu from a tab (`project` set),
// a view's own header and the views page.
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CopyIcon,
  FunnelSimpleIcon,
  LinkIcon,
  LockSimpleIcon,
  TrashIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { pinRef, type SavedView } from "@rsva/protocol";
import type { Project } from "@rsva/schema/models";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@rsva/ui/components/dropdown-menu";
import { observer } from "mobx-react-lite";
import { keys } from "@rsva/ui/lib/keys";
import { mayEdit, projectTabs, viewLink } from "../lib/views.ts";
import { store } from "../store.ts";
import { viewState } from "../view-state.ts";
import { copy } from "./issue-actions.ts";
import type { MenuProps } from "./lazy-menu.tsx";
import { notice } from "./notice.ts";
import { pinLabel, togglePin } from "./pin-actions.ts";
import { deleteView, moveTab } from "./view-actions.ts";
import { viewPanel } from "./view-panel-state.ts";
import { FavoriteStar } from "./favorite-button.tsx";

export const ViewMenu = observer(function ViewMenu({ open, onOpenChange, trigger, saved, project }: MenuProps & { saved: SavedView; project: Project | null }) {
  const editable = mayEdit(saved);
  const pin = pinRef("view", saved.id);
  const pinned = store.views.pinned(pin);
  const own = saved.ownerId === store.me?.id;
  const ws = store.workspace?.name ?? "the workspace";
  const tabs = project ? projectTabs(project.id) : [];
  const at = tabs.findIndex((v) => v.id === saved.id);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent className="w-60" align="start">
        <DropdownMenuItem onClick={() => viewPanel.edit(viewState(saved.id), project)}>
          <FunnelSimpleIcon />
          Edit view
          <DropdownMenuShortcut>E</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => viewPanel.create(viewState(saved.id), project, saved)}>
          <CopyIcon />
          Duplicate
        </DropdownMenuItem>
        {editable && project && tabs.length > 1 && (
          <>
            <DropdownMenuSeparator />
            {at > 0 && (
              <DropdownMenuItem onClick={() => moveTab(saved, project.id, -1)}>
                <ArrowLeftIcon />
                Move left
                <DropdownMenuShortcut>{keys("alt", "←")}</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
            {at < tabs.length - 1 && (
              <DropdownMenuItem onClick={() => moveTab(saved, project.id, 1)}>
                <ArrowRightIcon />
                Move right
                <DropdownMenuShortcut>{keys("alt", "→")}</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => togglePin(pin, saved.name)}>
          <FavoriteStar on={pinned} />
          {pinLabel(pin)}
        </DropdownMenuItem>
        {/* Only its owner makes a view private: an admin's edit keeps someone else's shared view shared. */}
        {editable && (own || !saved.shared) && (
          <DropdownMenuItem
            onClick={() => {
              store.views.save(saved.id, { shared: !saved.shared });
              notice.show(saved.shared ? `${saved.name} is only yours now` : `Everyone in ${ws} sees ${saved.name}`, () => store.views.save(saved.id, { shared: saved.shared }));
            }}
          >
            {saved.shared ? <LockSimpleIcon /> : <UsersThreeIcon />}
            {saved.shared ? "Make it only mine" : `Share with everyone in ${ws}`}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => void copy(viewLink(saved, project), "Link")}>
          <LinkIcon />
          Copy link
        </DropdownMenuItem>
        {editable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => deleteView(saved)}>
              <TrashIcon />
              Delete view
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
