// What an avatar draws for a user (PLNR-244, PLNR-366): their name, their picture's address when they have one, and the
// creature they made. A copy of a workspace saved before these fields has users without them: they draw their name's
// creature until the log brings the rest.
import { picturePath, type User } from "@rsva/schema/models";
import type { Face } from "@rsva/ui/components/user-avatar";
import { store } from "../store.ts";

/** `fallback` names someone the workspace does not know. */
export function face(u: Pick<User, "name" | "picture" | "avatar"> | null | undefined, fallback = "?"): Face & { src: string | null } {
  return { name: u?.name ?? fallback, src: u?.picture ? picturePath(u.picture) : null, avatar: u?.avatar ?? null };
}

/** The same by id, from the open workspace's users. */
export const faceOf = (id: string | null | undefined, fallback?: string): Face => face(id ? store.users.get(id) : undefined, fallback);
