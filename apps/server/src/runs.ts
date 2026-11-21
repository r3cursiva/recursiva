// The rules of an agent's loop on one issue (RSVA-636), as pure functions over its runs: how long a lease is, which runs
// count as attempts, when the loop stops, what an error's fingerprint is and what the stop says on the issue. The routes
// and the rows are in api-runs.ts.
//
// Attempts are derived from the run rows, not kept in a counter: the runs of an issue's stage since the last one that
// ended the count (a `done` one, or a `stopped` one a person has since reset). A counter column would have to be reset
// by hand on `done` and on a person's reset, and would be one more thing two writers race on; a stop marker on the issue
// would put server-only state in the synced row. The rows already say everything, and a stage has a handful of them.
import { createHash } from "node:crypto";
import type { RunOutcome } from "@rsva/schema/models";
import { MARKDOWN_PUNCTUATION } from "./http.ts";

/** A lease in seconds: an hour when none is asked; asked ones are held between a minute and six hours. Renew extends. */
const LEASE_DEFAULT = 3600;
export const LEASE_MIN = 60;
export const LEASE_MAX = 6 * 3600;
/** Failed or expired attempts of a stage after which the loop stops. */
const ATTEMPTS_MAX = 3;
/** Longest note and error kept: a note is a line or two, an error the head of a log. */
export const NOTE_MAX = 2000;
export const ERROR_MAX = 4000;

/** What the rules read of a run, oldest first. */
export interface RunFacts {
  outcome: RunOutcome | null;
  errorFingerprint: string | null;
}

const failed = (r: RunFacts) => r.outcome === "failed" || r.outcome === "expired";

/** The runs that count as attempts now: those after the last done or stopped one. */
export function attemptsOf<R extends RunFacts>(runs: readonly R[]): R[] {
  const last = runs.findLastIndex((r) => r.outcome === "done" || r.outcome === "stopped");
  return runs.slice(last + 1);
}

/**
 * Why the loop stops after the attempts so far (attemptsOf), or null: ATTEMPTS_MAX failed or expired ones, or the last
 * two failed with the same error. An expired run has no error, so it never repeats one.
 */
export function stopReason(attempts: readonly RunFacts[]): string | null {
  const failures = attempts.filter(failed).length;
  if (failures >= ATTEMPTS_MAX) return `${failures} failed attempts`;
  const [a, b] = attempts.slice(-2);
  if (a?.outcome === "failed" && b?.outcome === "failed" && a.errorFingerprint !== null && a.errorFingerprint === b.errorFingerprint) return "the same error twice in a row";
  return null;
}

/**
 * The error with what changes between two runs of the same failure taken out, hashed: ids (UUIDs, hex of six or more
 * with a digit), paths, then every digit (times, line numbers, ports), runs of whitespace, case.
 */
export function fingerprint(error: string): string {
  const normal = error
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/(?:[a-z]:)?(?:[\w.~@+-]*[/\\])+[\w.@+-]*/g, "<path>")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/g, "<id>")
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normal).digest("hex").slice(0, 16);
}

/** A lease asked in seconds, held to LEASE_MIN…LEASE_MAX; null when it is not a whole number of seconds above zero. */
export function leaseSeconds(v: unknown): number | null {
  if (v === undefined) return LEASE_DEFAULT;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return null;
  return Math.min(Math.max(v, LEASE_MIN), LEASE_MAX);
}

/** What the stop comment lists of an attempt. */
export interface Tried {
  outcome: RunOutcome;
  note: string | null;
  error: string | null;
}

/** Text from a run as plain Markdown text: no link, mention or emphasis it could carry. */
const literal = (s: string) => s.replace(MARKDOWN_PUNCTUATION, "\\$&");

/** The comment a stop leaves on the issue: why, each attempt (outcome, note, the error's first line), and what resets it. */
export function stopComment(stage: string, reason: string, tried: readonly Tried[], movedToReview: boolean): string {
  const lines = tried.map((t, i) => {
    const firstLine = t.error?.split("\n").find((l) => l.trim())?.trim().slice(0, 200);
    const parts = [t.outcome, t.note && literal(t.note.replace(/\s+/g, " ")), firstLine && `error: ${literal(firstLine)}`].filter(Boolean);
    return `${i + 1}. ${parts.join(" — ")}`;
  });
  const next = movedToReview
    ? `Agents cannot claim the ${stage} stage again until a person moves the issue out of review.`
    : `The project has no review state, so the issue stays where it is; agents cannot claim the ${stage} stage again until a person changes its state.`;
  return [`Stopped the ${stage} loop: ${reason}.`, "", "Tried:", "", ...lines, "", next].join("\n");
}
