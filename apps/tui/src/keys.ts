// The keys of the list and the issue screen (PLNR-424): one table a screen, each entry the keys it takes, its place in
// the keys line and its line in the ? sheet, so that what a screen says and what it does cannot drift apart. The
// handler, the keys line and the sheet are all read from it.
import type { Issue } from "@rsva/schema/models";
import type { App } from "./app.ts";
import type { HomeView } from "./home.ts";
import type { Seg } from "./widgets.ts";

type Hint = [key: string, does: string];

/** A key of a screen; `C` is what it acts on: the run (App) for the list and the issue screen, the queue's moves for the queue. */
export interface Binding<C = App> {
  /** The keys that run it, as keyReader names them; a chord is its keys with a space between, `g q`. */
  keys: readonly string[];
  /** Its place in the keys line. */
  hint?: Hint;
  /** Left out of the keys line at 80 columns, where it keeps fewer: the ? sheet has it. */
  wide?: boolean;
  /** Its line in the ? sheet. */
  help?: Hint;
  /** Whether it is there now: its keys do nothing and its hint goes when not. The ? sheet lists it anyway. */
  when?(c: C): boolean;
  /** None for a line of the sheet only: keys taken before the screen's (q, ⌃K), the mouse. */
  run?(c: C, key: string): void;
}

/** A chord begun: the keys so far, "" when none is. */
export interface Held {
  chord: string;
}

const on = <C>(b: Binding<C>, c: C) => !b.when || b.when(c);

/**
 * Runs the entry `key` belongs to; whether one took it. A key that begins a chord waits for the next; the key after a
 * chord's first is taken whatever it is, so a chord that ends in nothing does nothing.
 */
export function press<C>(table: readonly Binding<C>[], c: C, key: string, held: Held): boolean {
  const k = held.chord ? `${held.chord} ${key}` : key;
  const chord = !!held.chord;
  held.chord = "";
  const live = table.filter((b) => b.run && on(b, c));
  const b = live.find((x) => x.keys.includes(k));
  if (b) {
    b.run!(c, k);
    return true;
  }
  if (live.some((x) => x.keys.some((y) => y.startsWith(`${k} `)))) {
    held.chord = k;
    return true;
  }
  return chord;
}

/** The keys line: at 80 columns without the wide ones; with `c`, only those there now. */
export const hintsOf = <C>(table: readonly Binding<C>[], narrow = false, c?: C): HomeView["keys"] =>
  table.filter((b) => b.hint && (c === undefined || on(b, c)) && !(narrow && b.wide)).map((b) => [...b.hint!]);

/** The ? sheet: every key of the screen. */
export const helpOf = <C>(table: readonly Binding<C>[]): HomeView["keys"] => table.flatMap((b) => (b.help ? [[...b.help] as Hint] : []));

/**
 * A list's cursor (the palette's, a picker's, the query's completions): `at:N` (a click on row N), ↑ and ↓, and j and k
 * where they are not letters. The new place, or null for a key that is not the cursor's.
 */
export function cursorKey(at: number, key: string, length: number, jk = false): number | null {
  const last = Math.max(0, length - 1);
  const click = /^at:(\d+)$/.exec(key);
  if (click) return Math.min(Number(click[1]), last);
  if (key === "down" || (jk && key === "j")) return Math.min(at + 1, last);
  if (key === "up" || (jk && key === "k")) return Math.max(at - 1, 0);
  return null;
}

/** What a change of an issue's field says: its key quiet, then what it became. */
export const changed = (key: string, what: string): Seg[] => [
  [key, { fg: "ink-3" }],
  [` ${what}`, { fg: "ink-2" }],
];

// ── An issue's keys: on the list and on its screen ────────────────────────────────────────────────────────────────

/** An issue's key acts on the issue screen's issue, else the cursor's; on an empty list it does nothing, its hint stays. */
const withIssue = (run: (app: App, issue: Issue) => void): Pick<Binding, "run"> => ({
  run(app) {
    const issue = app.target();
    if (issue) run(app, issue);
  },
});

// The web's keys for an issue where a terminal sends them: S P A L (PLNR-439); ⌘ it cannot send, so ⌘. is Y.
const STATE: Binding = { keys: ["s"], hint: ["s", "state"], help: ["s", "change the state"], ...withIssue((app, i) => app.pickState(i)) };
const PRIORITY: Binding = { keys: ["p"], hint: ["p", "priority"], wide: true, help: ["p", "change the priority"], ...withIssue((app, i) => app.page(i, "priority")) };
const ASSIGN: Binding = { keys: ["a"], hint: ["a", "assign"], wide: true, help: ["a", "change the assignees"], ...withIssue((app, i) => app.page(i, "assignees")) };
const LABELS: Binding = { keys: ["l"], help: ["l", "change the labels"], ...withIssue((app, i) => app.page(i, "labels")) };
/** Everything that acts on the issue, each with its key; the rare ones (cycle, dates, parent, relations, archive) only here. */
/** The same key without its place in the keys line: on the list the line keeps the artboard's; the sheet and the menu have them. */
const quiet = ({ hint: _, wide: __, ...b }: Binding): Binding => b;
const MENU: Binding = { keys: ["."], hint: [".", "more"], help: [".", "the issue's menu: all it can do"], ...withIssue((app, i) => app.page(i, "actions")) };
const DISPATCH: Binding = { keys: ["d"], hint: ["d", "dispatch"], help: ["d", "dispatch to an agent"], ...withIssue((app, i) => app.dispatch(i)) };
const BROWSER: Binding = { keys: ["o"], help: ["o", "open in the browser"], ...withIssue((app, i) => app.browse(i)) };
const EDIT: Binding = { keys: ["e"], help: ["e", "edit the description in $EDITOR"], ...withIssue((app, i) => app.editDescription(i)) };
const COPY: Binding = { keys: ["y"], help: ["y", "copy the link"], ...withIssue((app, i) => app.copy(i, "link")) };
const COPY_KEY: Binding = { keys: ["Y"], help: ["Y", "copy the key"], ...withIssue((app, i) => app.copy(i, "key")) };
const MOVE: Binding = { keys: ["m"], help: ["m", "move to another project"], ...withIssue((app, i) => app.page(i, "move")) };
/** A new issue, and a sub-issue of the issue the keys act on (PLNR-438). */
const NEW: Binding = { keys: ["c"], help: ["c", "a new issue: #project @person !priority +label title"], run: (app) => app.newIssue(false) };
const NEW_SUB: Binding = { keys: ["C"], help: ["C", "a sub-issue of this issue"], run: (app) => app.newIssue(true) };
/** A comment on the issue (PLNR-334): from the list, its screen opens with the reply under the activity. */
const REPLY: Binding = { keys: ["r"], hint: ["r", "reply"], help: ["r", "reply: a comment on the issue"], ...withIssue((app, i) => app.reply(i)) };
/**
 * To the trash after a yes (PLNR-451, RSVA-456), and back with u (PLNR-440). D, not ⌫: a key the hand finds by chance
 * deleted in one stroke; x stays free for the web's mark-a-row. Archive is in the menu (.): A is the web's assignees.
 */
const DELETE: Binding = { keys: ["D"], help: ["D", "move to the trash, after a yes; u brings it back"], ...withIssue((app, i) => app.remove(i)) };
const UNDO: Binding = { keys: ["u"], help: ["u", "undo the last change made here"], run: (app) => app.undo() };
/** What a click on an issue's text and properties does (RSVA-479): the list's card and the issue screen. */
const CLICK_CARD: Binding<never> = { keys: [], help: ["click", "a link, a pull request: the browser; an issue's key: it; a property: its picker"] };
/** Lines of every screen's sheet: the terminal's own selection, and q, which the run takes before any screen. */
export const DRAG: Binding<never> = { keys: [], help: ["⇧ drag", "select text: the mouse is the TUI's"] };
export const QUIT: Binding<never> = { keys: [], help: ["q  ⌃C", "quit"] };

// ── The list ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A page of rows: the list's height less one, so that a row of the last page stays in sight. */
const pageOf = (app: App) => Math.max(1, app.listRows() - 1);

export const LIST_KEYS: readonly Binding[] = [
  { keys: ["j", "down"], hint: ["j/k", "move"], help: ["j k  ↑ ↓", "move"], run: (app) => app.selectRow(app.ui.selected + 1) },
  { keys: ["k", "up"], run: (app) => app.selectRow(app.ui.selected - 1) },
  { keys: ["pagedown"], help: ["PgUp PgDn", "a page up, down (fn ↑ ↓)"], run: (app) => app.selectRow(app.ui.selected + pageOf(app)) },
  { keys: ["pageup"], run: (app) => app.selectRow(app.ui.selected - pageOf(app)) },
  { keys: ["home"], help: ["Home End", "the first, the last issue (fn ← →)"], run: (app) => app.selectRow(0) },
  { keys: ["end"], run: (app) => app.selectRow(app.items().length - 1) },
  { keys: ["enter"], hint: ["↵", "open"], help: ["↵", "open the issue"], ...withIssue((app, i) => app.read(i.id, "list")) },
  { keys: ["f"], hint: ["f", "filter"], help: ["f", "filter with a query"], run: (app) => app.openQuery() },
  NEW,
  NEW_SUB,
  STATE,
  quiet(PRIORITY),
  quiet(ASSIGN),
  LABELS,
  DISPATCH,
  MENU,
  { keys: ["g q"], hint: ["g q", "queue"], wide: true, help: ["g q", "a queue through this list"], run: (app) => app.startQueue() },
  { ...BROWSER, hint: ["o", "browser"], wide: true },
  EDIT,
  COPY,
  COPY_KEY,
  MOVE,
  quiet(REPLY),
  DELETE,
  UNDO,
  { keys: ["/"], help: ["/  ⌃K", "the palette: commands, issues, views"], run: (app) => app.openPalette() },
  { keys: ["esc"], help: ["Esc", "back to Open issues"], run: (app) => app.leaveQuery() },
  { keys: [], help: ["click", "a row: select, again: open; a hint: its key"] },
  CLICK_CARD,
  DRAG,
  { ...QUIT, hint: ["q", "quit"], wide: true },
];

// ── The issue screen ──────────────────────────────────────────────────────────────────────────────────────────────

/** Moves what scrolls; the painter keeps it within the text, so the end is any line past it. */
const scroll = (to: (top: number, page: number, heads: number[]) => number) => (app: App) => {
  const r = app.reading();
  if (r) r.top = Math.max(0, to(r.top, Math.max(1, r.page - 1), r.heads ?? []));
};
const END = Number.MAX_SAFE_INTEGER;
const fromList = (app: App) => app.reading()?.from === "list";

export const ISSUE_KEYS: readonly Binding[] = [
  // Space for a page is in the ? sheet: at 80 columns the line keeps Esc.
  { keys: ["up"], hint: ["↑↓", "scroll"], help: ["↑ ↓", "scroll a line"], run: scroll((top) => top - 1) },
  { keys: ["down"], run: scroll((top) => top + 1) },
  // → and ← as j and k: ↑ and ↓ scroll here. From the queue they stay quiet, as there they approve and skip; [ and ] as
  // the head shows them.
  { keys: ["j", "]", "right"], hint: ["j/k ←→", "next"], help: ["j k  → ←  ] [", "the next, the previous issue of the list"], when: fromList, run: (app) => app.step(1) },
  { keys: ["k", "[", "left"], when: fromList, run: (app) => app.step(-1) },
  // Tab to the next heading below the top, Shift+Tab to the one above it; past the last, the end. The keys line has the
  // issue's actions instead (PLNR-439); the ? sheet has Tab.
  { keys: ["tab"], help: ["Tab  ⇧Tab", "the next, the previous heading: sub-issues, activity"], run: scroll((top, _, heads) => heads.find((l) => l > top) ?? END) },
  { keys: ["shift-tab"], run: scroll((top, _, heads) => [...heads].reverse().find((l) => l < top) ?? 0) },
  { keys: [" ", "pagedown"], help: ["Space  b", "a page down, up (PgDn, PgUp)"], run: scroll((top, page) => top + page) },
  { keys: ["b", "pageup"], run: scroll((top, page) => top - page) },
  { keys: ["G"], help: ["G", "to the end, the newest activity"], run: scroll(() => END) },
  { keys: ["home"], help: ["Home End", "to the top, to the end (fn ← →)"], run: scroll(() => 0) },
  { keys: ["end"], run: scroll(() => END) },
  { keys: ["g g"], help: ["g g", "to the top"], run: scroll(() => 0) },
  { keys: ["i"], help: ["i", "the properties, under 120 columns"], run: (app) => (app.ui.properties = !app.ui.properties) },
  STATE,
  PRIORITY,
  ASSIGN,
  LABELS,
  REPLY,
  DISPATCH,
  MENU,
  NEW,
  NEW_SUB,
  BROWSER,
  EDIT,
  COPY,
  COPY_KEY,
  MOVE,
  DELETE,
  UNDO,
  // From the queue's issue screen the queue has the keys: f there would only close the issue.
  {
    keys: ["f"],
    help: ["f", "filter the list with a query"],
    when: fromList,
    run: (app) => {
      app.stopReading();
      app.openQuery();
    },
  },
  { keys: ["/"], help: ["/  ⌃K", "the palette"], run: (app) => app.openPalette() },
  { keys: ["esc"], hint: ["Esc", "back"], help: ["Esc", "back"], run: (app) => app.stopReading() },
  CLICK_CARD,
  DRAG,
  QUIT,
];
