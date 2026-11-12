import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { reloadOnce } from "./load-edit-chunk.ts";

/** The tab's session storage: a working one, or one that throws as a browser with blocked site data does. */
function sessionStorageOf(blocked: boolean): void {
  const items = new Map<string, string>();
  const storage = {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get: () => {
      if (blocked) throw new DOMException("The operation is insecure.", "SecurityError");
      return storage;
    },
  });
}

/** Reloads of a tab whose chunk keeps failing, over `loads` page loads; the session storage outlives each reload. */
function reloadsOver(loads: number): number {
  let reloads = 0;
  for (let i = 0; i < loads; i++) if (!reloadOnce(() => reloads++)) break;
  return reloads;
}

afterEach(() => sessionStorageOf(false));

test("a failed chunk reloads once, then the error reaches the boundary", () => {
  sessionStorageOf(false);
  assert.equal(reloadsOver(10), 1);
});

test("with site storage blocked a failed chunk goes to the boundary at once, not into a reload loop", () => {
  sessionStorageOf(true);
  assert.equal(reloadsOver(10), 0);
});
