// An avatar without a picture: one of the first four tones, picked by the name, so a person keeps theirs everywhere. The
// web draws the name's creature on it (@rsva/ui lib/creature.ts, components/user-avatar.tsx), the TUI (apps/tui) the
// initials. The other four tones are for a creature one makes: its string keeps the tone's index, so new tones go at the
// end. The eight are hues 45° apart (globals.css), so no two look alike.

import { nameHash } from "./name-hash.ts";

/** "Robin Vale" → "RV", "bot" → "B". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase();
}

/** What a name picks from: the tones the TUI draws too; every name keeps the tone it had before the other four. */
const NAME_TONES = ["sand", "sage", "mauve", "slate"] as const;
export type NameTone = (typeof NAME_TONES)[number];
export const AVATAR_TONES = [...NAME_TONES, "clay", "moss", "teal", "iris"] as const;
export type AvatarTone = (typeof AVATAR_TONES)[number];
/** The tones round the color wheel, 45° apart: the order the creature editor shows them in. */
export const TONES_BY_HUE: readonly AvatarTone[] = ["clay", "sand", "moss", "sage", "teal", "slate", "iris", "mauve"];

/** The name's tone: the same name, the same tone. */
export function avatarTone(name: string): NameTone {
  const h = nameHash(name);
  return NAME_TONES[Math.abs(h) % NAME_TONES.length]!;
}
