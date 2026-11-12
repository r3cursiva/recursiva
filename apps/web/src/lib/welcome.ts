// What the Welcome screen (screens/no-workspace.tsx) leads with (RSVA-552). A person who may create a workspace and has
// no invites, as one let in from the waitlist (ADR 0054), came to create one: that goes first, and the invite-link field
// stays below as the quieter way in. While the invites load, a creator sees creating first too: most have none, and
// the screen should not jump for them.

export type WelcomeLead = "create" | "invites";

/** `invites`: how many the person has, null while they load. */
export const welcomeLead = (mayCreate: boolean, invites: number | null): WelcomeLead => (mayCreate && !invites ? "create" : "invites");
