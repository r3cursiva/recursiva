// The stylesheet of the first paint holds only the rules the startup chunks use (PLNR-286). Tailwind makes one stylesheet
// for every source, and the screens of the lazy edit chunk (settings, cycles, timeline, notifications…) had doubled it
// in a week: 15.7 → 28.6 KB brotli, all of it render-blocking on a cold start.
//
// The built stylesheet stays as it is and loads with the edit chunk (src/screens/load-edit-chunk.ts, named by a meta tag
// in index.html: the page is never cached as immutable, a chunk is). The page links a copy without the rules whose class
// no startup module mentions. Rules are only removed, never moved, so a rule the startup copy keeps sits in the same
// order as in the whole; and once the whole sheet is in, it comes later and decides every cascade on its own.
//
// Considered (2026-11-05): a stylesheet per chunk with disjoint rules is smaller in all, but a utility used at startup
// and another of the same property used only later would meet in the wrong order (`px-3` from one sheet, `p-2` from the
// other); compiling Tailwind again with the startup candidates loses what Vite does to the stylesheet (imports, font
// URLs, minifying); a `prefetch` of the whole sheet in the page takes the line from the cold start at 120 KB/s.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { transform, type CustomAtRules, type Selector, type SelectorComponent, type Visitor } from "lightningcss";
import type { Plugin, Rolldown } from "vite";

type OutputBundle = Rolldown.OutputBundle;
type OutputChunk = Rolldown.OutputChunk;

/** The page's meta tag that names the whole stylesheet; src/screens/load-edit-chunk.ts reads it. */
const FULL_CSS_META = "rsva-css";

/** Generated tables that list class groups, not classes a screen uses: scanning them would keep every rule. */
const NOT_SOURCES = /[\\/]cn-tables\.ts$/;

export function startupCss(): Plugin {
  return {
    name: "rsva-startup-css",
    apply: "build",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const entry = Object.values(bundle).find((f): f is OutputChunk => f.type === "chunk" && f.isEntry);
        if (!entry) throw new Error("rsva-startup-css: no entry chunk");
        const imported = [...(entry.viteMetadata?.importedCss ?? [])];
        if (imported.length !== 1) throw new Error(`rsva-startup-css: the entry should import one stylesheet, not ${imported.length}`);
        const fullName = imported[0]!;
        const css = bundle[fullName];
        const html = bundle["index.html"];
        const manifest = bundle[".vite/manifest.json"];
        if (css?.type !== "asset" || html?.type !== "asset" || manifest?.type !== "asset") {
          throw new Error("rsva-startup-css: the stylesheet, index.html or the manifest is not in the bundle yet");
        }

        const whole = String(css.source);
        const startup = startupText(bundle, entry);
        const source = keepUsed(whole, (name) => startup.includes(name));
        const name = `assets/startup-${createHash("sha256").update(source).digest("base64url").slice(0, 8)}.css`;
        this.emitFile({ type: "asset", fileName: name, source });
        // The whole sheet keeps its name: what is cut from it follows from its content alone.
        css.source = withoutFontFaces(whole);

        const href = `/${fullName}`;
        const page = String(html.source);
        if (!page.includes(`href="${href}"`)) throw new Error(`rsva-startup-css: index.html does not link ${href}`);
        html.source = page.replace(`href="${href}"`, `href="/${name}"`).replace("</head>", `  <meta name="${FULL_CSS_META}" content="${href}" />\n  </head>`);

        const m = JSON.parse(String(manifest.source)) as Record<string, { isEntry?: boolean; css?: string[] }>;
        for (const c of Object.values(m)) if (c.isEntry) c.css = [name];
        manifest.source = JSON.stringify(m, null, 2);
      },
    },
  };
}

/** The text of every source module of the entry and the chunks it imports statically. */
function startupText(bundle: OutputBundle, entry: OutputChunk): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const walk = (chunk: OutputChunk) => {
    if (seen.has(chunk.fileName)) return;
    seen.add(chunk.fileName);
    for (const id of chunk.moduleIds) {
      if (id.includes("/node_modules/") || id.startsWith("\0") || NOT_SOURCES.test(id) || !/\.[cm]?[jt]sx?$/.test(id)) continue;
      parts.push(readFileSync(id, "utf8"));
    }
    for (const i of chunk.imports) {
      const next = bundle[i];
      if (next?.type === "chunk") walk(next);
    }
  };
  walk(entry);
  return parts.join("\n");
}

/**
 * The stylesheet without the style rules none of whose selectors' first class is used. A rule with no class at all
 * (`:root`, a theme's `[data-theme]`, `*`) stays; at-rules left empty go.
 */
export function keepUsed(css: string, used: (className: string) => boolean): string {
  const kept = edit(css, {
    Rule: {
      // Kept: nothing returned, so lightningcss does not write the rule back from its JSON (that round trip fails on
      // some selectors: "expected … Specifier").
      style(rule) {
        const kept = rule.value.selectors.some((s) => {
          const c = firstClass(s);
          return c === null || used(c);
        });
        return kept ? undefined : [];
      },
    },
  });
  // A second pass: within the first, a block still lists the rules just taken out of it.
  const empty = (r: { value: { rules: unknown[] } }) => (r.value.rules.length ? undefined : []);
  return edit(kept, { Rule: { media: empty, supports: empty, container: empty, "layer-block": empty } });
}

/**
 * The stylesheet without its `@font-face` rules, which the startup copy has already declared. A second declaration of
 * the same face is a new FontFace: it loads at once from the memory cache, inside `font-display: optional`'s window that
 * the first one missed on a cold start, and the text that went out in the fallback font changes its width when a lazy
 * screen first opens (seen in the style check of PLNR-286).
 */
export function withoutFontFaces(css: string): string {
  return edit(css, { Rule: { "font-face": () => [] } });
}

function edit(css: string, visitor: Visitor<CustomAtRules>): string {
  return transform({ filename: "rsva.css", code: Buffer.from(css), minify: true, visitor }).code.toString();
}

/** The first class a selector names, looking inside `:is()`, `:where()` and the like: the utility a rule belongs to. */
function firstClass(selector: Selector): string | null {
  for (const c of selector as SelectorComponent[]) {
    if (c.type === "class") return c.name;
    if (c.type === "pseudo-class" && "selectors" in c && Array.isArray(c.selectors)) {
      for (const inner of c.selectors as Selector[]) {
        const found = firstClass(inner);
        if (found !== null) return found;
      }
    }
  }
  return null;
}
