import type { DocNode } from "@rsva/editor/doc";
import { docText } from "@rsva/editor/text";
import type { LostWork } from "@rsva/sync";

/** Refused changes' words, to copy out of the refusal, plain: each with its title. */
export function lostText(lost: readonly LostWork[]): string {
  return lost.map((l) => [l.text, l.doc ? docText(l.doc as DocNode) : null].filter(Boolean).join("\n")).join("\n\n");
}
