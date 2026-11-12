// The TUI's colours: Quire Ledger's tokens, as the TUI artboards of the design canvas draw them
// (https://claude.ai/artifact/PrQL4FuVkNgd5xEeJqsu9b, "Token sheet", 2026-11-05). Graphite is the dark theme and the
// default, Ledger the light one. The avatars' tones, an agent's tint and a diff's grounds are the "TUI · issue" artboards'
// (2026-11-06). A frame names tokens, not colours, so a test compares it with the artboards cell by cell; the colours
// come in only when the frame is written to the terminal.
//
// The web's other themes (ADR 0031) come from its CSS, read when one is first asked for (PLNR-381): a token the CSS
// names is taken as it is, the signal is the accent, and what only the TUI has is mixed as the artboards mix it for
// Graphite and Ledger, or kept from them (the labels' colours).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contrast, themeTokens } from "@rsva/display/theme-css";
import { DARK_THEME_INFO, LIGHT_THEME_INFO, type ThemeInfo } from "@rsva/display/themes";
import type { TileTone } from "@rsva/display/tile";
import type { Colour } from "./grid.ts";

const TOKENS = [
  "accent", "accent-ink", "accent-text", "add-bg", "avatar-mauve", "avatar-sage", "avatar-sand", "avatar-slate", "code", "del-bg", "error", "error-bg", "faint", "ground", "ink", "ink-2", "ink-3", "inverse", "inverse-ink", "lb-clay", "lb-indigo", "lb-moss", "lb-olive", "lb-plum", "lb-slate", "lb-steel", "lb-teal", "lb-umber", "nav-current", "panel", "row-hover", "row-selected", "rule", "rule-soft", "rule-strong", "sidebar", "status-approved", "status-backlog", "status-canceled", "status-done", "status-progress", "status-review", "status-todo", "success", "success-bg", "tint-approved", "tint-backlog", "tint-canceled", "tint-done", "tint-progress", "tint-review", "tint-todo", "warning", "warning-bg",
] as const;
export type Token = (typeof TOKENS)[number];

export type Theme = Record<Token, string>;

const GRAPHITE: Theme = {
  "accent": "#d9461c",
  "accent-ink": "#ffffff",
  "accent-text": "#f2875f",
  "add-bg": "#213129",
  "avatar-mauve": "#4a3b48",
  "avatar-sage": "#33463e",
  "avatar-sand": "#4d4535",
  "avatar-slate": "#36435a",
  "code": "#121211",
  "del-bg": "#382527",
  "error": "#ff8a99",
  "error-bg": "#3a1c21",
  "faint": "#5e5c56",
  "ground": "#161615",
  "ink": "#edebe5",
  "ink-2": "#bdbab1",
  "ink-3": "#918e85",
  "inverse": "#edebe5",
  "inverse-ink": "#161615",
  "lb-clay": "#c08a6a",
  "lb-indigo": "#8d8cc4",
  "lb-moss": "#7fa36b",
  "lb-olive": "#a6a05a",
  "lb-plum": "#c084b2",
  "lb-slate": "#6f9cc0",
  "lb-steel": "#8e97a6",
  "lb-teal": "#5fa39c",
  "lb-umber": "#b08a5a",
  "nav-current": "#2b2a27",
  "panel": "#1c1c1a",
  "row-hover": "#22211f",
  "row-selected": "#282724",
  "rule": "#2b2a27",
  "rule-soft": "#242321",
  "rule-strong": "#4a4843",
  "sidebar": "#121211",
  "status-approved": "#2cc5bd",
  "status-backlog": "#8f949c",
  "status-canceled": "#8f949c",
  "status-done": "#8790ee",
  "status-progress": "#f2c94c",
  "status-review": "#4cb782",
  "status-todo": "#9c9a92",
  "success": "#6fd1a8",
  "success-bg": "#17332a",
  "tint-approved": "#1a3432",
  "tint-backlog": "#2b2b2c",
  "tint-canceled": "#2b2b2c",
  "tint-done": "#292b3a",
  "tint-progress": "#3b341e",
  "tint-review": "#1f3128",
  "tint-todo": "#2d2c2a",
  "warning": "#f2c46b",
  "warning-bg": "#3a2e14",
};

const LEDGER: Theme = {
  "accent": "#d9461c",
  "accent-ink": "#ffffff",
  "accent-text": "#a8360f",
  "add-bg": "#d2ded4",
  "avatar-mauve": "#dcd0da",
  "avatar-sage": "#cbd6d0",
  "avatar-sand": "#dcd6c6",
  "avatar-slate": "#d0d7e3",
  "code": "#efeee8",
  "del-bg": "#e9d5d3",
  "error": "#be1e37",
  "error-bg": "#fbe9ec",
  "faint": "#b5b2a8",
  "ground": "#f6f5f1",
  "ink": "#18181b",
  "ink-2": "#4a4a50",
  "ink-3": "#6b6a66",
  "inverse": "#18181b",
  "inverse-ink": "#fbfaf7",
  "lb-clay": "#8a5a3c",
  "lb-indigo": "#55548a",
  "lb-moss": "#4a6b3a",
  "lb-olive": "#6e6a2f",
  "lb-plum": "#8a4f7d",
  "lb-slate": "#3d6e8f",
  "lb-steel": "#5c6470",
  "lb-teal": "#2f6f6a",
  "lb-umber": "#7a5c34",
  "nav-current": "#e2e0d8",
  "panel": "#fbfaf7",
  "row-hover": "#eeece5",
  "row-selected": "#eceae2",
  "rule": "#e2e0d8",
  "rule-soft": "#e9e7e0",
  "rule-strong": "#cfccc2",
  "sidebar": "#efeee8",
  "status-approved": "#0b7f7a",
  "status-backlog": "#7d828b",
  "status-canceled": "#7d828b",
  "status-done": "#5e6ad2",
  "status-progress": "#a07700",
  "status-review": "#2e8b45",
  "status-todo": "#76746e",
  "success": "#1f7a5c",
  "success-bg": "#e3f1ea",
  "tint-approved": "#d7e6e2",
  "tint-backlog": "#e6e6e4",
  "tint-canceled": "#e6e6e4",
  "tint-done": "#e2e3ed",
  "tint-progress": "#ebe5d2",
  "tint-review": "#dce7db",
  "tint-todo": "#e5e4e0",
  "warning": "#8a5a00",
  "warning-bg": "#fbf0d9",
};

/**
 * A project's tile as the web paints it (@rsva/ui letter-tile.tsx, @rsva/display themes.css --ql-ws-*): its letters' colour and
 * its fill, the same in both themes.
 */
export const TILE: Record<TileTone, [fg: Colour, bg: Colour]> = {
  ink: ["ground", "ink"],
  signal: ["accent-ink", "accent"],
  slate: ["#ffffff", "#5a6472"],
  umber: ["#ffffff", "#7a5c34"],
  ochre: ["#ffffff", "#94690c"],
  olive: ["#ffffff", "#66702c"],
  forest: ["#ffffff", "#3a7446"],
  teal: ["#ffffff", "#2f6f6a"],
  cobalt: ["#ffffff", "#1f6ab8"],
  indigo: ["#ffffff", "#55548a"],
  plum: ["#ffffff", "#7c4685"],
  rose: ["#ffffff", "#ad3a62"],
};

/** A state's tint, for its chip: the status colour's own. */
export const tintOf = (tone: Token): Token => (tone.startsWith("status-") ? (`tint-${tone.slice(7)}` as Token) : "row-selected");

/** The themes the palette offers, the web's sixteen (PLNR-381): the dark ones first, Graphite the default. */
export const THEMES: readonly ThemeInfo[] = [...DARK_THEME_INFO, ...LIGHT_THEME_INFO];

/**
 * How much of its colour a ground mixed from it has over the theme's ground, as Graphite's and Ledger's tables have it:
 * a state's chip (17 % and 13 %), a diff's added and removed lines (about 14 % and 18 %). The notices' grounds there are
 * drawn by hand; these amounts keep their text as readable. A theme whose text would read worse on the mix gets less of
 * the colour (readable below).
 */
const MIX = { dark: { tint: 0.17, diff: 0.14, notice: 0.15 }, light: { tint: 0.13, diff: 0.18, notice: 0.1 } };

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** `amount` of `colour` over `ground`, in sRGB as the tables were mixed. */
const mix = (ground: string, colour: string, amount: number) => {
  const g = rgb(ground);
  const c = rgb(colour);
  return `#${g.map((v, i) => Math.round(v + (c[i]! - v) * amount).toString(16).padStart(2, "0")).join("")}`;
};

/**
 * The most of `colour` over `ground`, up to `amount`, on which each [text, least contrast] still reads: a theme's text
 * reads on its ground (the web's test holds it), so less colour always gets there.
 */
function readable(ground: string, colour: string, amount: number, on: [text: string, least: number][]): string {
  for (let a = amount; a > 0; a -= 0.01) {
    const bg = mix(ground, colour, a);
    if (on.every(([text, least]) => contrast(text, bg) >= least)) return bg;
  }
  return ground;
}

/** What has to read on a mixed ground: text 4.5:1, a glyph 3:1, as the web's theme test asks of its surfaces. */
export const READS = { text: 4.5, glyph: 3 } as const;

const STATES = ["approved", "backlog", "canceled", "done", "progress", "review", "todo"] as const;
let css: string | undefined;
const made = new Map<string, Theme>([
  ["graphite", GRAPHITE],
  ["ledger", LEDGER],
]);

/** Theme `id`'s colours; an id it does not know is Graphite. */
export function themeColours(id: string): Theme {
  const known = made.get(id);
  if (known) return known;
  const info = THEMES.find((t) => t.id === id);
  if (!info) return GRAPHITE;
  css ??= readFileSync(fileURLToPath(import.meta.resolve("@rsva/display/themes.css")), "utf8");
  const web = themeTokens(css, id, info.dark);
  const base = info.dark ? GRAPHITE : LEDGER;
  const t: Theme = { ...base };
  for (const token of TOKENS) if (web[token]) t[token] = web[token];
  t.accent = web.signal ?? t.accent;
  t["accent-ink"] = web["signal-ink"] ?? t["accent-ink"];
  t["accent-text"] = web["signal-text"] ?? t["accent-text"];
  const m = MIX[info.dark ? "dark" : "light"];
  // A state's chip: its glyph and its name in ink-2. A diff's line: its text in ink-2. A notice: its text in its colour.
  for (const st of STATES) t[`tint-${st}`] = readable(t.ground, t[`status-${st}`], m.tint, [[t[`status-${st}`], READS.glyph], [t["ink-2"], READS.text]]);
  for (const [bg, from] of [["add-bg", "success"], ["del-bg", "error"]] as const) t[bg] = readable(t.ground, t[from], m.diff, [[t["ink-2"], READS.text]]);
  for (const [bg, from] of [["success-bg", "success"], ["warning-bg", "warning"]] as const) t[bg] = readable(t.ground, t[from], m.notice, [[t[from], READS.text]]);
  made.set(id, t);
  return t;
}
