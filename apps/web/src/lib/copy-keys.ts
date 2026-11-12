// The copy shortcuts of an open issue: ⌘. the key, ⌘⇧. the branch name. Shift makes the key ">" on most layouts and
// another character on some; the physical key stays the same.
export function copyKeys(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "key" | "code">): "key" | "branch" | null {
  if (!(e.metaKey || e.ctrlKey) || !(e.key === "." || e.key === ">" || e.code === "Period")) return null;
  return e.shiftKey ? "branch" : "key";
}
