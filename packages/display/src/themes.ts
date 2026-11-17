// The color themes as people see them (ADR 0031): fourteen pairs, each a family name over its light and dark theme, which
// have a name and a line on their look of their own. A pair is picked whole; the mode picks the side. The colors are in
// themes.css (theme-css.ts reads them); the ids and which are light or dark in @rsva/protocol, where a light and a dark
// theme in the same place are a pair. Not in the web's theme.ts: only what offers a choice needs the words (Settings ›
// Appearance and the command palette, loaded on demand; the TUI's palette).
import { DARK_THEMES, LIGHT_THEMES, type DarkTheme, type LightTheme } from "@rsva/protocol";

export interface ThemeInfo {
  id: LightTheme | DarkTheme;
  name: string;
  note: string;
  dark: boolean;
}

const WORDS: Record<LightTheme | DarkTheme, [name: string, note: string]> = {
  // The id stays `ledger` (the stored choice); the name is the family's, as with the others.
  ledger: ["Graphite Light", "Warm paper, soft ink, vermilion signal. The default."],
  "blueprint-light": ["Blueprint Light", "Cool drafting paper, navy ink, a cobalt signal."],
  "moss-light": ["Moss Light", "Pale lichen paper, forest ink, a coral signal."],
  "newsprint-light": ["Newsprint Light", "Black on white. Every text passes AAA; a press-red signal."],
  "dune-light": ["Dune Light", "Sand paper, umber ink, an indigo signal against the warm ground."],
  "aubergine-light": ["Aubergine Light", "Lilac-grey paper, plum ink, cerise for the signal."],
  "harbor-light": ["Harbor Light", "Sea-fog grey-green, deep teal ink, an amber signal."],
  latte: ["Catppuccin Latte", "Soft pastel paper, mauve signal."],
  "gruvbox-light": ["Gruvbox Light", "Retro cream paper, earthy ink, burnt orange."],
  "one-light": ["One Light", "Atom's clean light gray, blue signal."],
  "github-light": ["GitHub Light", "Crisp white and gray, GitHub blue."],
  "solarized-light": ["Solarized Light", "Warm cream, blue-gray ink, orange signal."],
  "night-owl-light": ["Night Owl Light", "Clean white, slate ink, teal signal."],
  alucard: ["Dracula Alucard", "Dracula's light side: cream, near-black ink, magenta signal."],
  graphite: ["Graphite Dark", "Warm graphite, not blue-black. The default."],
  "blueprint-dark": ["Blueprint Dark", "Prussian-blue paper, chalk-white lines, a sky-blue signal."],
  "moss-dark": ["Moss Dark", "Deep forest green, lichen text, a coral signal."],
  "newsprint-dark": ["Newsprint Dark", "Pure black, white text at 21:1, a brighter press red."],
  "dune-dark": ["Dune Dark", "Burnt umber at night, parchment text, a periwinkle signal."],
  "aubergine-dark": ["Aubergine Dark", "Deep aubergine, pale lilac text, saffron for what waits on you."],
  "harbor-dark": ["Harbor Dark", "Harbor water at night, sea-foam text, the amber buoy."],
  mocha: ["Catppuccin Mocha", "Deep indigo night, pastel colors, mauve signal."],
  "gruvbox-dark": ["Gruvbox Dark", "Retro warm brown, cream ink, bright orange."],
  "one-dark": ["One Dark", "Atom's blue-gray, the editor classic."],
  "github-dark": ["GitHub Dark", "Near-black blue, GitHub's dark mode."],
  "solarized-dark": ["Solarized Dark", "Deep teal, gray-blue ink, orange signal."],
  "night-owl": ["Night Owl", "Deep night blue, cool ink, aqua signal."],
  dracula: ["Dracula", "Purple-gray night, neon pink signal."],
};

const info = (id: LightTheme | DarkTheme, dark: boolean): ThemeInfo => ({ id, name: WORDS[id][0], note: WORDS[id][1], dark });

export const LIGHT_THEME_INFO: readonly ThemeInfo[] = LIGHT_THEMES.map((id) => info(id, false));
export const DARK_THEME_INFO: readonly ThemeInfo[] = DARK_THEMES.map((id) => info(id, true));

export interface ThemePair {
  name: string;
  light: ThemeInfo & { id: LightTheme };
  dark: ThemeInfo & { id: DarkTheme };
}

/** In the protocol's order: the pair's light theme is LIGHT_THEMES[i], its dark one DARK_THEMES[i]. */
const PAIRS: readonly string[] = ["Graphite", "Blueprint", "Moss", "Newsprint", "Dune", "Aubergine", "Harbor", "Catppuccin", "Gruvbox", "One", "GitHub", "Solarized", "Night Owl", "Dracula"];

export const THEME_PAIRS: readonly ThemePair[] = PAIRS.map((name, i) => ({
  name,
  light: { ...LIGHT_THEME_INFO[i]!, id: LIGHT_THEMES[i]! },
  dark: { ...DARK_THEME_INFO[i]!, id: DARK_THEMES[i]! },
}));

/**
 * The pair whose side on screen is the chosen one: the two sides are stored apart (an API client, or a choice from
 * before pairs, could mix them), and the side on screen is the one seen. The first pair if none.
 */
export function pairOnScreen(light: string, dark: string, darkOnScreen: boolean): ThemePair {
  return THEME_PAIRS.find((p) => (darkOnScreen ? p.dark.id === dark : p.light.id === light)) ?? THEME_PAIRS[0]!;
}
