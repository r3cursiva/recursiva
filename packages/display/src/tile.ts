// A workspace's or project's tile tone, for the web (@rsva/ui components/letter-tile.tsx) and the TUI (apps/tui).
import type { TileColor } from "@rsva/schema/models";

import { nameHash } from "./name-hash.ts";

/** The tones a workspace or project may have (TILE_COLORS), so a stored color draws without a cast. */
export type TileTone = TileColor;

// Three on purpose: a longer list would repaint every tile that never had a color chosen.
const BY_NAME: TileTone[] = ["teal", "indigo", "umber"];

/** A stable tone for a workspace or project that isn't the current one. */
export function tileTone(name: string): TileTone {
  const h = nameHash(name);
  return BY_NAME[Math.abs(h) % BY_NAME.length]!;
}
