// Who `@` offers in a text (PLNR-334): the web's editors and the TUI's reply ask the same question the same way.
import type { User } from "@rsva/schema/models";

/**
 * The people a mention can name for what is typed after `@`, best first: the name's start, then a later word's, then
 * the email's; by name within each. Guests are left out (they see only their own issues, a mention elsewhere would not
 * reach them), and so is anyone without a role here. Agents are in: their detail line says so.
 */
export function mentionCandidates<U extends Pick<User, "name" | "email" | "role">>(users: Iterable<U>, query: string): U[] {
  const q = query.toLowerCase();
  const scored: [number, U][] = [];
  for (const u of users) {
    if (u.role === null || u.role === "guest") continue;
    const name = u.name.toLowerCase();
    const rank = !q || name.startsWith(q) ? 0 : name.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : u.email.toLowerCase().startsWith(q) ? 2 : -1;
    if (rank >= 0) scored.push([rank, u]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map(([, u]) => u);
}
