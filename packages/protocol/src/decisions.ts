// Decisions (RSVA-644): the questions an agent puts to a person on an issue, and the person's answers. No table of their
// own: a question is the agent's comment in a fixed Markdown shape, which reads as it is in the issue's feed, an email
// and Telegram, and the answer is the person's reply to it, in a shape the agent reads back. Comments already sync,
// notify, keep their author and their thread; a second store of questions would have to be kept in step with them.
//
// The shape, one block per comment (lines in any order after the first; other lines are prose and are left alone):
//
//   **Question:** How long should backups be kept on the new box?
//
//   1. 30 daily, 12 monthly — about 1.1 TB of the 4 TB
//   2. 7 daily, 4 weekly, as now — 0.3 TB
//
//   Recommended: 1. OBASE-80 needs 30 days of audit history, and there is room.
//
//   Evidence:
//   - `backup/retention.yml:12`
//   - OBASE-80
//   - #412
//
// `**Close proposal:**` asks whether to close the issue and `**Hand-off:**` whether to hand it to an agent; `Group: …`
// puts close proposals with the same group and the same options on one card. Two to four options, one recommended.
// A comment that does not fit is an ordinary comment: nothing is guessed.
//
// A subpath of its own (`@rsva/protocol/decisions`): the screen that reads it is lazy, and the index is in the startup chunk.

export const DECISION_KINDS = ["question", "close", "hand"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** The first line's mark of each kind. */
export const ASK_MARKERS: Readonly<Record<DecisionKind, string>> = { question: "**Question:**", close: "**Close proposal:**", hand: "**Hand-off:**" };
const ANSWER_MARKER = "**Answer:**";

export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 4;
/** The longest question, option and group kept: a card is read at a glance. */
const TEXT_MAX = 500;

export interface DecisionOption {
  label: string;
  /** What choosing it means, after " — " on its line; empty when none. */
  detail: string;
}

/** An agent's question, read from its comment. */
export interface Ask {
  kind: DecisionKind;
  question: string;
  options: DecisionOption[];
  /** 0-based. */
  recommended: number;
  /** Why the recommendation; empty when the agent gave none. */
  why: string;
  /** One line each, as written: a path in backticks, an issue's key, a pull request's #number, or a fact. */
  evidence: string[];
  group: string | null;
}

const OPTION = /^([1-9])[.)][ \t]+(.+)$/;
const RECOMMENDED = /^recommended:[ \t]*([1-9])[.):]?[ \t]*(.*)$/i;
const ITEM = /^[-*+][ \t]+(.+)$/;
const GROUP = /^group:[ \t]*(.+)$/i;
const cut = (s: string) => s.trim().slice(0, TEXT_MAX);

/** The kind a comment's first line marks, or null: a cheap test before parsing, and the server's filter. */
export function askKind(md: string): DecisionKind | null {
  const head = md.trimStart();
  return DECISION_KINDS.find((k) => head.startsWith(ASK_MARKERS[k])) ?? null;
}

/** An agent's question from its comment's Markdown, or null when the comment is not one. */
export function parseAsk(md: string): Ask | null {
  const kind = askKind(md);
  if (!kind) return null;
  const lines = md.trim().split("\n").map((l) => l.trim());
  const question = cut(lines[0]!.slice(ASK_MARKERS[kind].length));
  if (!question) return null;
  const options: DecisionOption[] = [];
  const evidence: string[] = [];
  let recommended = -1;
  let why = "";
  let group: string | null = null;
  let inEvidence = false;
  for (const line of lines.slice(1)) {
    if (inEvidence) {
      const item = ITEM.exec(line);
      if (item) {
        evidence.push(cut(item[1]!));
        continue;
      }
      inEvidence = false;
    }
    const option = OPTION.exec(line);
    if (option) {
      // Numbered from 1 in order: a list that skips is not a set of options.
      if (Number(option[1]) !== options.length + 1) return null;
      const [label, ...rest] = option[2]!.split(" — ");
      options.push({ label: cut(label!), detail: cut(rest.join(" — ")) });
      continue;
    }
    const rec = RECOMMENDED.exec(line);
    if (rec) {
      recommended = Number(rec[1]) - 1;
      why = cut(rec[2]!);
      continue;
    }
    if (/^evidence:$/i.test(line)) {
      inEvidence = true;
      continue;
    }
    const g = GROUP.exec(line);
    if (g) group = cut(g[1]!);
  }
  if (options.length < OPTIONS_MIN || options.length > OPTIONS_MAX || recommended < 0 || recommended >= options.length) return null;
  if (options.some((o) => !o.label)) return null;
  return { kind, question, options, recommended, why, evidence, group };
}

/** The comment an agent posts for a question: what parseAsk reads back. */
export function formatAsk(a: Ask): string {
  const out = [`${ASK_MARKERS[a.kind]} ${a.question}`, "", ...a.options.map((o, i) => `${i + 1}. ${o.label}${o.detail ? ` — ${o.detail}` : ""}`), "", `Recommended: ${a.recommended + 1}.${a.why ? ` ${a.why}` : ""}`];
  if (a.evidence.length) out.push("", "Evidence:", ...a.evidence.map((e) => `- ${e}`));
  if (a.group) out.push("", `Group: ${a.group}`);
  return out.join("\n");
}

/** A person's answer: one of the options, or their own words. */
export type Answer = { option: number; label: string } | { text: string };

/** The reply that answers a question: "**Answer:** 2. The server wins", or the person's own words after the mark. */
export const formatAnswer = (a: Answer): string => `${ANSWER_MARKER} ${"text" in a ? a.text.trim() : `${a.option + 1}. ${a.label}`}`;

/** An answer read back, as an agent reads it: the option (0-based) when one was chosen, else null with the text. */
export function parseAnswer(md: string): { option: number | null; text: string } | null {
  const head = md.trim();
  if (!head.startsWith(ANSWER_MARKER)) return null;
  const text = head.slice(ANSWER_MARKER.length).trim();
  const n = /^([1-9])\.[ \t]+/.exec(text);
  return n ? { option: Number(n[1]) - 1, text: text.slice(n[0].length) } : { option: null, text };
}

/**
 * A saved rule (RSVA-644): how the person answered a question and wants it answered again. Kept by the server per
 * workspace (decision_rule); `project` is the project's key, `question` and `answer` as the card showed them.
 */
export interface DecisionRule {
  id: string;
  project: string;
  question: string;
  answer: string;
  createdAt: string;
}

/** A rule as one sentence: what Rules and the summary show. */
export const ruleText = (r: Pick<DecisionRule, "project" | "question" | "answer">): string => `In ${r.project}, when asked “${r.question}”, answer “${r.answer}”.`;

/** One open question as the server lists it for the person it waits on. */
export interface OpenDecision extends Ask {
  /** The question's comment: the answer is a reply to it. */
  commentId: string;
  issueId: string;
  key: string;
  /** Who asked (a user id) and when. */
  by: string;
  at: string;
  /** A hand-off's "Done when" criteria, from the issue's description; empty for other kinds and without a list. */
  doneWhen: string[];
}
