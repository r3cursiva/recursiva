// Invites, joining, leaving, new workspaces, tokens, passkeys and sessions: the REST side of the settings screens
// (apps/server/src/workspaces.ts, api.ts, auth/routes.ts). Roles and removals are not here: they are sync ops
// (store.setMemberRole, store.removeMember), optimistic like every other edit.
import type { AccountSecurity, ApiTokenView, CreateWorkspace, GithubStatus, InviteResult, InviteView, NewApiToken, PendingInvite, TerminalCode, TokenAccess } from "@rsva/protocol";
import type { AssignableRole } from "@rsva/schema/models";
import { call } from "../lib/api.ts";
import { workspaces } from "../workspaces.ts";

export { ApiError } from "../lib/api.ts";

const ws = (slug: string) => `/api/v1/workspaces/${encodeURIComponent(slug)}`;

export const peopleApi = {
  invites: (slug: string) => call<{ invites: PendingInvite[] }>("GET", `${ws(slug)}/invites`).then((r) => r.invites),
  invite: (slug: string, emails: string[], role: AssignableRole) => call<InviteResult>("POST", `${ws(slug)}/invites`, { emails, role }),
  resend: (slug: string, id: string) => call<PendingInvite>("POST", `${ws(slug)}/invites/${id}/resend`),
  revoke: (slug: string, id: string) => call<void>("DELETE", `${ws(slug)}/invites/${id}`),
  leave: (slug: string) => call<void>("POST", `${ws(slug)}/leave`),
  /** Settings › GitHub, for admins. */
  github: (slug: string) => call<GithubStatus>("GET", `${ws(slug)}/github`),

  /** Settings › API tokens: the caller's, and for admins everyone's in the workspace. */
  tokens: (slug: string) => call<{ tokens: ApiTokenView[] }>("GET", `${ws(slug)}/tokens`).then((r) => r.tokens),
  /** The secret is in this answer only. ApiError reauth_required asks for a fresh sign-in first. */
  createToken: (slug: string, body: NewApiToken) => call<{ id: string; secret: string }>("POST", `${ws(slug)}/tokens`, body),
  /** A token's access, changed in place (PLNR-271); widening it may answer reauth_required. */
  setTokenAccess: (slug: string, id: string, body: TokenAccess) => call<void>("PATCH", `${ws(slug)}/tokens/${id}`, body),
  revokeToken: (slug: string, id: string) => call<void>("DELETE", `${ws(slug)}/tokens/${id}`),

  /** Settings › Security: this person's, wherever they stand. */
  security: () => call<AccountSecurity>("GET", "/auth/security"),
  removePasskey: (id: string) => call<void>("DELETE", `/auth/passkeys/${encodeURIComponent(id)}`),
  endSession: (id: string) => call<void>("DELETE", `/auth/sessions/${encodeURIComponent(id)}`),
  endOtherSessions: () => call<{ ended: number }>("POST", "/auth/sessions/end-others"),
  /** A one-time code for `rsva login` (PLNR-323); ApiError reauth_required asks for a fresh sign-in first. */
  terminalCode: () => call<TerminalCode>("POST", "/auth/terminal/code"),

  /** The invite of a link; ApiError not_found for a dead one. */
  byLink: (secret: string) => call<InviteView>("GET", `/api/v1/invites/${encodeURIComponent(secret)}`),
  acceptLink: (secret: string) => call<{ slug: string }>("POST", `/api/v1/invites/${encodeURIComponent(secret)}/accept`),
  mine: () => call<{ invites: InviteView[] }>("GET", "/api/v1/me/invites").then((r) => r.invites),
  accept: (id: string) => call<{ slug: string }>("POST", `/api/v1/me/invites/${id}/accept`),
  decline: (id: string) => call<void>("POST", `/api/v1/me/invites/${id}/decline`),

  /** The signed-in person; whether they may create workspaces goes to the workspaces store. */
  me: () =>
    call<{ user: { id: string; name: string; email: string }; mayCreateWorkspaces: boolean }>("GET", "/auth/me").then((r) => {
      workspaces.setMayCreate(r.mayCreateWorkspaces);
      return r.user;
    }),

  slug: (slug: string) => call<{ available: boolean; reason?: string }>("GET", `/api/v1/workspace-slugs/${encodeURIComponent(slug)}`),
  create: (body: CreateWorkspace) => call<{ slug: string }>("POST", "/api/v1/workspaces", body),
};

/** The secret of a pasted invite link (or of the secret itself). */
export function linkSecret(text: string): string | null {
  const m = /(?:\/join\/)?([A-Za-z0-9_-]{20,64})\/?$/.exec(text.trim());
  return m ? m[1]! : null;
}
