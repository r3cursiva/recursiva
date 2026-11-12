// What the TUI remembers between starts: the workspace it was last in (PLNR-323), the query last open in each (its
// order with it, PLNR-401) and the theme picked in the palette (PLNR-380), in tui.json beside the copy, 0600. A file it cannot read is a first start; a write that fails is not remembered.
import { readFileSync, writeFileSync } from "node:fs";

export interface Remembered {
  workspace?: string;
  queries: Record<string, string>;
  theme?: string;
}

export function remembered(file: string | null): Remembered {
  if (!file) return { queries: {} };
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { workspace?: unknown; queries?: unknown; theme?: unknown };
    const queries = v.queries && typeof v.queries === "object" ? Object.fromEntries(Object.entries(v.queries).filter((e): e is [string, string] => typeof e[1] === "string" && !!e[1].trim())) : {};
    return { ...(typeof v.workspace === "string" && v.workspace ? { workspace: v.workspace } : {}), queries, ...(typeof v.theme === "string" && v.theme ? { theme: v.theme } : {}) };
  } catch {
    return { queries: {} };
  }
}

export function remember(file: string | null, change: (r: Remembered) => void): void {
  if (!file) return;
  const r = remembered(file);
  change(r);
  try {
    writeFileSync(file, `${JSON.stringify(r)}\n`, { mode: 0o600 });
  } catch {
    // Not remembered: the next start opens on what it finds.
  }
}
