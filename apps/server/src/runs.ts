// The rules of an agent's loop on one issue (RSVA-636), as pure functions over its runs: how long a lease is, which runs
// count as attempts, when the loop stops, what an error's fingerprint is and what the stop says on the issue. The routes
// and the rows are in api-runs.ts.
//
// Attempts are derived from the run rows, not kept in a counter: the runs of an issue's stage since the last `stopped`
// one (which a person has since reset: a claim after a stop is refused until then), made in the last ATTEMPT_WINDOW. A
// `done` run does not end the count: the agent itself says done, and fail, fail, done, fail must still stop the loop;
// the window is what lets an issue that came back weeks later start afresh. A counter column would have to be reset by
// hand on a person's reset and would be one more thing two writers race on; a stop marker on the issue would put
// server-only state in the synced row. The rows already say everything, and a stage has a handful of them.
import { createHash } from "node:crypto";
import type { RunOutcome } from "@rsva/schema/models";
import { MARKDOWN_PUNCTUATION } from "./http.ts";

/** A lease in seconds: an hour when none is asked; asked ones are held between a minute and six hours. Renew extends. */
const LEASE_DEFAULT = 3600;
export const LEASE_MIN = 60;
export const LEASE_MAX = 6 * 3600;
/** Failed or expired attempts of a stage after which the loop stops. */
const ATTEMPTS_MAX = 3;
/** How far back attempts count: a day. */
const ATTEMPT_WINDOW_MS = 24 * 3600_000;
/**
 * Longest note and error kept: a note is a line or two; an error is its head only, since every member of the workspace
 * reads it, read-only tokens too.
 */
export const NOTE_MAX = 2000;
export const ERROR_MAX = 500;

/** What the rules read of a run, oldest first. */
export interface RunFacts {
  outcome: RunOutcome | null;
  errorFingerprint: string | null;
  createdAt: string;
}

const failed = (r: RunFacts) => r.outcome === "failed" || r.outcome === "expired";

/** The runs that count as attempts now: those after the last stopped one, made in the last ATTEMPT_WINDOW_MS. */
export function attemptsOf<R extends RunFacts>(runs: readonly R[], now = Date.now()): R[] {
  const last = runs.findLastIndex((r) => r.outcome === "stopped");
  return runs.slice(last + 1).filter((r) => now - Date.parse(r.createdAt) < ATTEMPT_WINDOW_MS);
}

/**
 * Why the loop stops after the attempts so far (attemptsOf), or null: ATTEMPTS_MAX failed or expired ones, or the last
 * two failed or expired ones both failed with the same error (a done run between them does not clear it). An expired
 * run has no error, so it never repeats one.
 */
export function stopReason(attempts: readonly RunFacts[]): string | null {
  const failures = attempts.filter(failed);
  if (failures.length >= ATTEMPTS_MAX) return `${failures.length} failed attempts`;
  const [a, b] = failures.slice(-2);
  if (a?.outcome === "failed" && b?.outcome === "failed" && a.errorFingerprint !== null && a.errorFingerprint === b.errorFingerprint) return "the same error twice in a row";
  return null;
}

/** How much of an error's first line its fingerprint reads. */
const FINGERPRINT_CHARS = 500;

/**
 * The error's first non-blank line (FINGERPRINT_CHARS at most) with what changes between two runs of the same failure
 * taken out, hashed: a word with a slash in it is a path, a word of six or more hex digits with a digit an id, then
 * every digit (times, line numbers, ports) goes, and case. Words are split once and each is looked at on its own, so the
 * time is linear in the line: no pattern repeats inside a repeat.
 */
export function fingerprint(error: string): string {
  const line = (error.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, FINGERPRINT_CHARS).toLowerCase();
  const normal = line
    .split(/\s+/)
    .map((word) => (word.includes("/") || word.includes("\\") ? "<path>" : word.replace(/[0-9a-z]+/g, (w) => (w.length >= 6 && /^[0-9a-f]+$/.test(w) && /\d/.test(w) ? "<id>" : w))))
    .join(" ")
    .replace(/\d/g, "");
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

/** A run's own text on one line, as plain Markdown text. */
const line = (s: string) => literal(s.replace(/\s+/g, " ").trim());

/**
 * The comment a done run with criteria leaves on the issue: each "Done when" criterion with the run's evidence for it,
 * and the run's note. All of it as plain text: a criterion's own Markdown (a mention, a link) is quoted, not repeated.
 */
export function evidenceComment(stage: string, proof: readonly { criterion: string; evidence: string }[], note: string | null): string {
  const lines = proof.map((p, i) => `${i + 1}. ${line(p.criterion)} — ${line(p.evidence)}`);
  return [`Completed the ${stage} stage. Done when, with evidence:`, "", ...lines, ...(note ? ["", line(note)] : [])].join("\n");
}

/**
 * Where a stop leaves the issue: moved to review, no review state to move to, or a move the pipeline refused (the
 * review state is for people only, say), with its words.
 */
export type StopMove = { moved: true } | { moved: false; refused?: string };

/** The comment a stop leaves on the issue: why, each attempt (outcome, note, the error's first line), and what resets it. */
export function stopComment(stage: string, reason: string, tried: readonly Tried[], move: StopMove): string {
  const lines = tried.map((t, i) => {
    const firstLine = t.error?.split("\n").find((l) => l.trim())?.trim().slice(0, 200);
    const parts = [t.outcome, t.note && line(t.note), firstLine && `error: ${literal(firstLine)}`].filter(Boolean);
    return `${i + 1}. ${parts.join(" — ")}`;
  });
  const stays = move.moved ? "" : move.refused ? `The move to review was refused (${literal(move.refused)}), so the issue stays where it is` : "The project has no review state, so the issue stays where it is";
  const next = move.moved
    ? `Agents cannot claim the ${stage} stage again until a person moves the issue out of review.`
    : `${stays}; agents cannot claim the ${stage} stage again until a person changes its state.`;
  return [`Stopped the ${stage} loop: ${reason}.`, "", "Tried:", "", ...lines, "", next].join("\n");
}
