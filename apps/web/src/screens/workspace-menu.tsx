// The workspace menu, as in Plane: the viewer's email, then every workspace with its role and member count, the open
// one checked, then the open workspace's settings and members (invites are on the members page), all and archived projects (PLNR-58) and a new
// project for admins (PLNR-59), a new workspace, and leaving. Choosing one
// swaps the store's engine (store.ts) without a page load. Sign-out and the person's own settings are in the account
// menu (account-menu.tsx).
import { ArchiveIcon, DoorOpenIcon, GearSixIcon, PlusIcon, SquaresFourIcon, UsersIcon } from "@phosphor-icons/react";
import type { WorkspaceListItem } from "@rsva/protocol";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@rsva/ui/components/dropdown-menu";
import { Button } from "@rsva/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@rsva/ui/components/dialog";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { ROLE_LABEL, viewerCan } from "../lib/roles.ts";
import { paths, router } from "../router.ts";
import { newProject } from "./palette-state.ts";
import { currentWs, store } from "../store.ts";
import { workspacePath, workspaces } from "../workspaces.ts";
import { account } from "../account.ts";
import { peopleApi } from "./people-api.ts";
import { WorkspaceIcon } from "./workspace-switcher.tsx";
import { ErrorLine, useAction } from "./action.tsx";
import type { MenuProps } from "./lazy-menu.tsx";


/** "Owner · 2 members" */
export function workspaceDetails(w: WorkspaceListItem): string {
  return `${ROLE_LABEL[w.role]} · ${w.members} ${w.members === 1 ? "member" : "members"}`;
}

/** Switches to a workspace: the URL changes, the store follows it. */
export function openWorkspace(slug: string): void {
  if (slug !== currentWs()) router.push(workspacePath(slug));
}

/** Until the list arrives, the open workspace alone, from the store: the menu never opens empty. */
function shown(): (Pick<WorkspaceListItem, "slug" | "name" | "color"> & { details?: string })[] {
  if (workspaces.list) return workspaces.list.map((w) => ({ ...w, details: workspaceDetails(w) }));
  return store.workspace ? [store.workspace] : [];
}

export const WorkspaceMenu = observer(function WorkspaceMenu({ open, onOpenChange, trigger }: MenuProps) {
  const [leaving, setLeaving] = useState(false);
  return (
    <>
      <DropdownMenu open={open} onOpenChange={(next) => onOpenChange(refreshed(next))}>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent className="w-64">
          <WorkspaceMenuItems onLeave={() => setLeaving(true)} />
        </DropdownMenuContent>
      </DropdownMenu>
      <LeaveDialog ws={currentWs()} open={leaving} onClose={() => setLeaving(false)} />
    </>
  );
});

/** Every opening of a menu with the workspaces refreshes the list; the last one shows meanwhile. */
export function refreshed(open: boolean): boolean {
  if (open) void (workspaces.load(), account.refresh());
  return open;
}

/** Every workspace, the open one checked: the menu's list, and the settings' workspace picker (workspace-settings.tsx). */
export const WorkspaceRadioItems = observer(function WorkspaceRadioItems({ onPick }: { onPick: (slug: string) => void }) {
  const ws = currentWs();
  return (
    <DropdownMenuRadioGroup value={ws} onValueChange={(slug: string) => onPick(slug)}>
      {shown().map((w) => (
        <DropdownMenuRadioItem key={w.slug} value={w.slug} closeOnClick className="gap-2.5 py-1.5 text-sm">
          <WorkspaceIcon workspace={w} current={w.slug === ws} className="size-7" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{w.name}</span>
            {w.details && <span className="truncate text-xs text-muted-foreground">{w.details}</span>}
          </span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
});

/** The menu's items, also part of the phone's More menu (more-menu.tsx). */
export const WorkspaceMenuItems = observer(function WorkspaceMenuItems({ onLeave, withEmail = true }: { onLeave: () => void; withEmail?: boolean }) {
  const ws = currentWs();
  return (
    <>
      {/* Not a DropdownMenuLabel: Base UI allows that only as a group's label, and the email labels no group. */}
      {withEmail && store.me && <div className="truncate px-2 py-1.5 text-xs text-muted-foreground">{store.me.email}</div>}
      <WorkspaceRadioItems onPick={openWorkspace} />
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => router.push(paths.workspaceSettings(ws))}>
        <GearSixIcon />
        Workspace settings
        <DropdownMenuShortcut>G ,</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => router.push(paths.workspaceMembers(ws))}>
        <UsersIcon />
        Members
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => router.push(paths.projects(ws))}>
        <SquaresFourIcon />
        All projects
        <DropdownMenuShortcut>G P</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => router.push(paths.projects(ws, true))}>
        <ArchiveIcon />
        Archived projects
        <DropdownMenuShortcut>{store.archivedProjects().length}</DropdownMenuShortcut>
      </DropdownMenuItem>
      {viewerCan("projects.write") && (
        <DropdownMenuItem onClick={() => newProject.show()}>
          <PlusIcon />
          New project
          <DropdownMenuShortcut>N P</DropdownMenuShortcut>
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      {/* /new is Join alone for someone who may not create workspaces. */}
      <DropdownMenuItem onClick={() => router.push(paths.newWorkspace())}>
        <PlusIcon />
        {workspaces.mayCreate ? "Create or join a workspace" : "Join a workspace"}
      </DropdownMenuItem>
      {store.role && (
        <DropdownMenuItem variant="destructive" onClick={onLeave}>
          <DoorOpenIcon />
          Leave {store.workspace?.name ?? ws}…
        </DropdownMenuItem>
      )}
    </>
  );
});

/**
 * Leaving, confirmed: access ends at once and this device's copy of the workspace goes (the engine drops it on the
 * refusal that follows). Then the next workspace opens, or the "no workspace yet" screen while an invite is left;
 * without one the session ends too, and the list's 401 brings the sign-in screen (workspaces.ts). The owner cannot leave.
 */
export const LeaveDialog = observer(function LeaveDialog({ ws, open, onClose }: { ws: string; open: boolean; onClose: () => void }) {
  const { busy, error, run } = useAction();
  const name = store.workspace?.name ?? ws;
  const owner = store.role === "owner";
  const last = !!workspaces.list && !workspaces.list.some((w) => w.slug !== ws);
  const leave = () =>
    run(
      async () => {
        await peopleApi.leave(ws);
        await workspaces.load();
        const next = workspaces.list?.find((w) => w.slug !== ws);
        location.assign(next ? workspacePath(next.slug) : "/");
      },
      { leaves: true },
    );
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{owner ? `You own ${name}` : `Leave ${name}?`}</DialogTitle>
          <DialogDescription>
            {owner
              ? "A workspace always has an owner, so the owner cannot leave. Transferring ownership is not built yet."
              : `You lose access to its ${store.projectList().length} projects at once. Your issues and comments stay. To come back, an admin has to invite you again.` +
                (last ? " It is your last workspace: unless you are invited to another, you are signed out too." : "")}
          </DialogDescription>
        </DialogHeader>
        <ErrorLine error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {owner ? "Close" : "Cancel"}
          </Button>
          {!owner && (
            <Button variant="destructive" disabled={busy} onClick={() => void leave()}>
              Leave workspace
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
