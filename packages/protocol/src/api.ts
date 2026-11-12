// Answers and bodies of the REST endpoints beside the sync protocol: workspaces, members, invites, tokens, the account.
import type { Role } from "@rsva/policy";
import type { AssignableRole, TileColor } from "@rsva/schema/models";
import type { AccountSettings, ThemeChoice, UiChoice, WeekStart } from "./account.ts";
import type { GroupId } from "./my-work.ts";

/** GET /sync/workspaces: a workspace the viewer can open, for the switcher. */
export interface WorkspaceListItem {
  slug: string;
  name: string;
  /** Tile tone; null: ink while open, else a tone from the name. Missing in a list saved before it existed. */
  color?: TileColor | null;
  /** The viewer's role there. */
  role: Role;
  members: number;
}

// ── Members and invites: /api/v1/… (session only; docs/decisions/0011-members-invites.md) ─────────────────────────

/** An invite as admins see it in the workspace's members settings. */
export interface PendingInvite {
  id: string;
  email: string;
  role: AssignableRole;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
}

/** A token as the settings list it (GET /api/v1/workspaces/:ws/tokens); the secret is never listed. */
export interface ApiTokenView {
  id: string;
  name: string;
  scope: string;
  /** A custom token's grants as given (packages/policy, GRANTS); empty for read and write. */
  grants: string[];
  /** What the grants give now: fewer than `grants` once its giver is no longer an admin. */
  held: string[];
  /** Who gave the grants, by email, and when. */
  grantedBy: string | null;
  grantedAt: string | null;
  /** Its member's email. */
  user: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** A token's access: read, write (what its member may do) or custom with grants (PLNR-271). PATCH …/tokens/:id takes it. */
export interface TokenAccess {
  scope: "read" | "write" | "custom";
  grants?: string[];
}

/** POST /api/v1/workspaces/:ws/tokens. `user` is an agent's email; without it the token is the caller's. */
export interface NewApiToken extends TokenAccess {
  name: string;
  user?: string;
  expiresInDays?: number;
}

export interface PasskeyView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** A session in its person's list. `id` is a handle for this list, not the session's key. */
export interface SessionView {
  id: string;
  current: boolean;
  /** "Chrome on macOS". */
  device: string;
  /** How it signed in: code, passkey or cli. */
  method: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

/** POST /auth/terminal/code: what Settings › Security shows to paste into `rsva login`; works once, until expiresAt. */
export interface TerminalCode {
  code: string;
  expiresAt: string;
}

/** POST /auth/terminal: the terminal's session, sent as `Authorization: Session <session>`. */
export interface TerminalSession {
  session: string;
  expiresAt: string;
  user: { id: string; email: string; name: string };
}

/** GET /auth/security: the person's passkeys and sessions. */
export interface AccountSecurity {
  passkeys: PasskeyView[];
  sessions: SessionView[];
}

/** GET /auth/me. */
export interface AccountMe {
  user: { id: string; email: string; name: string };
  passkeys: PasskeyView[];
  mayCreateWorkspaces: boolean;
  settings: AccountSettings;
}

/** PATCH /auth/me: only what is sent changes. A new name reaches every workspace of the person at once. */
export interface AccountPatch {
  name?: string;
  /** The creature drawn without a picture (PLNR-366), as CREATURE spells it; null goes back to the name's own. */
  avatar?: string | null;
  timeZone?: string;
  weekStart?: WeekStart;
  theme?: ThemeChoice;
  ui?: UiChoice;
  /** My work's sections, whole; null goes back to the groups as they come. */
  myWork?: GroupId[] | null;
}

/** POST /api/v1/workspaces/:ws/invites: who got an email and who was left out because they are already a member. */
export interface InviteResult {
  invited: PendingInvite[];
  members: string[];
}

/** An invite as the invited person sees it: by its link (GET /api/v1/invites/:secret) or in their list. */
export interface InviteView {
  id: string;
  email: string;
  role: AssignableRole;
  invitedBy: string | null;
  workspace: { slug: string; name: string; color: TileColor | null; members: number };
}

/** POST /api/v1/workspaces: a new workspace with its first projects; the creator is its owner. */
export interface CreateWorkspace {
  name: string;
  slug: string;
  color: TileColor | null;
  projects: { name: string; key: string }[];
}
