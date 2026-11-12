// The caret menus' state that needs no DOM (caret-menu.tsx draws it): the search a trigger opens, the highlighted row and
// what a key does. A .ts file, so the tests run it without a JSX step.

/** The search one trigger opened: `at` names the trigger and its place, so the next "#" opens a new one. */
export interface Session<T> {
  at: string;
  find: T;
}

/** The search for the query at `at`: opened once per trigger (the "#" index), kept while the query lasts, dropped after. */
export function sessionFor<T>(prev: Session<T> | null, at: string | null, open: (() => T) | undefined): Session<T> | null {
  if (at === null || !open) return null;
  return prev?.at === at ? prev : { at, find: open() };
}

/** The row arrows or the mouse moved to, for one query. */
export interface Chosen {
  query: string;
  index: number;
}

/**
 * The highlighted row, -1 for none. A row chosen in this query; else the first, unless the query has a space ("#42 for
 * the details" reads like prose): then none, so Enter makes a new line instead of putting a key there.
 */
export function highlighted(chosen: Chosen, query: string, text: string, count: number): number {
  if (chosen.query === query) return Math.min(chosen.index, count - 1);
  return text.includes(" ") ? -1 : 0;
}

export type MenuAction = { move: number } | { pick: number } | "dismiss" | null;

/** What a key does in a menu of `count` rows with row `at` highlighted; null leaves the key to the editor. */
export function menuAction(key: string, at: number, count: number): MenuAction {
  if (key === "ArrowDown" || key === "ArrowUp") {
    const from = at < 0 && key === "ArrowUp" ? 0 : at;
    return { move: (from + (key === "ArrowDown" ? 1 : -1) + count) % count };
  }
  if (key === "Enter" || key === "Tab") return at < 0 ? null : { pick: at };
  if (key === "Escape") return "dismiss";
  return null;
}

/**
 * A key pressed in the editor with a menu of `count` rows: what it does to the menu, true when the menu took it. With no
 * rows, or with ⌘, Ctrl or Alt held (⌘Enter sends a comment), the key is the editor's.
 */
export function menuKey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
  at: number,
  count: number,
  does: { dismiss: () => boolean; move: (index: number) => void; pick: (index: number) => boolean },
): boolean {
  if (!count || e.metaKey || e.ctrlKey || e.altKey) return false;
  const act = menuAction(e.key, at, count);
  if (act === null) return false;
  if (act === "dismiss") return does.dismiss();
  if ("move" in act) {
    does.move(act.move);
    return true;
  }
  return does.pick(act.pick);
}
