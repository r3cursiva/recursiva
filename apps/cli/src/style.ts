// How the output looks. A person at a terminal gets colour, the window's width and links; anyone else (a pipe, a file,
// an agent) gets the plain text, byte for byte what it was before the colour came in: an agent pays for every byte.
//
// Colours are the terminal's own sixteen, not the app's hex values: they follow the terminal's theme the way the app's
// tokens follow its own. SGR comes from node:util's styleText (no dependency); links are OSC 8, which a terminal that
// does not know them skips.
import { styleText } from "node:util";
import { graphemes, graphemeWidth, NARROW, widthOf } from "@rsva/terminal/width";

type Paint = (s: string) => string;

export interface Style {
  /** A person reads this: colour, groups, cut lines. Off, every function below returns its text as it is. */
  readonly on: boolean;
  /** The window's width when a line can be cut to it. */
  readonly columns: number | undefined;
  readonly bold: Paint;
  readonly dim: Paint;
  readonly italic: Paint;
  readonly strike: Paint;
  readonly red: Paint;
  readonly green: Paint;
  readonly yellow: Paint;
  readonly blue: Paint;
  readonly magenta: Paint;
  readonly cyan: Paint;
  readonly gray: Paint;
  /** The text, opening the URL on a click. */
  link(url: string, text: string): string;
  /** How many cells a text takes: its width in plain text is its length, as before. */
  width(s: string): number;
}

const same: Paint = (s) => s;

export const PLAIN: Style = {
  on: false,
  columns: undefined,
  bold: same,
  dim: same,
  italic: same,
  strike: same,
  red: same,
  green: same,
  yellow: same,
  blue: same,
  magenta: same,
  cyan: same,
  gray: same,
  link: (_, text) => text,
  width: (s) => s.length,
};

const paint = (format: Parameters<typeof styleText>[0]): Paint => (s) => (s ? styleText(format, s, { validateStream: false }) : s);

/** The text in at most `max` cells, an ellipsis where it was cut. */
export function cut(s: string, max: number): string {
  if (widthOf(s) <= max) return s;
  if (max <= 0) return "";
  if (NARROW.test(s)) return `${s.slice(0, max - 1).trimEnd()}…`;
  let out = "";
  let n = 0;
  for (const g of graphemes(s)) {
    const w = graphemeWidth(g);
    if (n + w > max - 1) break;
    out += g;
    n += w;
  }
  return `${out.trimEnd()}…`;
}

/** A URL in an OSC 8 sequence: printable ASCII only, so nothing in it can end the sequence or start another. */
const safeUrl = (url: string) => (/^https?:\/\/[\x21-\x7e]+$/.test(url) ? url : null);

const PERSON: Omit<Style, "columns"> = {
  on: true,
  bold: paint("bold"),
  dim: paint("dim"),
  italic: paint("italic"),
  strike: paint("strikethrough"),
  red: paint("red"),
  green: paint("green"),
  yellow: paint("yellow"),
  blue: paint("blue"),
  magenta: paint("magenta"),
  cyan: paint("cyan"),
  gray: paint("gray"),
  link(url, text) {
    const u = safeUrl(url);
    return u && text ? `\x1b]8;;${u}\x1b\\${text}\x1b]8;;\x1b\\` : text;
  },
  width: widthOf,
};

/** What the caller knows about where the text goes: a terminal, and its size. */
export interface Terminal {
  columns?: number;
  rows?: number;
}

/**
 * Who reads the output. Strongest first: --plain, --color, NO_COLOR, an agent (CLAUDECODE: some agents run commands in a
 * pseudo-terminal, which looks like a person's), FORCE_COLOR, then whether the output is a terminal at all. TERM is no
 * sign: an agent's shell has xterm-256color too.
 */
export function styleFor(env: Record<string, string | undefined>, terminal: Terminal | undefined, flags: { plain?: boolean; color?: boolean } = {}): Style {
  const set = (v: string | undefined) => v !== undefined && v !== "" && v !== "0";
  const person = flags.plain ? false : flags.color ? true : set(env.NO_COLOR) || set(env.CLAUDECODE) || env.TERM === "dumb" ? false : set(env.FORCE_COLOR) || terminal !== undefined;
  return person ? { ...PERSON, columns: terminal?.columns || undefined } : PLAIN;
}
