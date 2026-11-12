// A list being edited in place, as Customize edits a home's widgets and My work's sections: each change makes a new list,
// so the draft is one observable field and Cancel is dropping it.

type Item = { id: string };

/** `id` with `set` applied. */
export const withChange = <T extends Item>(list: readonly T[], id: string, set: Partial<Omit<T, "id">>): T[] => list.map((x) => (x.id === id ? { ...x, ...set } : x));

/** `id` put right before `next` (undefined: last); the same list when nothing moves. */
export function movedBefore<T extends Item>(list: readonly T[], id: string, next: string | undefined): readonly T[] {
  const item = list.find((x) => x.id === id);
  if (!item || id === next) return list;
  const out = list.filter((x) => x.id !== id);
  const at = next === undefined ? -1 : out.findIndex((x) => x.id === next);
  out.splice(at < 0 ? out.length : at, 0, item);
  return out;
}

/** `id` one place earlier (-1) or later (+1): the keyboard's and the phone's way to move it. */
export function steppedBy<T extends Item>(list: readonly T[], id: string, by: -1 | 1): readonly T[] {
  const at = list.findIndex((x) => x.id === id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= list.length) return list;
  const out = [...list];
  [out[at], out[to]] = [out[to]!, out[at]!];
  return out;
}

/** A short random id for a new item of a list. */
export const shortId = (): string => Math.random().toString(36).slice(2, 8);
