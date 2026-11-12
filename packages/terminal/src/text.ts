// Text from the server on its way to a terminal, for the CLI and the TUI. Everything the server sends was written by
// someone else, comments and descriptions above all. Text passes through `plain`, JSON through `escaped`: an escape
// sequence or a direction override stays data and cannot drive the terminal or make text read differently from what it
// says. Colour goes in after the data is cleaned (`clean`).

/** C0 and C1 controls, except tab and newline, line and paragraph separators, and the marks that reorder text. */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export const plain = (s: string) => s.replace(UNSAFE, "");

/** The same characters in JSON: JSON.stringify leaves all but C0 as they are, but inside strings \\uXXXX means them. */
export const escaped = (json: string) => json.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Every text in an answer through `plain`: what colour is drawn around is already safe. */
export const clean = <T>(v: T): T =>
  (typeof v === "string" ? plain(v) : Array.isArray(v) ? v.map(clean) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) : v) as T;
