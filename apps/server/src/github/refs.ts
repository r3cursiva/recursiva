// Issue keys in what GitHub sends: branch names, pull request titles and bodies, commit messages. Pure functions.
//
// A key (ISSUE_KEY) here touches no other letter or digit, and that is all: unlike in the app's text (packages/editor
// issue-ref.ts), "plnr-414-slug" in a branch and ".../browse/PLNR-414" in a body are keys. Branch names are lower case in
// practice, so they match in any case; in text only upper case counts, or "sha-256" and "utf-8" would be keys.
//
// A revert never closes: GitHub's Revert button makes a `revert-44-…` branch titled `Revert "…"`, which repeats the keys of
// the pull request it undoes.
//
// In one text a key closes when it follows a closing word ("Fixes A-1, A-2 and B-3"), only links when it follows a linking
// word ("Refs A-4"), and is bare otherwise. Linking beats closing, closing beats bare: whoever wrote "Refs A-1" means it.

import { ISSUE_KEY } from "@rsva/schema/models";

/** References taken from one pull request or commit: a pasted list does not touch a whole project. */
const REFS_MAX = 50;

const KEY = `${ISSUE_KEY}(?![A-Za-z0-9])`;
const UPPER = new RegExp(String.raw`(?<![A-Za-z0-9])${KEY}`, "g");
const ANY_CASE = new RegExp(String.raw`(?<![A-Za-z0-9])${KEY}`, "gi");
const CLOSING = "close[sd]?|closing|fix(?:e[sd])?|fixing|resolve[sd]?|resolving|complete[sd]?|completing";
const LINKING = String.raw`refs?|references|part\s+of|relate[sd]\s+to|contributes\s+to|towards`;
const SEP = String.raw`(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s+)`;
/** A word, then `:` or Markdown emphasis, then a list of keys; the words in any case, the keys in upper. */
const MAGIC = new RegExp(String.raw`(?<![A-Za-z0-9])(${LINKING}|${CLOSING})(?![A-Za-z0-9])[\s:*_]*((?-i:${KEY}(?:${SEP}${KEY})*))`, "gi");
const IS_LINKING = new RegExp(`^(?:${LINKING})$`, "i");

const IS_REVERT = /^Revert "/;
const REVERT_BRANCH = /^revert-\d+-/;

type Kind = "bare" | "closing" | "linking";
const STRENGTH: Record<Kind, number> = { bare: 0, closing: 1, linking: 2 };

/** The keys of a branch name, upper-cased, in order. */
export function branchKeys(branch: string): string[] {
  return [...new Set([...branch.matchAll(ANY_CASE)].map((m) => m[0].toUpperCase()))];
}

/** The keys of one text and what each is there. */
export function textKeys(text: string): Map<string, Kind> {
  const found = new Map<string, Kind>();
  const put = (key: string, kind: Kind) => {
    const had = found.get(key);
    if (!had || STRENGTH[kind] > STRENGTH[had]) found.set(key, kind);
  };
  for (const m of text.matchAll(MAGIC)) {
    const kind = IS_LINKING.test(m[1]!) ? "linking" : "closing";
    for (const k of m[2]!.matchAll(UPPER)) put(k[0], kind);
  }
  for (const k of text.matchAll(UPPER)) put(k[0], "bare");
  return found;
}

/** A commit's keys: true when it closes the issue; a bare key or "Refs" only links. */
export function commitKeys(message: string): Map<string, boolean> {
  const revert = IS_REVERT.test(message);
  return new Map([...textKeys(message)].slice(0, REFS_MAX).map(([k, kind]) => [k, kind === "closing" && !revert]));
}

/** Several commits as one: a key closes if any of them closes it. */
export function commitsKeys(messages: readonly string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of messages) for (const [k, closing] of commitKeys(m)) out[k] = out[k] || closing;
  return out;
}

/**
 * A pull request's keys: true when merging it closes the issue. The first rule that applies decides:
 * a linking word in the title or body links; the key in the branch or the title closes; a closing word in the body or a
 * commit closes; anything else (a bare key in the body or a commit) links.
 */
export function pullKeys(pr: { head: string; title: string; body: string; commits: Record<string, boolean> }): Map<string, boolean> {
  const branch = branchKeys(pr.head.replace(REVERT_BRANCH, ""));
  const title = textKeys(pr.title);
  const body = textKeys(pr.body);
  const revert = REVERT_BRANCH.test(pr.head) || IS_REVERT.test(pr.title);
  const out = new Map<string, boolean>();
  for (const key of new Set([...branch, ...title.keys(), ...body.keys(), ...Object.keys(pr.commits)])) {
    if (out.size === REFS_MAX) break;
    const linking = title.get(key) === "linking" || body.get(key) === "linking";
    out.set(key, !revert && !linking && (branch.includes(key) || title.has(key) || body.get(key) === "closing" || pr.commits[key] === true));
  }
  return out;
}
