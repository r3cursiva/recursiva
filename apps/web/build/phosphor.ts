// Phosphor icons with only the weights the code uses (PLNR-24).
//
// @phosphor-icons/react puts all six weights (thin, light, regular, bold, fill, duotone) into every icon: for our 59
// icons that is 27.5 KB brotli, of which 5.7 KB is what the screens draw. In a build this plugin answers the
// `@phosphor-icons/react` import with a generated module: each icon the code imports, built on the package's own
// IconBase with only the weights named in the files that import it, and everything else re-exported from the package.
// Imports stay as they are (the shadcn generator writes them too); development uses the package unchanged.
//
// Weights are found per importing file. An icon paired with its weight there — `<CheckIcon weight="bold"` or
// `{ Icon: CheckIcon, weight: "fill" }` — gets exactly those weights; any other icon the file imports gets every weight
// literal in the file plus regular. An icon asked for a weight it was built without draws one it has instead of nothing.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

const PKG = "@phosphor-icons/react";
const INDEX = "\0rsva-phosphor";
const BASE = "\0rsva-phosphor:base";
const ICON = "\0rsva-phosphor:icon:";
const WEIGHTS = ["thin", "light", "regular", "bold", "fill", "duotone"] as const;

/** Icon export name ("CheckIcon") → the weights its importers use; regular always. */
export function usedIcons(sources: Iterable<string>): Map<string, Set<string>> {
  const used = new Map<string, Set<string>>();
  for (const src of sources) {
    const imports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@phosphor-icons\/react["']/g)];
    if (!imports.length) continue;
    const weights = new Set(["regular", ...[...src.matchAll(/\bweight(?:=|\s*:\s*)["'](\w+)["']/g)].map((m) => m[1]!)]);
    // Pairs: a JSX tag of the icon with a literal weight, or an object naming the icon and then its weight.
    const paired = new Map<string, Set<string>>();
    for (const m of src.matchAll(/<(\w+)\b[^<>]*?\bweight="(\w+)"|\b(\w+Icon)\s*,\s*weight\s*:\s*"(\w+)"/g)) {
      const local = m[1] ?? m[3]!;
      let set = paired.get(local);
      if (!set) paired.set(local, (set = new Set()));
      set.add(m[2] ?? m[4]!);
    }
    for (const m of imports)
      for (const spec of m[1]!.split(",")) {
        const [name, alias] = spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/) as [string, string | undefined];
        if (!/^[A-Z]\w*Icon$/.test(name)) continue;
        let set = used.get(name);
        if (!set) used.set(name, (set = new Set()));
        for (const w of paired.get(alias ?? name) ?? weights) if ((WEIGHTS as readonly string[]).includes(w)) set.add(w);
      }
  }
  return used;
}

/**
 * The React elements of each weight in a Phosphor definition file (dist/defs/<Name>.es.js: `new Map([["bold", <expr>],
 * …])`), as source text with the file's React namespace renamed to `R`.
 */
export function weightElements(defs: string): Map<string, string> {
  const ns = /import \* as (\w+) from "react"/.exec(defs)?.[1];
  if (!ns) throw new Error("phosphor: no React namespace import in a definition file");
  const out = new Map<string, string>();
  for (const m of defs.matchAll(/\[\s*"(\w+)",\s*/g)) {
    let depth = 0;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < defs.length; i++) {
      const c = defs[i]!;
      if (c === '"') i = defs.indexOf('"', i + 1);
      else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      }
    }
    out.set(m[1]!, defs.slice(start, i).trim().replace(new RegExp(`\\b${ns}\\.`, "g"), "R."));
  }
  if (!out.has("regular")) throw new Error("phosphor: a definition file without the regular weight");
  return out;
}

/**
 * The modules that stand in for `@phosphor-icons/react` in a build: an index re-exporting the package, with every icon
 * the code uses taken from a module of its own, so each lands in the chunk that draws it (one module for all of them
 * moved the lazy chunk's icons into the startup file: +4.4 KB brotli there).
 */
export function iconModules(dist: string, used: Map<string, Set<string>>): Map<string, string> {
  const out = new Map<string, string>();
  const names = [...used.keys()].sort();
  out.set(
    INDEX,
    [`export * from ${JSON.stringify(join(dist, "index.es.js"))};`, ...names.map((n) => `export { ${n} } from ${JSON.stringify(ICON + n)};`)].join("\n") + "\n",
  );
  out.set(
    BASE,
    [
      `import * as R from "react";`,
      `import IconBase from ${JSON.stringify(join(dist, "lib/IconBase.es.js"))};`,
      `class Weights extends Map { get(k) { return super.get(k) ?? super.get("regular") ?? this.values().next().value; } }`,
      `export function icon(name, entries) {`,
      `  const weights = new Weights(entries);`,
      `  const C = R.forwardRef((p, ref) => R.createElement(IconBase, { ref, ...p, weights }));`,
      `  C.displayName = name;`,
      `  return C;`,
      `}`,
    ].join("\n") + "\n",
  );
  for (const name of names) {
    const els = weightElements(readFileSync(join(dist, "defs", `${name.slice(0, -"Icon".length)}.es.js`), "utf8"));
    const entries = [...used.get(name)!].filter((w) => els.has(w)).map((w) => `[${JSON.stringify(w)}, ${els.get(w)}]`);
    out.set(
      ICON + name,
      [`import * as R from "react";`, `import { icon } from ${JSON.stringify(BASE)};`, `export const ${name} = /* @__PURE__ */ icon(${JSON.stringify(name)}, [${entries.join(", ")}]);`].join("\n") + "\n",
    );
  }
  return out;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sourceFiles(p);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) yield p;
  }
}

/** `roots`: the source folders the app bundles (its own and the workspace packages it imports). */
export function phosphorWeights(roots: string[]): Plugin {
  const dist = dirname(createRequire(import.meta.url).resolve(PKG));
  let modules: Map<string, string> | undefined;
  return {
    name: "rsva-phosphor-weights",
    apply: "build",
    enforce: "pre",
    resolveId(id) {
      if (id === PKG) return INDEX;
      return id.startsWith("\0rsva-phosphor") ? id : null;
    },
    load(id) {
      if (!id.startsWith("\0rsva-phosphor")) return null;
      modules ??= iconModules(dist, usedIcons(roots.flatMap((r) => [...sourceFiles(r)].map((f) => readFileSync(f, "utf8")))));
      const code = modules.get(id);
      // Virtual modules have no package.json saying sideEffects: false; without this every icon module stays in the
      // chunk of the index, used or not.
      return code === undefined ? null : { code, moduleSideEffects: false };
    },
  };
}
