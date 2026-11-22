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
import type { DocNode } from "@rsva/editor/doc";
import { codeSpans, codeText, toMarkdown, urlSpans } from "@rsva/editor/markdown";
import type { RunOutcome } from "@rsva/schema/models";

/** A lease in seconds: an hour when none is asked; asked ones are held between a minute and six hours. Renew extends. */
const LEASE_DEFAULT = 3600;
export const LEASE_MIN = 60;
export const LEASE_MAX = 6 * 3600;
/** Failed or expired attempts of a stage after which the loop stops; blocked ones (the environment's failures) have their own. */
const ATTEMPTS_MAX = 3;
const BLOCKED_MAX = 3;
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

/**
 * The runs that count as attempts now: those after the last stopped one, made in the last ATTEMPT_WINDOW_MS. A run that
 * asked a person (RSVA-644) is none: it neither numbers the next attempt nor counts toward a stop.
 */
export function attemptsOf<R extends RunFacts>(runs: readonly R[], now = Date.now()): R[] {
  const last = runs.findLastIndex((r) => r.outcome === "stopped");
  return runs.slice(last + 1).filter((r) => r.outcome !== "asked" && now - Date.parse(r.createdAt) < ATTEMPT_WINDOW_MS);
}

/**
 * Why the loop stops after the attempts so far (attemptsOf), or null: ATTEMPTS_MAX failed or expired ones, or the last
 * two failed or expired ones both failed with the same error (a done run between them does not clear it). An expired
 * run has no error, so it never repeats one. A blocked run is the environment's failure, not the agent's: it takes no
 * part in either rule, and BLOCKED_MAX of them stop the loop on their own, so a broken setup, or an agent that calls
 * every failure the environment's, still ends within ATTEMPTS_MAX + BLOCKED_MAX failures.
 */
export function stopReason(attempts: readonly RunFacts[]): string | null {
  const failures = attempts.filter(failed);
  if (failures.length >= ATTEMPTS_MAX) return `${failures.length} failed attempts`;
  const blocked = attempts.filter((r) => r.outcome === "blocked").length;
  if (blocked >= BLOCKED_MAX) return `${blocked} failures of the environment, not of the agent: fix the setup (access, network, tools)`;
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

const text = (t: string): DocNode => ({ type: "text", text: t });
const paragraph = (content: DocNode[]): DocNode => ({ type: "paragraph", content });
const list = (items: DocNode[][]): DocNode => ({ type: "ordered_list", content: items.map((c) => ({ type: "list_item", content: [paragraph(c)] })) });
/** A comment as Markdown, written by the editor's serializer: it escapes what text must not start, and nothing else. */
const comment = (blocks: DocNode[]) => toMarkdown({ type: "doc", content: blocks }).trimEnd();

/**
 * A run's own text on one line, as inline content: its code spans (paired as the Markdown parser pairs them, codeSpans)
 * stay code and its bare URLs links; everything else is text, which the serializer escapes, so no heading, list, quote,
 * fence, emphasis, link or mention of it reaches the comment.
 */
function inline(s: string): DocNode[] {
  const t = s.replace(/\s+/g, " ").trim();
  const out: DocNode[] = [];
  let from = 0;
  /** The text from `from` up to `to`, its bare URLs linked. */
  const plain = (to: number) => {
    const seg = t.slice(from, to);
    let at = 0;
    for (const u of urlSpans(seg)) {
      if (u.from > at) out.push(text(seg.slice(at, u.from)));
      out.push({ type: "text", text: seg.slice(u.from, u.to), marks: [{ type: "link", attrs: { href: u.href } }] });
      at = u.to;
    }
    if (at < seg.length) out.push(text(seg.slice(at)));
  };
  for (const r of codeSpans(t)) {
    const code = r.end < 0 ? "" : codeText(t.slice(r.at + r.ticks, r.end));
    if (!code) continue;
    plain(r.at);
    out.push({ type: "text", text: code, marks: [{ type: "code" }] });
    from = r.end + r.ticks;
  }
  plain(t.length);
  return out;
}

/**
 * Where a stop leaves the issue: moved to review, no review state to move to, or a move the pipeline refused (the
 * review state is for people only, say), with its words.
 */
export type StopMove = { moved: true } | { moved: false; refused?: string };

/** Why the issue stays where it is, when a move to review was not made: no review state, or the pipeline's refusal. */
/** How much of the pipeline's refusal a comment quotes: its head, which says why. */
const REFUSAL_MAX = 300;

/**
 * Why the issue stays: no review state, or the pipeline's refusal, quoted as plain text on one line (the server's words,
 * no code or links in them), so escaping at most doubles each character of it (doneCommentMax).
 */
const stays = (move: StopMove & { moved: false }) =>
  move.refused
    ? [text(`The move to review was refused (${move.refused.replace(/\s+/g, " ").trim().slice(0, REFUSAL_MAX)}), so the issue stays where it is`)]
    : [text("The project has no review state, so the issue stays where it is")];

/**
 * The comment a done run leaves on the issue, or null when it has nothing to say: each "Done when" criterion with the
 * run's evidence for it and the run's note, and a refused move to review (said even without criteria, so the issue tells
 * why it stayed). Each on its own line, as text with its inline code and bare URLs: a criterion's other Markdown (a
 * mention, a heading) is quoted, not repeated.
 */
export function doneComment(stage: string, proof: readonly { criterion: string; evidence: string }[], note: string | null, move: StopMove = { moved: true }): string | null {
  const refused = !move.moved && move.refused ? [paragraph([...stays(move), text(".")])] : [];
  if (!proof.length && !refused.length) return null;
  return comment([
    paragraph([text(proof.length ? `Completed the ${stage} stage. Done when, with evidence:` : `Completed the ${stage} stage.`)]),
    list(proof.map((p) => [...inline(p.criterion), text(" — "), ...inline(p.evidence)])),
    ...(note ? [paragraph(inline(note))] : []),
    ...refused,
  ]);
}

/**
 * The longest a done run's comment can come out, refusal included: checked before the run ends, so a comment the
 * pipeline would refuse for its length is refused with the completion instead of after it. A refusal is cut to
 * REFUSAL_MAX and escaping at most doubles a character, which a quoted run of asterisks does.
 */
export const doneCommentMax = (stage: string, proof: readonly { criterion: string; evidence: string }[], note: string | null): number =>
  doneComment(stage, proof, note, { moved: false, refused: "*".repeat(REFUSAL_MAX) })?.length ?? 0;

/** The comment a stop leaves on the issue: why, each attempt (outcome, note, the error's first line), and what resets it. */
export function stopComment(stage: string, reason: string, tried: readonly Tried[], move: StopMove): string {
  const items = tried.map((t) => {
    const firstLine = t.error?.split("\n").find((l) => l.trim());
    const parts = [[text(t.outcome)], t.note ? inline(t.note) : [], firstLine ? [text("error: "), ...inline(firstLine.trim().slice(0, 200))] : []].filter((p) => p.length);
    return parts.flatMap((p, i) => (i ? [text(" — "), ...p] : p));
  });
  const next = move.moved
    ? [text(`Agents cannot claim the ${stage} stage again until a person moves the issue out of review.`)]
    : [...stays(move), text(`; agents cannot claim the ${stage} stage again until a person changes its state.`)];
  return comment([paragraph([text(`Stopped the ${stage} loop: ${reason}.`)]), paragraph([text("Tried:")]), list(items), paragraph(next)]);
}
