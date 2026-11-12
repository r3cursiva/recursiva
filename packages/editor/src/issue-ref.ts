// Issue references in text (PLNR-43): "PLNR-27" stays plain text in the document and in Markdown, and becomes a link
// where it is shown, when the workspace has that issue. Nothing is stored for it: an agent writes the key as it is, old
// descriptions and Plane's imported text link without a migration, and a key that names no issue stays text.
// The choice against a node like `mention`: docs/research/issue-refs-2026-10-30.md.
import { ISSUE_KEY } from "@rsva/schema/models";

/**
 * A key (ISSUE_KEY) standing on its own: not inside a word, a path, a file name or a longer dashed name ("a/PLNR-1",
 * "x.PLNR-1", "PLNR-1-2"). The one rule for keys in text: the editor, the reader and the TUI draw what it finds.
 */
const ISSUE_REF = new RegExp(`(?<![\\p{L}\\p{N}_\\-/.#@])${ISSUE_KEY}(?![\\p{L}\\p{N}_]|-[\\p{L}\\p{N}])`, "gu");

/** The address of the issue a key names, or undefined when the workspace has no such issue. */
export type IssueHref = (key: string) => string | undefined;

/** A key in a run of text, at its offsets. */
interface KeyAt {
  from: number;
  to: number;
  key: string;
}

export interface IssueRef extends KeyAt {
  href: string;
}

/** The keys in a run of text, whether or not they name an issue. */
export function issueKeys(text: string): KeyAt[] {
  // A cheap test first: most text has no capital letter followed by a dash and a digit.
  if (!/[A-Z0-9]-[1-9]/.test(text)) return [];
  return [...text.matchAll(ISSUE_REF)].map((m) => ({ from: m.index, to: m.index + m[0].length, key: m[0] }));
}

/** The references in a run of text that name an issue. */
export function issueRefs(text: string, href: IssueHref): IssueRef[] {
  return issueKeys(text).flatMap((k) => {
    const h = href(k.key);
    return h ? [{ ...k, href: h }] : [];
  });
}
