/**
 * Comment drafts, keyed by issue (`issue:<id>`), reply target (`reply:<id>`) or edited comment (`edit:<id>`). They live in
 * memory until sent, and a reload for a new version hands them to the next page in the tab (new-version.ts).
 *
 * A reply's or an edit's composer opens only on a click, so after that reload its draft would show only once Reply or Edit
 * is pressed again, and the person may think the text is gone (PLNR-262). A composer whose draft came over opens again by
 * itself, once: closed after that, it stays closed, as before the reload.
 */
export function drafts(handed: unknown) {
  const texts = new Map<string, string>(Array.isArray(handed) ? handed.filter((d): d is [string, string] => Array.isArray(d) && typeof d[0] === "string" && typeof d[1] === "string") : []);
  const reopen = new Set(texts.keys());
  return {
    texts,
    /** The draft came over a reload, is not sent, and its composer has not opened since. */
    reopens: (key: string): boolean => reopen.has(key) && texts.has(key),
    /** Its composer is open: from now on it opens only when asked. */
    opened: (key: string): void => void reopen.delete(key),
  };
}
