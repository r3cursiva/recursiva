// The phone's More tab: what the sidebar holds on a wider screen. The workspaces and their menu, the views,
// the theme, the account and the connection.
import { BookmarksIcon } from "@phosphor-icons/react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@rsva/ui/components/dropdown-menu";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { paths, router } from "../router.ts";
import { currentWs, store } from "../store.ts";
import { AccountItems, ConfirmSignIn, WhoAmI } from "./account-menu.tsx";
import { ConnectionPanel } from "./connection-panel.tsx";
import type { MenuProps } from "./lazy-menu.tsx";
import { SyncStatus } from "./sidebar-foot.tsx";
import { LeaveDialog, refreshed, WorkspaceMenuItems } from "./workspace-menu.tsx";

export const MoreMenu = observer(function MoreMenu({ open, onOpenChange, trigger }: MenuProps) {
  const [leaving, setLeaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [connection, setConnection] = useState(false);
  const me = store.me;
  return (
    <>
      <DropdownMenu open={open} onOpenChange={(next) => onOpenChange(refreshed(next))}>
        <DropdownMenuTrigger render={trigger} />
        <DropdownMenuContent className="w-64">
          {me && <WhoAmI name={me.name} email={me.email} />}
          <DropdownMenuSeparator />
          <WorkspaceMenuItems onLeave={() => setLeaving(true)} withEmail={false} />
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push(paths.views(currentWs()))}>
            <BookmarksIcon />
            Views
          </DropdownMenuItem>
          <AccountItems onConfirm={() => setConfirming(true)} />
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setConnection(true)}>
            <SyncStatus />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConnectionPanel open={connection} onOpenChange={setConnection} />
      <LeaveDialog ws={currentWs()} open={leaving} onClose={() => setLeaving(false)} />
      {confirming && me && <ConfirmSignIn email={me.email} onClose={() => setConfirming(false)} />}
    </>
  );
});
