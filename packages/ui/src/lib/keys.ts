// How a shortcut is written, in one place: the Mac check and the names of the modifiers. "mod" is the key the app's
// shortcuts mean by ⌘/Ctrl, "shift" and "alt" the others; any other part is a key as it is shown ("K", "⌫", "↵", ".").
// iPhone and iPad count as Mac: with a hardware keyboard they use ⌘. Phones hide the hints anyway.

/** True on Apple's platforms, the keyboard of which has ⌘ ⇧ ⌥. */
const isMac = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform);

const MODIFIERS: Record<string, readonly [mac: string, other: string]> = {
  mod: ["⌘", "Ctrl"],
  shift: ["⇧", "Shift"],
  alt: ["⌥", "Alt"],
};

/** The keys of one press, each as it is written on its cap: ["⌘", "⇧", "."] or ["Ctrl", "Shift", "."]. */
export function keyCaps(mac: boolean, parts: readonly string[]): string[] {
  return parts.map((part) => MODIFIERS[part]?.[mac ? 0 : 1] ?? part);
}

/** A press as one string for a hint: `keys("mod", "shift", ".")` is "⌘⇧." on a Mac and "Ctrl+Shift+." elsewhere. */
export function keys(...parts: string[]): string {
  return keyCaps(isMac, parts).join(isMac ? "" : "+");
}

/** A press as separate caps, for a sheet that draws one box per key. */
export function caps(...parts: string[]): string[] {
  return keyCaps(isMac, parts);
}
