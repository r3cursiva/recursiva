// J and K on a page that is not one list (RSVA-524, RSVA-572): a project's home, My work's Home. Its rows are marked in
// the markup and walked in reading order; the mark of the selected one is an attribute (`data-selected`), so a step
// redraws nothing. ↵ opens the row: the row itself when it is a link or a button, else the link inside it.
import { stepIn, stepKey } from "../lib/step-keys.ts";

/**
 * Takes a key the rows answer: a step, ↵ on the selected row, Esc that lets it go. `selected` is the caller's ref, read
 * after a false for the keys the screen adds on a row (a picker). True when the key was the rows'.
 */
export function walkRows(rows: readonly HTMLElement[], selected: { current: HTMLElement | null }, key: string): boolean {
  const row = selected.current?.isConnected ? selected.current : null;
  selected.current = row;
  const by = stepKey(key);
  if (by) {
    const next = stepIn(rows, row ? rows.indexOf(row) : -1, by);
    if (!next) return false;
    row?.removeAttribute("data-selected");
    // "true", as React writes a true data attribute: Tailwind's `data-selected:` reads [data-selected="true"], and an
    // empty value lit nothing (the project home's rows, RSVA-524, were walked unseen).
    next.setAttribute("data-selected", "true");
    next.scrollIntoView({ block: "nearest" });
    selected.current = next;
    return true;
  }
  if (!row) return false;
  if (key === "Escape") {
    row.removeAttribute("data-selected");
    selected.current = null;
    return true;
  }
  if (key !== "Enter") return false;
  const target = row.matches("a, button") ? row : row.querySelector<HTMLElement>("a");
  target?.click();
  return !!target;
}
