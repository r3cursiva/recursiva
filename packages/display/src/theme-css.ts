// The color themes' tokens as themes.css defines them (ADR 0031): Ledger in `:root, .light`, Graphite in
// `.dark` over it, every other theme a `[data-theme="…"]` block over its base with only what differs. Read from the CSS
// text, so that the web's theme test and the TUI (apps/tui/src/theme.ts) take the same colors the web paints.

/** A theme's tokens by name without `--ql-`: "ground" → "#1e1e2e". Only hex colors; shadows and the rest are not. */
export type ThemeTokens = Record<string, string>;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The hex tokens of the block that opens with `head` at the start of a line. */
function block(css: string, head: string): ThemeTokens {
  const body = css.match(new RegExp(`^${escape(head)} \\{([\\s\\S]*?)\\n\\}`, "m"))?.[1];
  if (body === undefined) throw new Error(`themes.css has no block ${head}`);
  return Object.fromEntries([...body.matchAll(/--ql-([\w-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1]!, m[2]!]));
}

/** Theme `id`'s tokens: its base's (Ledger, or Graphite over Ledger) with its own block over them. */
export function themeTokens(css: string, id: string, dark: boolean): ThemeTokens {
  const ledger = block(css, ":root,\n.light");
  const base = dark ? { ...ledger, ...block(css, ".dark") } : ledger;
  return id === (dark ? "graphite" : "ledger") ? base : { ...base, ...block(css, `[data-theme="${id}"]`) };
}

const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
/** WCAG contrast of two hex colors, 1 to 21. */
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};
