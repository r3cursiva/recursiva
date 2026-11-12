// Undo of what this TUI changed (PLNR-440): `u` puts back the last change, then the one before, while the process lives.
// Every write the list and the issue screen make goes through one function (App.change), which keeps what the fields
// were and what they became. A field someone changed since (in the web, an agent, another TUI) is left as they set it:
// undo only puts back a field that still has the value this TUI gave it.
//
// Considered: the web's way, an Undo closure a notice carries for a few seconds (each action writes its own inverse; no
// stack, and a keyboard has no button to press); and an undo inside the sync engine, shared with the web (a change to
// the engine for one screen's keys). A stack of before/after values here is a few lines and checkable.
import type { IssueUpdate } from "@rsva/schema/models";

export interface Change {
  id: string;
  /** What the fields were, and what this TUI made them. */
  before: IssueUpdate;
  after: IssueUpdate;
  /** What it was, for the status line: "PLNR-12 → Done". */
  said: string;
}

/** The changes kept: enough for a session's work, few enough to hold in memory. */
const KEPT = 100;

/**
 * Whether a field still has the value this TUI gave it. A time the server stamps (archived, deleted) differs from the
 * client's: set or not set is what counts there.
 */
function still(field: string, now: unknown, after: unknown): boolean {
  if (field.endsWith("At")) return !!now === !!after;
  return JSON.stringify(now ?? null) === JSON.stringify(after ?? null);
}

export class Undo {
  private stack: Change[] = [];

  record(c: Change): void {
    this.stack.push(c);
    if (this.stack.length > KEPT) this.stack.shift();
  }

  /**
   * The patch that puts back the last change, with what it was; the fields changed since are left out. Null when there
   * is nothing to undo; an empty patch when everything it changed was changed again since.
   */
  take(current: (id: string) => IssueUpdate | undefined): { change: Change; patch: IssueUpdate } | null {
    const change = this.stack.pop();
    if (!change) return null;
    const now = current(change.id) as Record<string, unknown> | undefined;
    const patch: Record<string, unknown> = {};
    if (now) for (const [k, v] of Object.entries(change.before)) if (still(k, now[k], (change.after as Record<string, unknown>)[k])) patch[k] = v;
    return { change, patch: patch as IssueUpdate };
  }
}

/** The fields of `patch` as `issue` has them now: what undo puts back. */
export function beforeOf(issue: IssueUpdate, patch: IssueUpdate): IssueUpdate {
  const was = issue as Record<string, unknown>;
  return Object.fromEntries(Object.keys(patch).map((k) => [k, was[k] ?? null])) as IssueUpdate;
}
