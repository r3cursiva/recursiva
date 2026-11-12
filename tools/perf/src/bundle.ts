// UI size after `pnpm build`: what downloads on first visit (index.html and the entry's static imports), what loads
// later, and which packages make up the startup JS.
//
// The main metric is brotli: the server picks it for every modern browser (apps/server/src/static.ts).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync, zstdCompressSync } from "node:zlib";
import { check, fmt, printTable, ROOT, type Metric } from "./report.ts";

const DIST = join(ROOT, "apps/web/dist");
const B64 = new Map([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]));
/** The VLQ source index is relative to the previous segment across the whole map file. */
let srcState = 0;

interface Chunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
}

interface Sizes {
  raw: number;
  br: number;
  zst: number;
  gz: number;
}

const manifest = JSON.parse(readFileSync(join(DIST, ".vite/manifest.json"), "utf8")) as Record<string, Chunk>;
const entry = Object.values(manifest).find((c) => c.isEntry);
if (!entry) throw new Error("the build manifest has no entry");

// Startup set: the entry, everything it imports statically, and their CSS.
const initial = new Set<string>(["index.html"]);
const walk = (c: Chunk) => {
  if (initial.has(c.file)) return;
  initial.add(c.file);
  for (const css of c.css ?? []) initial.add(css);
  for (const k of c.imports ?? []) walk(manifest[k]!);
};
walk(entry);

const assets = readdirSync(join(DIST, "assets"))
  .filter((f) => /\.(js|css)$/.test(f))
  .map((f) => `assets/${f}`);
const lazy = assets.filter((f) => !initial.has(f));
// Fonts are already compressed (woff2) and fetched by unicode-range, only the subsets needed. We count every file
// so a new weight or subset shows up in the report.
const fonts = readdirSync(join(DIST, "assets")).filter((f) => f.endsWith(".woff2"));
const fontBytes = fonts.reduce((n, f) => n + readFileSync(join(DIST, "assets", f)).length, 0);

const sum = (files: Iterable<string>): Sizes => {
  const t: Sizes = { raw: 0, br: 0, zst: 0, gz: 0 };
  for (const f of files) {
    const s = sizes(f);
    t.raw += s.raw;
    t.br += s.br;
    t.zst += s.zst;
    t.gz += s.gz;
  }
  return t;
};
const ini = sum(initial);
const all = sum(["index.html", ...assets]);

console.log("Startup files:");
printTable(
  ["file", "raw", "br", "zstd", "gzip"],
  [...initial].map((f) => {
    const s = sizes(f);
    return [f, fmt(s.raw, "B"), fmt(s.br, "B"), fmt(s.zst, "B"), fmt(s.gz, "B")];
  }),
);

console.log("\nStartup JS by package (each part brotli-compressed alone, so the parts add up to more than the total):");
const parts = composition([...initial].filter((f) => f.endsWith(".js")));
printTable(
  ["package", "raw", "br", "raw share"],
  parts.map((p) => [p.name, fmt(p.raw, "B"), fmt(p.br, "B"), ((p.raw / ini.raw) * 100).toFixed(1) + "%"]),
);
console.log(`\nLazy files: ${lazy.length}, ${fmt(sum(lazy).br, "B")} brotli.`);
console.log(`Fonts: ${fonts.length}, ${fmt(fontBytes, "B")}: ${fonts.map((f) => f.replace(/-[\w-]{8}\.woff2$/, "")).join(", ")}.\n`);

const metrics: Metric[] = [
  { key: "bundle.initial.br", label: "startup, brotli", value: ini.br, unit: "B", ratchet: true },
  { key: "bundle.initial.zst", label: "startup, zstd", value: ini.zst, unit: "B", ratchet: true },
  { key: "bundle.initial.raw", label: "startup, raw", value: ini.raw, unit: "B", ratchet: true },
  { key: "bundle.initial.files", label: "startup, files", value: initial.size, unit: "n", ratchet: true },
  { key: "bundle.all.br", label: "whole build, brotli", value: all.br, unit: "B", ratchet: true },
  { key: "bundle.fonts", label: "fonts, all files", value: fontBytes, unit: "B", ratchet: true },
];
check("bundle", metrics, { initial: [...initial], lazy, composition: parts });

function sizes(file: string): Sizes {
  const abs = join(DIST, file);
  const raw = readFileSync(abs);
  const pre = (suffix: string, make: () => Buffer) => (existsSync(abs + suffix) ? readFileSync(abs + suffix).length : Math.min(raw.length, make().length));
  return {
    raw: raw.length,
    br: pre(".br", () => brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })),
    zst: pre(".zst", () => zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: 19 } })),
    gz: pre(".gz", () => gzipSync(raw, { level: 9 })),
  };
}

/** Attributes built JS bytes to source packages using the source map. */
function composition(files: string[]): { name: string; raw: number; br: number }[] {
  const byPkg = new Map<string, string[]>();
  for (const file of files) {
    const mapPath = join(DIST, file + ".map");
    if (!existsSync(mapPath)) continue;
    const code = readFileSync(join(DIST, file), "utf8");
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as { sources: string[]; mappings: string };
    const lines = code.split("\n");
    srcState = 0;
    map.mappings.split(";").forEach((lineMap, li) => {
      const line = lines[li] ?? "";
      const segs = decodeLine(lineMap);
      for (let i = 0; i < segs.length; i++) {
        const [col, src] = segs[i]!;
        const end = segs[i + 1]?.[0] ?? line.length;
        const name = src === undefined ? "(no source)" : pkgName(map.sources[src] ?? "");
        let list = byPkg.get(name);
        if (!list) byPkg.set(name, (list = []));
        list.push(line.slice(col, end));
      }
    });
  }
  return [...byPkg]
    .map(([name, chunks]) => {
      const text = Buffer.from(chunks.join(""));
      return { name, raw: text.length, br: brotliCompressSync(text, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length };
    })
    .sort((a, b) => b.raw - a.raw);
}

function pkgName(source: string): string {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*node_modules\/)/.exec(source);
  if (m) return m[1]!;
  const local = /(apps|packages)\/([^/]+)\//.exec(source);
  return local ? `${local[1]}/${local[2]}` : source.replace(/^(\.\.\/)+/, "");
}

// VLQ decoder for source map v3: [column in the built file, source index].
function decodeLine(line: string): [number, number | undefined][] {
  const out: [number, number | undefined][] = [];
  let col = 0;
  for (const seg of line.split(",")) {
    if (!seg) continue;
    const v = vlq(seg);
    col += v[0]!;
    if (v.length >= 4) srcState += v[1]!;
    out.push([col, v.length >= 4 ? srcState : undefined]);
  }
  return out;
}

function vlq(s: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const ch of s) {
    const d = B64.get(ch)!;
    value += (d & 31) << shift;
    if (d & 32) {
      shift += 5;
      continue;
    }
    out.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return out;
}
