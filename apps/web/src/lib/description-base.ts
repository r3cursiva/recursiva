import { sameDoc, type DocNode } from "@rsva/editor/doc";
import { mergeDocs } from "@rsva/editor/merge";

/** What the open description editor does with the server's text: what to show (null: nothing to change) and its new base. */
export interface Take {
  show: DocNode | null;
  known: DocNode;
}

/**
 * The description editor and the server's text (ADR 0057). `known` is the last text the two shared: the one shown when it
 * opened, its own last save, or a text taken since. A text that is still that one changes nothing; another one (someone
 * else's save, or ours merged with theirs) is taken, merged with unsaved typing when there is some, and becomes the base
 * the next save names. Null when the two do not merge: the editor keeps its text and its older base, and the server merges
 * the next save or refuses it with the text kept. Not to be asked under a save on its way: the row then shows our text
 * with the tx of whatever the server last sent.
 */
export function takeText(known: DocNode, shown: DocNode, text: DocNode, typing: boolean): Take | null {
  if (sameDoc(text, known)) return { show: null, known };
  const merged = typing ? mergeDocs(known, shown, text) : text;
  if (!merged) return null;
  return { show: sameDoc(merged, shown) ? null : merged, known: text };
}
