// Roles as the screens show and check them: one label per role, and what the viewer may do in the open workspace.
// The server enforces the same table (packages/policy); the screens only decide what to offer.
import { can, type Capability, type Role } from "@rsva/policy";
import { store } from "../store.ts";

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member", guest: "Guest" };

/** Whether the viewer's role in the open workspace, with what it opened to members, allows this. Read inside an observer. */
export const viewerCan = (cap: Capability): boolean => !!store.role && can({ role: store.role, rights: store.workspace?.memberRights ?? [] }, cap);
