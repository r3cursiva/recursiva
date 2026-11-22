// The Decisions screen's rules (RSVA-644), apart from the screen so they are tested without a browser: the queue's
// cards and their order, the keys, and the sitting, which holds each answer for an undo window before it is posted.
//
// Compared for the undo: post at once and delete the comment on Undo (the agent may read the answer in between, and a
// tombstone stays in the thread), or hold the answer for the window and post it after (nothing reaches the agent that
// was taken back). Held: an answer is a message to someone who acts on it. Leaving the page posts what is held.
import { ruleText, type Answer, type DecisionKind, type DecisionOption, type OpenDecision } from "@rsva/protocol/decisions";
import { parseIssueKey } from "@rsva/schema/models";
import { makeAutoObservable, observableShallow } from "mobx";

/** How long an answer can be taken back (the artboard's Undo, owner's issue RSVA-644). */
export const UNDO_MS = 8000;

/** One card of the queue: one question, or close proposals with the same group and options answered together. */
export interface Card {
  /** The question's comment, or "g:" and the group's key. */
  id: string;
  kind: DecisionKind;
  question: string;
  options: DecisionOption[];
  recommended: number;
  why: string;
  /** The questions it answers, one unless it is a group; oldest first. */
  members: OpenDecision[];
  /** The group's name; null for a single question. */
  group: string | null;
  /** Open issues that wait on its issues (blocked by them), in all and for each member. */
  unblocks: number;
  each: number[];
  /** When the oldest of its questions was asked. */
  at: string;
}

export type Order = "unblocks" | "oldest";

const groupKey = (d: OpenDecision) => `${d.group}\n${d.options.map((o) => o.label).join("\n")}`;

/**
 * The queue: close proposals that name the same group with the same options make one card, everything else a card of
 * its own; the cards that unblock most first (ties: the oldest), or the oldest first. `skipped` go last, in the order
 * they were skipped.
 */
export function buildQueue(open: readonly OpenDecision[], unblocksOf: (issueId: string) => number, order: Order, skipped: readonly string[] = []): Card[] {
  const groups = new Map<string, OpenDecision[]>();
  for (const d of open) if (d.kind === "close" && d.group) groups.set(groupKey(d), [...(groups.get(groupKey(d)) ?? []), d]);
  const cards: Card[] = [];
  const grouped = new Set<string>();
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const first = members[0]!;
    for (const m of members) grouped.add(m.commentId);
    const sorted = [...members].sort((a, b) => a.at.localeCompare(b.at));
    cards.push({
      id: `g:${key}`,
      kind: "close",
      question: `${first.group}: close ${members.length} issues?`,
      options: first.options,
      recommended: first.recommended,
      why: first.why,
      members: sorted,
      group: first.group,
      unblocks: sorted.reduce((n, m) => n + unblocksOf(m.issueId), 0),
      each: sorted.map((m) => unblocksOf(m.issueId)),
      at: sorted[0]!.at,
    });
  }
  for (const d of open) {
    if (grouped.has(d.commentId)) continue;
    cards.push({ id: d.commentId, kind: d.kind, question: d.question, options: d.options, recommended: d.recommended, why: d.why, members: [d], group: null, unblocks: unblocksOf(d.issueId), each: [unblocksOf(d.issueId)], at: d.at });
  }
  cards.sort((a, b) => (order === "unblocks" ? b.unblocks - a.unblocks : 0) || a.at.localeCompare(b.at));
  const later = skipped.filter((id) => cards.some((c) => c.id === id));
  return [...cards.filter((c) => !later.includes(c.id)), ...later.map((id) => cards.find((c) => c.id === id)!)];
}

/** How many open issues wait on each issue: one pass over the issues, as a lookup. */
export function unblockCounts<T extends { id: string; blockedByIds: readonly string[] }>(issues: Iterable<T>, open: (issue: T) => boolean): (issueId: string) => number {
  const n = new Map<string, number>();
  for (const i of issues) if (open(i)) for (const b of i.blockedByIds) n.set(b, (n.get(b) ?? 0) + 1);
  return (id) => n.get(id) ?? 0;
}

/** What a key does on the screen; null leaves it to the app. */
export type Command =
  | { t: "answer"; option: number }
  | { t: "skip" }
  | { t: "open" }
  | { t: "undo" }
  | { t: "own" }
  | { t: "rule" }
  | { t: "move"; by: 1 | -1 }
  | { t: "check" };

/** The screen's keys (the artboard's key line): digits answer, ↵ the recommendation, S O R A Z, J K move, X checks in a group. */
export function commandOf(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, card: Card | null): Command | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === "z") return { t: "undo" };
  if (!card) return null;
  if (/^[1-9]$/.test(k)) return Number(k) <= card.options.length ? { t: "answer", option: Number(k) - 1 } : null;
  if (k === "Enter" && !e.shiftKey) return { t: "answer", option: card.recommended };
  if (k === "s") return { t: "skip" };
  if (k === "o") return card.members.length === 1 ? { t: "open" } : null;
  if (k === "r") return { t: "own" };
  if (k === "a") return { t: "rule" };
  if (k === "j" || k === "k") return { t: "move", by: k === "j" ? 1 : -1 };
  if (k === "x") return card.members.length > 1 ? { t: "check" } : null;
  return null;
}

/** An answer of the sitting. */
export interface Entry {
  card: Card;
  /** The questions it answers: a group's checked ones. */
  members: OpenDecision[];
  answer: Answer;
  /** "Answer the same way next time". */
  rule: boolean;
  at: number;
}

/** What posting an entry does: a reply to each question, and the rule. The screen's is the store's comments and the API. */
export type Post = (e: Entry) => void;

/** The answer's words: the option's label, or the person's own in quotes. */
export const answerText = (a: Answer): string => ("text" in a ? `“${a.text}”` : a.label);

/** The rule an entry saves, as one sentence; null when it saves none. */
export function entryRule(e: Pick<Entry, "card" | "answer" | "rule">): { project: string; question: string; answer: string } | null {
  if (!e.rule || "text" in e.answer || e.card.members.length !== 1) return null;
  const m = e.card.members[0]!;
  return { project: m.key.split("-")[0]!, question: m.question, answer: e.answer.label };
}

/** The sitting's summary: computed from what was answered, nothing estimated. */
export interface Summary {
  decisions: number;
  /** Open issues that waited on the answered ones. */
  unblocked: number;
  /** Distinct agents that asked them. */
  askers: number;
  /** From the first answer to the last, in whole minutes; 0 with fewer than two. */
  minutes: number;
  rules: string[];
}

/** Time for the sitting: the browser's, or a test's. */
type Clock = { now(): number; set(f: () => void, ms: number): ReturnType<typeof setTimeout>; clear(t: ReturnType<typeof setTimeout>): void };

/**
 * This tab's sitting: the answers given, each held for UNDO_MS and then posted, the last one still held taken back by
 * `undo`. The ids of what was answered leave the queue at once, before the server lists them answered.
 */
export class Sitting {
  /** In the order given; shallow: an entry is kept as it was made, so it is its own key below. */
  entries: Entry[] = [];
  /** The entries posted: past undoing. */
  private sent = new Set<Entry>();
  private timers = new Map<Entry, ReturnType<typeof setTimeout>>();
  private post: Post;
  private clock: Clock;

  constructor(post: Post, clock: Clock = { now: Date.now, set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) }) {
    this.post = post;
    this.clock = clock;
    makeAutoObservable<Sitting, "sent" | "timers" | "post" | "clock">(this, { entries: observableShallow, sent: observableShallow, timers: false, post: false, clock: false });
  }

  answer(card: Card, answer: Answer, rule: boolean, members: OpenDecision[] = card.members): Entry {
    const e: Entry = { card, members, answer, rule: rule && !!entryRule({ card, answer, rule }), at: this.clock.now() };
    this.entries.push(e);
    this.timers.set(
      e,
      this.clock.set(() => this.send(e), UNDO_MS),
    );
    return e;
  }

  /** The last answer still held, taken back; null when every answer is posted. */
  undo(): Entry | null {
    const e = this.entries.findLast((x) => !this.sent.has(x));
    if (!e) return null;
    this.clock.clear(this.timers.get(e)!);
    this.timers.delete(e);
    this.entries.splice(this.entries.indexOf(e), 1);
    return e;
  }

  get canUndo(): boolean {
    return this.entries.some((x) => !this.sent.has(x));
  }

  /** Posts what is held now: the page is going. */
  flush(): void {
    for (const e of this.entries) this.send(e);
  }

  /** The questions answered this sitting, held or posted. */
  get answered(): Set<string> {
    return new Set(this.entries.flatMap((e) => e.members.map((m) => m.commentId)));
  }

  get summary(): Summary {
    const members = this.entries.flatMap((e) => e.members);
    const times = this.entries.map((e) => e.at);
    return {
      decisions: members.length,
      unblocked: this.entries.reduce((n, e) => n + e.card.members.reduce((k, m, i) => k + (e.members.includes(m) ? e.card.each[i]! : 0), 0), 0),
      askers: new Set(members.map((m) => m.by)).size,
      minutes: times.length > 1 ? Math.round((Math.max(...times) - Math.min(...times)) / 60_000) : 0,
      rules: this.entries.flatMap((e) => {
        const r = entryRule(e);
        return r ? [ruleText(r)] : [];
      }),
    };
  }

  private send(e: Entry): void {
    if (this.sent.has(e)) return;
    this.clock.clear(this.timers.get(e)!);
    this.timers.delete(e);
    this.sent.add(e);
    this.post(e);
  }
}

/** An evidence line as the card draws it: a path, an issue, a pull request, or a fact. */
export type Evidence = { t: "code"; text: string } | { t: "issue"; key: string } | { t: "pr"; text: string } | { t: "fact"; text: string };

export function evidenceOf(line: string): Evidence {
  const code = /^`([^`]+)`$/.exec(line);
  if (code) return { t: "code", text: code[1]! };
  if (parseIssueKey(line)) return { t: "issue", key: line };
  if (/^#\d+\b/.test(line)) return { t: "pr", text: line };
  return { t: "fact", text: line };
}
