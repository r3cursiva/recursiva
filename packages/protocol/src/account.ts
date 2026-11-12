// The person's own settings (Settings › Profile) and how the snapshot answer carries them in its headers.
import type { GroupId } from "./my-work.ts";

/**
 * How long a sign-in code stays the live one: a new request within it mails nothing (apps/server/src/auth/codes.ts), so
 * the sign-in screen offers "Send a new code" only after it.
 */
export const CODE_RESEND_MS = 60_000;

/** After how many still days a project folds into the sidebar's Quiet by itself (RSVA-566); 0, never. */
export const QUIET_CHOICES = [0, 7, 14, 30] as const;
export type QuietDays = (typeof QUIET_CHOICES)[number];

/**
 * Who the snapshot was cut for: the signed-in user's id and role, and their own settings (PLNR-210), so a new device has
 * the calendars' week with its data instead of asking GET /auth/me after it. Headers, so the body can be shared. A
 * server before the settings sends none of them, and the client asks /auth/me as before: no version bump.
 */
export const VIEWER_HEADERS = {
  me: "x-rsva-me",
  role: "x-rsva-role",
  timeZone: "x-rsva-time-zone",
  weekStart: "x-rsva-week-start",
  theme: "x-rsva-theme",
  ui: "x-rsva-ui",
} as const;

/** The settings as snapshot headers; a person without a time zone, a theme or an interface choice yet gets no header for it. */
export function settingsHeaders(s: AccountSettings): Record<string, string> {
  return {
    [VIEWER_HEADERS.weekStart]: String(s.weekStart),
    ...(s.timeZone ? { [VIEWER_HEADERS.timeZone]: s.timeZone } : {}),
    ...(s.theme ? { [VIEWER_HEADERS.theme]: `${s.theme.mode} ${s.theme.light} ${s.theme.dark}` } : {}),
    ...(s.ui ? { [VIEWER_HEADERS.ui]: `${s.ui.panes} ${s.ui.density} ${s.ui.start} ${s.ui.project} ${s.ui.quiet}` } : {}),
  };
}

/** The settings from a snapshot answer's headers, or null from a server that does not send them. */
export function settingsFrom(get: (name: string) => string | null): AccountSettings | null {
  const weekStart = Number(get(VIEWER_HEADERS.weekStart) ?? NaN);
  if (!WEEK_STARTS.includes(weekStart as WeekStart)) return null;
  const [mode, light, dark] = (get(VIEWER_HEADERS.theme) ?? "").split(" ");
  const theme = { mode, light, dark } as ThemeChoice;
  const [panes, density, start, project, quiet] = (get(VIEWER_HEADERS.ui) ?? "").split(" ");
  return {
    timeZone: get(VIEWER_HEADERS.timeZone) || null,
    weekStart: weekStart as WeekStart,
    theme: isThemeChoice(theme) ? theme : null,
    ui: panes ? uiFrom({ panes, density, start, project, quiet: Number(quiet) }) : null,
  };
}

/** First day of the week as `Date.getDay()` counts: Monday, Sunday or Saturday. */
export type WeekStart = 1 | 0 | 6;
export const WEEK_STARTS: readonly WeekStart[] = [1, 0, 6];

/** Follow the system's light and dark, or keep one of them all day. */
export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
/**
 * The color themes, eight of each kind: ours first (the default), then Catppuccin, Gruvbox, One, GitHub, Solarized,
 * Night Owl and Dracula. A light one and a dark one in the same place are a pair.
 */
export const LIGHT_THEMES = ["ledger", "latte", "gruvbox-light", "one-light", "github-light", "solarized-light", "night-owl-light", "alucard"] as const;
export const DARK_THEMES = ["graphite", "mocha", "gruvbox-dark", "one-dark", "github-dark", "solarized-dark", "night-owl", "dracula"] as const;
export type LightTheme = (typeof LIGHT_THEMES)[number];
export type DarkTheme = (typeof DARK_THEMES)[number];
/** The mode, and which theme is used for light and which for dark. */
export interface ThemeChoice {
  mode: ThemeMode;
  light: LightTheme;
  dark: DarkTheme;
}
export const THEME_DEFAULTS: ThemeChoice = { mode: "system", light: "ledger", dark: "graphite" };

export function isThemeChoice(v: unknown): v is ThemeChoice {
  const t = v as Partial<ThemeChoice> | null;
  return !!t && typeof t === "object" && THEME_MODES.includes(t.mode!) && LIGHT_THEMES.includes(t.light!) && DARK_THEMES.includes(t.dark!);
}

/**
 * The shape of the window on a wide screen (Settings › Appearance › Layout): framed, its blocks (sidebar, screen, each
 * pane of a split) apart on a frame with rounded corners, rows and cards as rounded plates; or flat, the blocks side by
 * side with lines between them and rows as full-width bands. Named for the shape, not the room: the room is the density.
 */
export const PANE_STYLES = ["framed", "flat"] as const;
export type PaneStyle = (typeof PANE_STYLES)[number];
/** How tall a list's rows are on a wide screen: 32px, or 40px with more air. */
export const DENSITIES = ["compact", "comfortable"] as const;
export type Density = (typeof DENSITIES)[number];
/**
 * Where the app opens (Settings › Preferences › Navigation, RSVA-527): `/` and a workspace's own address. The first
 * project opens on its issues whatever `project` says: the home is a lazy chunk, and the first paint does not wait for it
 * (ADR 0053).
 */
export const START_PAGES = ["project", "myWork", "inbox"] as const;
export type StartPage = (typeof START_PAGES)[number];
/** The page a project opens on from the sidebar, All projects and ⌘K: its home, or its issues. */
export const PROJECT_PAGES = ["home", "issues"] as const;
export type ProjectPage = (typeof PROJECT_PAGES)[number];
/** The interface's own settings, beside the colors; one object, so the next one needs no new column or header. */
export interface UiChoice {
  panes: PaneStyle;
  density: Density;
  start: StartPage;
  project: ProjectPage;
  /** Settings › Preferences › Navigation: after how many still days the sidebar's Quiet takes a project. */
  quiet: QuietDays;
}
export const UI_DEFAULTS: UiChoice = { panes: "framed", density: "compact", start: "project", project: "home", quiet: 14 };

const known = <T extends string | number>(list: readonly T[], v: unknown, otherwise: T): T => (list.includes(v as T) ? (v as T) : otherwise);

/**
 * A saved choice as this build reads it, or null if it is not one: a field it lacks or no longer knows takes the
 * default, so one saved before a setting existed keeps the others.
 */
export function uiFrom(v: unknown): UiChoice | null {
  if (!v || typeof v !== "object") return null;
  const u = v as Partial<Record<keyof UiChoice, unknown>>;
  return {
    panes: known(PANE_STYLES, u.panes, UI_DEFAULTS.panes),
    density: known(DENSITIES, u.density, UI_DEFAULTS.density),
    start: known(START_PAGES, u.start, UI_DEFAULTS.start),
    project: known(PROJECT_PAGES, u.project, UI_DEFAULTS.project),
    quiet: known(QUIET_CHOICES, u.quiet, UI_DEFAULTS.quiet),
  };
}

/** The person's own settings (Settings › Profile), the same in every workspace. */
export interface AccountSettings {
  /** IANA zone; null until a browser of theirs reports one. */
  timeZone: string | null;
  weekStart: WeekStart;
  /** Null until they pick one: each device keeps the mode it had before themes were on the account. */
  theme: ThemeChoice | null;
  /** Null until they pick: the defaults. */
  ui: UiChoice | null;
  /**
   * The groups of their My work that are folded (my-work.ts, myWorkFolds reads them); null: Later and Done this week. Too long for a
   * snapshot header: a snapshot's settings leave it out (undefined), and the device keeps the copy it has.
   */
  myWork?: GroupId[] | null;
}

/** A person who never changed them. */
export const ACCOUNT_DEFAULTS: AccountSettings = { timeZone: null, weekStart: 1, theme: null, ui: null, myWork: null };
