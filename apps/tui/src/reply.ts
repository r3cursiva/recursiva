// A comment from the issue screen (PLNR-334, the artboard TuiIssueComments): `r` opens a reply under the activity, ↵
// sends it, ⇧↵ (⌥↵) is a new line, ⌃E opens $EDITOR, Esc leaves it with its draft kept. People are mentioned as in the
// web's editors (the same candidates, @rsva/display mention): `@` and the start of a name or an email, Tab completes it to
// `@email`; on sending, each `@email` of a person of the workspace becomes the web's mention, `[@Name](mention:<id>)`
// (packages/editor markdown.ts), so they are told as when mentioned in the web.
import type { User } from "@rsva/schema/models";
import { mentionCandidates } from "@rsva/display/mention";
import type { Field } from "./terminal.ts";

/** How many people the status line offers for the `@` being typed. */
const OFFERED = 4;

/** The `@word` at the end of the text and the people it may be; null when the text does not end in one. */
export function mentionAt(text: string, users: Iterable<User>): { start: number; people: User[] } | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(text);
  if (!m) return null;
  const people = mentionCandidates(users, m[1]!).slice(0, OFFERED);
  return people.length ? { start: text.length - m[1]!.length - 1, people } : null;
}

/** The `@word` before the cursor replaced by `@email `, the cursor after it; mentionAt found it in the text before the cursor. */
export function complete(f: Field, at: { start: number }, u: User): Field {
  const typed = `@${u.email} `;
  return { text: `${f.text.slice(0, at.start)}${typed}${f.text.slice(f.at)}`, at: at.start + typed.length };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The comment as it is sent: each `@email` of a person of the workspace a mention, the rest as typed. */
export function bodyOf(text: string, users: Iterable<User>): string {
  let out = text.trim();
  // The longest first: one address that ends another is not taken for it.
  for (const u of mentionCandidates(users, "").sort((a, b) => b.email.length - a.email.length)) {
    const label = u.name.replace(/[[\]]/g, "") || u.email;
    out = out.replace(new RegExp(`(^|\\s)@${escape(u.email)}(?![\\w.@-]*[\\w@-])`, "gi"), (_, before: string) => `${before}[@${label}](mention:${u.id})`);
  }
  return out;
}
