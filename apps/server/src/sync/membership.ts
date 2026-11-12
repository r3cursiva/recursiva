// After a membership change commits: whoever caches roles forgets the old one (auth/access.ts), and the sockets of
// someone who is no longer a member close at once instead of on their next check (sync/socket.ts). A small event list
// rather than imports both ways: access and sockets depend on the write pipeline, not the other way round.
import type { Action } from "@rsva/protocol";

export type MembershipListener = (workspaceId: string, userId: string, role: string | null) => void;

const listeners = new Set<MembershipListener>();

export function onMembershipChange(l: MembershipListener): void {
  listeners.add(l);
}

/** After the workspace's member rights change (ADR 0037): whoever caches them forgets them. */
export type RightsListener = (workspaceId: string) => void;

const rightsListeners = new Set<RightsListener>();

export function onRightsChange(l: RightsListener): void {
  rightsListeners.add(l);
}

/** Tells the listeners about the User actions among these, and the Workspace ones that change member rights. */
export function membershipChanged(workspaceId: string, actions: readonly Action[]): void {
  for (const a of actions) {
    if (a.m === "Workspace" && a.d && "memberRights" in a.d) for (const l of rightsListeners) l(workspaceId);
    if (a.m !== "User" || !a.d || !("role" in a.d)) continue;
    const role = a.d.role as string | null;
    for (const l of listeners) l(workspaceId, a.mid, role);
  }
}
