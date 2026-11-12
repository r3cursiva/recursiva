// How many cells of a terminal a text takes, for the CLI and the TUI (RSVA-461): two for East Asian wide and fullwidth
// letters and for emoji shown as pictures by default (🔥 👍); one for the rest, text-style pictographs included
// (© ▪ ❤ ⚠, with or without U+FE0F: Rex draws them in one cell, docs/research/terminal-width-2026-11-07.md); none for
// the marks that join a letter.
//
// Most text is Latin or Cyrillic, one character a cell: it is measured by its length. Only the rest goes through
// Intl.Segmenter, which costs about 150 times as much.

const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}/u;
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;
/**
 * Text whose every character is one grapheme of one cell: printable ASCII, Latin, Greek, Cyrillic and Armenian letters
 * and general punctuation, without their combining marks (U+0300–036F, U+0483–0489) and the soft hyphen (U+00AD).
 * The test checks every character of it against the Segmenter.
 */
export const NARROW = /^[\x20-\x7e -¬®-˿Ͱ-҂Ҋ-֏‐-‧‰-⁞]*$/;

// Made on first use: a Segmenter costs about 5 ms, a third of the CLI's start, and narrow text never needs one.
let segmenter: Intl.Segmenter | undefined;

/** The text's characters as a terminal draws them: graphemes, a letter with its marks and an emoji sequence each one. */
export const graphemes = (s: string): string[] =>
  NARROW.test(s) ? s.split("") : Array.from((segmenter ??= new Intl.Segmenter()).segment(s), (g) => g.segment);

/** Cells one grapheme takes. */
export function graphemeWidth(g: string): number {
  if (g.length === 1 && g >= " " && g <= "~") return 1;
  return ZERO.test(g) ? 0 : WIDE.test(g) ? 2 : 1;
}

/** Cells a text takes. */
export function widthOf(s: string): number {
  if (NARROW.test(s)) return s.length;
  let n = 0;
  for (const { segment } of (segmenter ??= new Intl.Segmenter()).segment(s)) n += graphemeWidth(segment);
  return n;
}
