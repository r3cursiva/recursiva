// The color theme (ADR 0031): the mode (as the system, light or dark) and which of the eight light and eight dark
// themes each side uses. The choice is on the account (account.settings.theme), so every device looks the same; until
// the person picks one there, the device keeps the mode its sidebar button chose before.
//
// localStorage "rsva:theme" holds what index.html needs before the first paint, so it never flashes another theme:
// the choice and the panel color of each side for the browser's own bars. Sign-out keeps it (auth.ts).
import { isThemeChoice, THEME_DEFAULTS, type DarkTheme, type LightTheme, type ThemeChoice, type ThemeMode } from "@rsva/protocol";
import { autorun, makeAutoObservable } from "mobx";
import { account } from "./account.ts";
import { readLocal, writeLocal } from "./lib/local-storage.ts";

export type { ThemeMode };

const KEY = "rsva:theme";
const system = matchMedia("(prefers-color-scheme: dark)");

/** What index.html reads. Before themes it was the bare mode, "light" or "dark", which still reads. */
interface Saved extends ThemeChoice {
  bar: { light: string; dark: string };
}

function saved(): ThemeChoice {
  let v: unknown = null;
  try {
    v = localStorage.getItem(KEY);
  } catch {
    // Storage blocked: the defaults.
  }
  if (v === "light" || v === "dark") return { ...THEME_DEFAULTS, mode: v };
  v = readLocal(KEY);
  return isThemeChoice(v) ? { mode: v.mode, light: v.light, dark: v.dark } : THEME_DEFAULTS;
}

/** A theme's panel color, read from the CSS in a box of its own: the other side's is needed before it is shown. */
function panel(name: string, dark: boolean): string {
  const probe = document.createElement("div");
  probe.className = dark ? "dark" : "light";
  probe.dataset.theme = name;
  probe.hidden = true;
  document.body.append(probe);
  const color = getComputedStyle(probe).getPropertyValue("--ql-panel").trim();
  probe.remove();
  return color;
}

/** data-theme and the .dark class for the colors, color-scheme for the browser's own controls (date pickers, scrollbars). */
function paint(name: string, dark: boolean): void {
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.dataset.theme = name;
  root.style.colorScheme = dark ? "dark" : "light";
}

/** The choice on screen, and remembered for index.html. */
function apply(c: ThemeChoice, dark: boolean): void {
  paint(dark ? c.dark : c.light, dark);
  // At start the choice is the saved one: no probing, which would make the browser compute styles early.
  const was = readLocal(KEY) as Partial<Saved> | null;
  const same = was?.bar && was.mode === c.mode && was.light === c.light && was.dark === c.dark;
  const bar = same ? was.bar! : { light: panel(c.light, false), dark: panel(c.dark, true) };
  // The browser's own bars on a phone follow the app's panels.
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? bar.dark : bar.light);
  writeLocal(KEY, { ...c, bar } satisfies Saved);
}

const NEXT: Record<ThemeMode, ThemeMode> = { system: "light", light: "dark", dark: "system" };

/** A theme tried in the palette. */
export interface ThemePreview {
  name: LightTheme | DarkTheme;
  dark: boolean;
}

class Theme {
  /** This device's choice: the account's once it has one. */
  private device = saved();
  /** The system is dark now: a theme in system mode follows it. */
  systemDark = system.matches;
  /** On screen instead of the choice while it is tried: never saved, not even for index.html. */
  previewing: ThemePreview | null = null;

  constructor() {
    makeAutoObservable<Theme, "device">(this, { device: true });
    system.addEventListener("change", () => (this.systemDark = system.matches));
  }

  get choice(): ThemeChoice {
    return account.settings.theme ?? this.device;
  }

  get mode(): ThemeMode {
    return this.choice.mode;
  }

  get next(): ThemeMode {
    return NEXT[this.mode];
  }

  /** The dark side is on screen now. */
  get dark(): boolean {
    return this.mode === "system" ? this.systemDark : this.mode === "dark";
  }

  /** Shows a theme without saving it, on its own side whatever the mode; null puts back the choice. */
  preview(p: ThemePreview | null): void {
    this.previewing = p;
  }

  /** Shown at once, saved to the account; a refusal puts back what the account holds and is thrown. */
  set(patch: Partial<ThemeChoice>): Promise<void> {
    const next = { ...this.choice, ...patch };
    this.device = next;
    return account.update({ theme: next });
  }

  /**
   * A light or a dark theme picked: it takes that side. With the mode fixed on the other side, the mode moves too, so
   * the pick shows; as the system, it waits for the system to turn to that side.
   */
  use(id: LightTheme | DarkTheme, dark: boolean): Promise<void> {
    const mode = this.mode === (dark ? "light" : "dark") ? (dark ? "dark" : "light") : this.mode;
    return this.set(dark ? { dark: id as DarkTheme, mode } : { light: id as LightTheme, mode });
  }

  /** System → light → dark → system. */
  cycle(): void {
    this.set({ mode: this.next }).catch((e: unknown) => console.warn("rsva theme: not saved:", e));
  }
}

export const theme = new Theme();

autorun(() => {
  const p = theme.previewing;
  if (p) paint(p.name, p.dark);
  else apply(theme.choice, theme.dark);
});
