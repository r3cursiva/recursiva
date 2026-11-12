// Storage can be unavailable (private windows, blocked site data) or hold something an older build wrote: every access
// is guarded, and callers treat null as "nothing saved". Local storage is the device's; session storage is this tab's,
// and it outlives a reload of it.
type Area = () => Storage;
const local: Area = () => localStorage;
const session: Area = () => sessionStorage;

function read(storage: Area, key: string): unknown {
  try {
    const s = storage().getItem(key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function remove(storage: Area, key: string): void {
  try {
    storage().removeItem(key);
  } catch {
    // Storage blocked: nothing was saved there either.
  }
}

function write(storage: Area, key: string, value: unknown): void {
  try {
    storage().setItem(key, JSON.stringify(value));
  } catch {
    // Not saved; the app still works for this session.
  }
}

export const readLocal = (key: string): unknown => read(local, key);
export const removeLocal = (key: string): void => remove(local, key);
export const writeLocal = (key: string, value: unknown): void => write(local, key, value);
export const readSession = (key: string): unknown => read(session, key);
export const removeSession = (key: string): void => remove(session, key);
export const writeSession = (key: string, value: unknown): void => write(session, key, value);
