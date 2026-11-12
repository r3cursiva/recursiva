// Keys from the terminal by name. Frames go out through grid.ts.
//
// A terminal sends Enter and Shift+Enter as the same byte unless the program asks for more. The TUI asks for the kitty
// keyboard protocol's first level (disambiguate, `CSI > 1 u`; Ghostty, and so Rex, speak it): Shift+Enter, Esc and
// Ctrl with a letter then come as `CSI code ; modifiers u`. A terminal without it ignores the request and sends the
// old bytes, which are named here as well; there Alt+Enter is the new line.
//
// It asks for bracketed paste as well (`CSI ? 2004 h`): a paste comes between `CSI 200 ~` and `CSI 201 ~`, and goes
// into a field as text. Without it a pasted paragraph would be keys, and its blank line two Enters: a launch.
//
// And for the mouse (PLNR-383): button presses and the wheel (`CSI ? 1000 h`) with their cell in decimal (SGR,
// `CSI ? 1006 h`): `CSI < button ; column ; row M`, `m` on release. A left press is `click:x:y` (from 0); the screen
// it lands on says which keys it stands for (Grid.zone). The wheel is ↑ and ↓. While the TUI has the mouse the
// terminal's own selection takes Shift.
import { plain } from "@rsva/terminal/text";

const ESC = "\x1b";
const PASTE = `${ESC}[200~`;
const PASTED = `${ESC}[201~`;

/** Turns the protocol, bracketed paste and the mouse on, for the screen's life; KEYS_OFF puts the terminal back as it was. */
const KEYS_ON = `${ESC}[>1u${ESC}[?2004h${ESC}[?1000h${ESC}[?1006h`;
const KEYS_OFF = `${ESC}[?1006l${ESC}[?1000l${ESC}[<u${ESC}[?2004l`;

/** The TUI's own screen: the alternate one, cleared, the cursor hidden, the keys on; SCREEN_OFF gives the terminal back. */
const SCREEN_ON = `${ESC}[?1049h${ESC}[?25l${ESC}[2J${KEYS_ON}`;
const SCREEN_OFF = `${KEYS_OFF}${ESC}[?25h${ESC}[?1049l`;

// Rex's Program Status Protocol (OSC 7501, `Pst` in its terminfo; PLNR-452): the body is `key=value` pairs joined by
// `:`, as Claude Code sends it (`state=working:app=claude-code`). While its screen is up the TUI is an idle program
// named recursiva; leaving the screen (the end, the editor, the pager) clears the record. Rex keeps it
// (com.superlogical.terminal.program_status, checked 2026-11-07). Only in Rex: no other terminal reads it.
const STATUS_ON = `${ESC}]7501;state=idle:app=recursiva${ESC}\\`;
const STATUS_OFF = `${ESC}]7501;state=clear${ESC}\\`;

/** What takes the screen and what gives it back in this terminal: in Rex, saying the program is recursiva. */
export function screenOf(env: Record<string, string | undefined>): { on: string; off: string } {
  const rex = env.TERM_PROGRAM === "rex";
  return { on: SCREEN_ON + (rex ? STATUS_ON : ""), off: (rex ? STATUS_OFF : "") + SCREEN_OFF };
}

const LEGACY: Record<string, string> = {
  [`${ESC}[A`]: "up",
  [`${ESC}[B`]: "down",
  [`${ESC}OA`]: "up",
  [`${ESC}OB`]: "down",
  [`${ESC}[C`]: "right",
  [`${ESC}[D`]: "left",
  [`${ESC}OC`]: "right",
  [`${ESC}OD`]: "left",
  // Delete (fn+⌫ on a Mac).
  [`${ESC}[3~`]: "delete",
  [`${ESC}[5~`]: "pageup",
  [`${ESC}[6~`]: "pagedown",
  // Home and End (fn+← and fn+→ on a Mac) in every form terminals send them.
  [`${ESC}[H`]: "home",
  [`${ESC}[F`]: "end",
  [`${ESC}OH`]: "home",
  [`${ESC}OF`]: "end",
  [`${ESC}[1~`]: "home",
  [`${ESC}[4~`]: "end",
  [`${ESC}[7~`]: "home",
  [`${ESC}[8~`]: "end",
  "\r": "enter",
  // Alt+Enter: Esc then Enter, in any terminal.
  [`${ESC}\r`]: "alt-enter",
  // Ctrl+J, a line feed: what most terminals send for Ctrl+Enter without the protocol.
  "\n": "ctrl-enter",
  "\x05": "ctrl-e",
  "\x0b": "ctrl-k",
  [ESC]: "esc",
  "\x7f": "backspace",
  "\b": "backspace",
  "\x03": "ctrl-c",
  "\t": "tab",
  [`${ESC}[Z`]: "shift-tab",
  "\x15": "ctrl-u",
  // Option with ← → and ⌫ where Option is Meta: Esc then b, f, DEL.
  [`${ESC}b`]: "alt-left",
  [`${ESC}f`]: "alt-right",
  [`${ESC}\x7f`]: "alt-backspace",
};

/** The keys an arrow, Home or End with modifiers end in: `CSI 1 ; modifiers D`. */
const MOVED: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };

/** A modified key's name: the protocol's modifiers are 1 + a bit set, shift 1, alt 2, ctrl 4, super (⌘) 8; one prefix, the strongest. */
const modified = (mods: number, name: string) => `${mods & 8 ? "super-" : mods & 4 ? "ctrl-" : mods & 2 ? "alt-" : mods & 1 ? "shift-" : ""}${name}`;

/** Keys the protocol sends as `CSI code u` by their code. */
const CODES: Record<number, string> = { 13: "enter", 27: "esc", 9: "tab", 127: "backspace" };

/** A mouse event in SGR: the button with its modifiers and motion as bits, the cell from 1, M pressed or m released. */
const MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * Keys by name: arrows, pageup, pagedown, home, end, enter, shift-enter, alt-enter, ctrl-enter, esc, tab, backspace, and ctrl with a letter
 * (ctrl-c, ctrl-e, ctrl-k, ctrl-u); a left click as `click:x:y`, the wheel as up and down; anything else is the text
 * typed. The mouse's other events (a release, another button, the old encoding) are "", no key.
 */
export function keyOf(data: string): string {
  const mouse = MOUSE.exec(data);
  if (mouse) {
    const button = Number(mouse[1]);
    // The wheel: 64 up, 65 down. Bit 32 is motion, which is not asked for; bits 4, 8, 16 are Shift, Alt, Ctrl.
    if ((button & 0b1100011) === 64) return "up";
    if ((button & 0b1100011) === 65) return "down";
    return mouse[4] === "M" && (button & 0b1100011) === 0 ? `click:${Number(mouse[2]) - 1}:${Number(mouse[3]) - 1}` : "";
  }
  // A terminal without SGR sends its three bytes raw after CSI M: they are not typed.
  if (data.startsWith(`${ESC}[M`)) return "";
  const csi = /^\x1b\[(\d+)(?:;(\d+))?u$/.exec(data);
  if (csi) {
    const code = Number(csi[1]);
    const mods = Number(csi[2] ?? 1) - 1;
    const name = CODES[code] ?? (code >= 97 && code <= 122 ? String.fromCharCode(code) : null);
    if (!name) return data;
    // Shift with a letter is the capital; with ⌘ or Ctrl the letter is a key, never typed.
    return mods === 1 && name.length === 1 ? name.toUpperCase() : modified(mods, name);
  }
  const moved = /^\x1b\[1;(\d+)([A-DHF])$/.exec(data);
  if (moved) return modified(Number(moved[1]) - 1, MOVED[moved[2]!]!);
  return LEGACY[data] ?? data;
}

/** One key's bytes: an escape sequence (the old mouse's CSI M and three bytes, CSI, SS3, Esc with a byte), or one character. */
const ONE = /\x1b(?:\[M[\s\S]{3}|\[[0-?]*[ -/]*[@-~]|O.|[^\x1b])?|[\s\S]/uy;

/**
 * Reads from the terminal as their keys, by name. A held arrow or a fast typist puts several in one read: each is a
 * key of its own, so none is lost and none is typed as the escape bytes of another. A paste is one key, its text after
 * the paste's opening bytes, however many reads it takes.
 */
export function keyReader(): (data: string) => string[] {
  let paste: string | null = null;
  return (data) => {
    const out: string[] = [];
    for (let rest = data; rest; ) {
      if (paste !== null) {
        // The closing bytes may come split across two reads: they are looked for in all the paste so far.
        const all: string = paste + rest;
        const end = all.indexOf(PASTED);
        if (end < 0) {
          paste = all;
          break;
        }
        out.push(PASTE + all.slice(0, end));
        paste = null;
        rest = all.slice(end + PASTED.length);
        continue;
      }
      const start = rest.indexOf(PASTE);
      const keys = start < 0 ? rest : rest.slice(0, start);
      ONE.lastIndex = 0;
      for (let m = ONE.exec(keys); m; m = ONE.exec(keys)) {
        const key = keyOf(m[0]);
        if (key) out.push(key);
      }
      if (start < 0) break;
      paste = "";
      rest = rest.slice(start + PASTE.length);
    }
    return out;
  };
}

/** Whether a key is text to type: one character, not a control. A key's name (tab, left, ctrl-k) is never text. */
export const isText = (key: string) => [...key].length === 1 && !/[\u0000-\u001f\u007f]/.test(key);

/** A field's text and its cursor: an offset into the text (UTF-16), never inside a character. */
export interface Field {
  text: string;
  at: number;
}

const isLow = (t: string, i: number) => /[\udc00-\udfff]/.test(t[i] ?? "");
/** The offset itself, or the start of the character it falls inside. */
const snap = (t: string, at: number) => (isLow(t, at) ? at - 1 : at);
const back = (t: string, at: number) => (at > 1 && isLow(t, at - 1) ? at - 2 : Math.max(0, at - 1));
const on = (t: string, at: number) => Math.min(t.length, isLow(t, at + 1) ? at + 2 : at + 1);
const space = (t: string, i: number) => /\s/.test(t[i] ?? "");
/** A word's start before the cursor, a word's end after it: past the spaces, then past the word, as Option+← → on a Mac. */
function wordBack(t: string, at: number): number {
  while (at > 0 && space(t, at - 1)) at--;
  while (at > 0 && !space(t, at - 1)) at--;
  return at;
}
function wordOn(t: string, at: number): number {
  while (at < t.length && space(t, at)) at++;
  while (at < t.length && !space(t, at)) at++;
  return at;
}
const lineStart = (t: string, at: number) => (at === 0 ? 0 : t.lastIndexOf("\n", at - 1) + 1);
const lineEnd = (t: string, at: number) => (t.indexOf("\n", at) < 0 ? t.length : t.indexOf("\n", at));

/** The cursor's new place for a key that moves it; null for a key that does not. Lines are the typed ones, not the wrapped. */
function moveOf(t: string, at: number, key: string, lines: boolean): number | null {
  const start = lines ? lineStart(t, at) : 0;
  const end = lines ? lineEnd(t, at) : t.length;
  switch (key) {
    case "left":
      return back(t, at);
    case "right":
      return on(t, at);
    case "alt-left":
    case "ctrl-left":
      return wordBack(t, at);
    case "alt-right":
    case "ctrl-right":
      return wordOn(t, at);
    case "home":
    case "super-left":
      return start;
    case "end":
    case "super-right":
      return end;
    case "super-up":
      return lines ? 0 : null;
    case "super-down":
      return lines ? t.length : null;
    // ↑ and ↓ keep the column where the line above or below has it; from the first line ↑ goes to its start, from the
    // last ↓ to its end.
    case "up": {
      if (!lines) return null;
      if (start === 0) return 0;
      const above = lineStart(t, start - 1);
      return snap(t, Math.min(above + at - start, start - 1));
    }
    case "down": {
      if (!lines) return null;
      if (end === t.length) return t.length;
      return snap(t, Math.min(end + 1 + at - start, lineEnd(t, end + 1)));
    }
  }
  return null;
}

/** What a key deletes: the start and the end of it; null for a key that deletes nothing. */
function cutOf(t: string, at: number, key: string, lines: boolean): [number, number] | null {
  if (key === "backspace") return [back(t, at), at];
  if (key === "delete") return [at, on(t, at)];
  if (key === "alt-backspace" || key === "ctrl-w") return [wordBack(t, at), at];
  // ⌘⌫ and Ctrl+U: back to the line's start, as a Mac's field and readline do.
  if (key === "super-backspace" || key === "ctrl-u") return [lines ? lineStart(t, at) : 0, at];
  return null;
}

/** What a key types: a character, a paste, a new line in a field of lines; null for a key that types nothing. */
function typedOf(key: string, lines: boolean): string | null {
  if (lines && (key === "shift-enter" || key === "alt-enter")) return "\n";
  if (key.startsWith(PASTE)) {
    const pasted = key.slice(PASTE.length).replace(/\r\n?/g, "\n").replace(/\t/g, " ");
    return plain(lines ? pasted : pasted.replace(/\n/g, " "));
  }
  return isText(key) ? key : null;
}

/**
 * A text field's own keys (RSVA-465): the moves (← →, ⌥← ⌥→ by words, Home End and ⌘← ⌘→ to the line's ends; in a
 * field of `lines` ↑ ↓ and ⌘↑ ⌘↓ too), the deletes (⌫, Delete, ⌥⌫ a word, ⌘⌫ and Ctrl+U to the line's start) and
 * what is typed, at the cursor: a character, a paste, in a field of lines Shift+Enter (Alt+Enter) a new line. Text past
 * `max` characters is not taken. The field after the key; null when the key is not the field's. A paste keeps its lines
 * in a field of `lines`, in a one-line field they are spaces; other controls and the marks that reorder text go, as
 * they go from the server's text (`plain`).
 */
export function editField(f: Field, key: string, lines = false, max = Infinity): Field | null {
  const { text } = f;
  const at = Math.min(Math.max(0, f.at), text.length);
  const moved = moveOf(text, at, key, lines);
  if (moved !== null) return { text, at: moved };
  const cut = cutOf(text, at, key, lines);
  if (cut) return { text: text.slice(0, cut[0]) + text.slice(cut[1]), at: cut[0] };
  let typed = typedOf(key, lines);
  if (typed === null) return null;
  typed = typed.slice(0, Math.max(0, max - text.length));
  if (/[\ud800-\udbff]$/.test(typed)) typed = typed.slice(0, -1);
  return { text: text.slice(0, at) + typed + text.slice(at), at: at + typed.length };
}

/** A one-line field whose cursor stays at its end: the query, a new issue, the palette, a filter. The new text; null when the key changes nothing. */
export function edited(text: string, key: string, lines = false): string | null {
  const f = editField({ text, at: text.length }, key, lines);
  return f && f.text !== text ? f.text : null;
}

/** Hints that name one key, as the screens write them, by the key's name. */
const HINTS: Record<string, string> = {
  "↵": "enter",
  "⇧↵": "shift-enter",
  Esc: "esc",
  Tab: "tab",
  "⇧Tab": "shift-tab",
  "→": "right",
  "←": "left",
  "↑": "up",
  "↓": "down",
  "⌃E": "ctrl-e",
  "⌃K": "ctrl-k",
  "⌃U": "ctrl-u",
};

/**
 * The keys a hint stands for, as a click on it presses them: "↵" enter, "s" s, "g q" g then q. A hint of several keys
 * to choose from ("j/k", "↑↓", "1–5") is none: it says how to move, a click has nothing to press.
 */
export function hintKeys(hint: string): string[] {
  const keys = hint.split(" ").map((k) => HINTS[k] ?? ([...k].length === 1 ? k : null));
  return keys.every((k) => k !== null) ? (keys as string[]) : [];
}
