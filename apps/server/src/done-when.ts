// An issue's acceptance criteria (RSVA-636): the list under "Done when" in its description, and the evidence a run's
// completion gives for each. No field of its own: people already write such a list, and as text it syncs, renders and
// versions everywhere the description does. The description is read as the API gives it, the Markdown of toMarkdown,
// so the criteria are what an agent sees in `rsva show`.
//
// The section is a `Done when` heading (any level), or a paragraph that is only `Done when` (bold or not, with or
// without a colon); case does not matter, and only the first one counts. Under a heading the first list before the next
// heading is the list; after a paragraph the list must come next. Lists right after one another are one (the editor
// splits a list of checkboxes and bullets in two). Each top-level item is a criterion: its text, a checkbox taken off;
// nested items are details of their criterion, not criteria.

/** A marker line is short: a longer one is not looked at, so no line of user text costs more than this. */
const MARKER_MAX = 80;
const EMPHASIS = /^(\*\*|__|\*|_)/;

/** Without a trailing colon, then without the emphasis around it. */
const unwrap = (s: string) => {
  const t = s.endsWith(":") ? s.slice(0, -1).trimEnd() : s;
  const em = EMPHASIS.exec(t)?.[1];
  return em && t.length > 2 * em.length && t.endsWith(em) ? t.slice(em.length, -em.length).trim() : t;
};

/**
 * Whether a line is the section's marker: heading marks, emphasis and a colon taken off in linear steps, and what is
 * left compared, case-insensitively; no pattern that could backtrack over a long line.
 */
function isMarker(line: string): boolean {
  if (line.length > MARKER_MAX) return false;
  const text = unwrap(unwrap(line.trim().replace(/^#{1,6}[ \t]+/, "")));
  return (text.endsWith(":") ? text.slice(0, -1).trimEnd() : text).toLowerCase() === "done when";
}
const HEADING = /^#{1,6}[ \t]/;
const ITEM = /^(?:[-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const BOX = /^\[[ xX]\][ \t]+/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The criteria of a description in Markdown, in order; none without a "Done when" list. */
export function doneWhen(markdown: string): string[] {
  const lines = markdown.split("\n");
  let fence = "";
  let at = -1;
  for (let i = 0; i < lines.length && at < 0; i++) {
    // A "Done when" in a code block is an example, not the section: a fence closes on its own character, as long or longer.
    const run = FENCE.exec(lines[i]!)?.[1];
    if (run && !fence) fence = run;
    else if (run && run[0] === fence[0] && run.length >= fence.length) fence = "";
    else if (!fence && isMarker(lines[i]!)) at = i;
  }
  if (at < 0) return [];
  const heading = HEADING.test(lines[at]!);
  let i = at + 1;
  // Under a heading, text may come before the list; after a paragraph, only blank lines.
  for (; i < lines.length && !ITEM.test(lines[i]!); i++) if ((heading ? HEADING : /\S/).test(lines[i]!)) return [];
  const out: string[] = [];
  let nested = false;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const item = ITEM.exec(line);
    if (item) {
      out.push(item[1]!.replace(BOX, ""));
      nested = false;
    } else if (!line.trim()) continue;
    else if (!/^[ \t]/.test(line)) break;
    else if (nested || ITEM.test(line.trim())) nested = true;
    else out[out.length - 1] += ` ${line.trim()}`;
  }
  return out.map((c) => c.trim()).filter(Boolean);
}

/** A criterion and what shows it is met, as a run keeps them. */
export interface Proof {
  criterion: string;
  evidence: string;
}

/** The longest evidence kept for one criterion: a link and a line or two. */
const EVIDENCE_MAX = 2000;

/**
 * The evidence a completion gives, one text per criterion in order, checked against the criteria: the pairs to keep, or
 * why it is refused, naming the first criterion without evidence.
 */
export function proofOf(criteria: readonly string[], given: unknown): { proof: Proof[] } | { refused: string } {
  const list = given ?? [];
  if (!Array.isArray(list) || !list.every((e) => typeof e === "string")) return { refused: "evidence: a list of text, one per criterion of Done when, in order" };
  if (list.length > criteria.length) return { refused: `evidence: ${list.length} given for ${criteria.length} criteria of Done when` };
  const proof = criteria.map((criterion, i) => ({ criterion, evidence: (list[i] ?? "").trim().slice(0, EVIDENCE_MAX) }));
  const missing = proof.findIndex((p) => !p.evidence);
  if (missing >= 0) return { refused: `no evidence for criterion ${missing + 1} of ${criteria.length}: ${criteria[missing]}` };
  return { proof };
}
