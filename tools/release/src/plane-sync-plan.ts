// What `pnpm plane:sync` decides, apart from what it runs (plane-sync.ts).
import { WORKSPACE_SLUG } from "@rsva/schema/models";

/** Moved here for good (2026-10-31): Plane holds an archive of them, and importing it would undo the work done since. */
const LIVES_HERE = new Set(["arsen"]);

/** Why this workspace cannot be synced, or null. */
export function refusal(slug: string): string | null {
  if (!WORKSPACE_SLUG.test(slug)) return `"${slug}" is not a workspace slug`;
  return LIVES_HERE.has(slug) ? `"${slug}" lives in recursiva since 2026-10-31: Plane has only its archive` : null;
}

/** An action of the log: the model and the fields it set. */
export interface LogAction {
  model: string;
  fields: string[];
}

/** Rows "model|field,field" of psql, one per action. */
export function parseActions(text: string): LogAction[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [model, fields] = l.split("|");
      return { model: model!, fields: fields ? fields.split(",") : [] };
    });
}

/** The fields an import sets on a row that exists; a change of any other (a project's colour) survives it. */
const OVERWRITTEN: Record<string, string[]> = { Workspace: ["name"], Project: ["name", "key", "archivedAt"] };

/** Per model, the actions since the last import that it would overwrite. Everything else in the workspace counts as work. */
export function editsFrom(actions: LogAction[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { model, fields } of actions) {
    const only = OVERWRITTEN[model];
    if (!only || fields.some((f) => only.includes(f))) out[model] = (out[model] ?? 0) + 1;
  }
  return out;
}
