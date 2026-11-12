// What a token's access dialog starts from and how its Read / Write / Custom switch moves (ADR 0037), apart from the
// screen so it is tested: Custom starts from what the token can change now, as a copy of a Stripe restricted key starts
// from the key's permissions. Before, switching a Write token to Custom started every row at Read, and saving took
// everything away (the bot's token, 2026-11-05).
import { tokenReach, type Role } from "@rsva/policy";
import type { ApiTokenView, TokenAccess } from "@rsva/protocol";

/** The token's member, as its access is judged: role, and what the workspace opened to members. */
export interface Holder {
  role: Role;
  rights: readonly string[];
}

/** The access the dialog starts from: what the token can change now; grants its member may not use start at Read. */
export function startAccess(t: Pick<ApiTokenView, "scope" | "grants">, holder: Holder | null): TokenAccess {
  if (t.scope !== "custom") return { scope: t.scope === "write" ? "write" : "read" };
  return { scope: "custom", grants: holder ? [...tokenReach("custom", t.grants, holder.role, holder.rights)] : [] };
}

/** The access after picking another scope: Custom keeps what the token reached, so switching from Write narrows nothing. */
export function changeScope(value: TokenAccess, scope: TokenAccess["scope"], holder: Holder): TokenAccess {
  if (scope !== "custom") return { scope };
  return { scope, grants: value.scope === "custom" ? (value.grants ?? []) : [...tokenReach(value.scope, [], holder.role, holder.rights)] };
}

/** The access chosen, as the server takes it; custom with nothing picked is not ready to send. */
export const accessReady = (a: TokenAccess): boolean => a.scope !== "custom" || (a.grants?.length ?? 0) > 0;
