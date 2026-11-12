// The color themes as people see them (ADR 0031): a name and a line on what each looks like. The colors are in
// themes.css (theme-css.ts reads them); the ids and which are light or dark in @rsva/protocol. Not in the
// web's theme.ts: only what offers a choice needs the words (Profile and the command palette, loaded on demand; the
// TUI's palette).
import { DARK_THEMES, LIGHT_THEMES, type DarkTheme, type LightTheme } from "@rsva/protocol";

export interface ThemeInfo {
  id: LightTheme | DarkTheme;
  name: string;
  note: string;
  dark: boolean;
}

const WORDS: Record<LightTheme | DarkTheme, [name: string, note: string]> = {
  ledger: ["Ledger", "Warm paper, soft ink, vermilion signal. The default."],
  latte: ["Catppuccin Latte", "Soft pastel paper, mauve signal."],
  "gruvbox-light": ["Gruvbox Light", "Retro cream paper, earthy ink, burnt orange."],
  "one-light": ["One Light", "Atom's clean light gray, blue signal."],
  "github-light": ["GitHub Light", "Crisp white and gray, GitHub blue."],
  "solarized-light": ["Solarized Light", "Warm cream, blue-gray ink, orange signal."],
  "night-owl-light": ["Night Owl Light", "Clean white, slate ink, teal signal."],
  alucard: ["Dracula Alucard", "Dracula's light side: cream, near-black ink, magenta signal."],
  graphite: ["Graphite", "Warm graphite, not blue-black. The default."],
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
