// Shell build plugin:
// 1. A Service Worker with the list of build files, so a repeat launch does not wait for the network.
// 2. The Latin Onest file precached and, on a load the worker controls, preloaded from its cache: it is
//    `font-display: optional` (globals.css), so that load paints in Onest from the first frame, and a first visit keeps
//    the system font instead of swapping to Onest a moment later (PLNR-209).
// 3. Every text file precompressed (brotli 11, zstd 19, gzip 9): the server serves them as is, at levels higher than
//    on-the-fly compression. Measured on Plane's bundles: brotli 11 is 19% smaller than Caddy's zstd.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { brotliCompressSync, constants, gzipSync, zstdCompressSync } from "node:zlib";
import { PRECOMPRESSED, SERVER_PATHS } from "@rsva/schema/models";
import type { Plugin, ResolvedConfig } from "vite";

/**
 * The one font file every screen needs: the interface is in English. Requested from CSS, it starts only after the CSS
 * is parsed and the page laid out (1554 ms against 661 ms for the CSS on a cold load), too late for the first text.
 * A preload would fix that but costs the cold start ~290 ms on a 120 KB/s line (perf:net: shell 2069 → 2361 ms), since
 * no text is painted before the JS runs anyway. So it is preloaded only when the Service Worker controls the page and
 * has it precached: no bytes on the network. Chrome waits for a preloaded `optional` font; one that is not preloaded it
 * does not even wait for from the worker's cache (checked: the text stayed in the system font with the file served in
 * 1 ms). Other subsets (Cyrillic, Latin Extended, mono) stay on demand.
 */
export const FIRST_FONT = /^onest-latin-wght-normal-[\w-]+\.woff2$/;

const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg", ".json", ".webmanifest", ".txt"]);

/** Each copy of PRECOMPRESSED at its highest level. */
const COMPRESS: Record<(typeof PRECOMPRESSED)[number][0], (raw: Buffer) => Buffer> = {
  br: (raw) => brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
  zstd: (raw) => zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: 19 } }),
  gzip: (raw) => gzipSync(raw, { level: 9 }),
};

export function shell(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "rsva-shell",
    apply: "build",
    configResolved(c) {
      config = c;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const font = Object.keys(ctx.bundle ?? {}).find((f) => FIRST_FONT.test(f.split("/").pop()!));
        if (!font) throw new Error(`rsva-shell: no font matches ${FIRST_FONT}, so none would be preloaded`);
        // The server allows the inline script by its hash, computed from the built page (apps/server/src/headers.ts).
        return [{ tag: "script", children: firstFontPreload(config.base + font), injectTo: "head" }];
      },
    },
    closeBundle() {
      const out = config.build.outDir;
      const files = [...walk(out)].map((p) => "/" + relative(out, p).split(sep).join("/"));
      // Of the fonts only FIRST_FONT is precached: the others are needed by unicode-range, a few at most, and
      // are cached on first use. Nor is what only an installed app's icon needs.
      const shellFiles = files.filter(
        (f) =>
          f !== "/sw.js" &&
          !f.startsWith("/.vite/") &&
          !f.endsWith(".map") &&
          (!f.endsWith(".woff2") || FIRST_FONT.test(f.split("/").pop()!)) &&
          !f.endsWith(".png") &&
          !f.endsWith(".webmanifest"),
      );
      const version = createHash("sha256")
        .update(shellFiles.map((f) => f + ":" + statSync(join(out, f)).size).join("\n"))
        .update(readFileSync(join(out, "index.html")))
        .digest("base64url")
        .slice(0, 12);
      writeFileSync(join(out, "sw.js"), serviceWorker(version, shellFiles));

      for (const abs of walk(out)) {
        if (!COMPRESSIBLE.has(extname(abs)) || abs.includes(`${sep}.vite${sep}`)) continue;
        const raw = readFileSync(abs);
        for (const [encoding, suffix] of PRECOMPRESSED) {
          const body = COMPRESS[encoding](raw);
          if (body.length < raw.length) writeFileSync(abs + suffix, body);
        }
      }
    },
  };
}

/** The preload of the first font, only on a load the Service Worker controls: it has the file precached. */
export function firstFontPreload(href: string): string {
  return `navigator.serviceWorker?.controller&&document.head.append(Object.assign(document.createElement("link"),{rel:"preload",as:"font",type:"font/woff2",crossOrigin:"anonymous",href:${JSON.stringify(href)}}))`;
}

export function serviceWorker(version: string, files: string[]): string {
  // Navigation to an app route gets the shell from cache; the server's own paths (a file opened in a new tab, a sign-in
  // link) go to the network. /assets/ files are immutable (hash in the name) and cached forever, and those not fetched
  // at install (fonts other than the first one) are cached on first request.
  // A new version installs in the background and takes over open tabs at once (skipWaiting, clients.claim): a tab reloads
  // into it at a moment that interrupts nobody (src/lib/new-version.ts), and before that, if a lazy chunk it asks for is
  // gone (src/screens/load-edit-chunk.ts).
  return `const V=${JSON.stringify(version)},F=${JSON.stringify(files.filter((f) => f !== "/index.html"))},P=${JSON.stringify(SERVER_PATHS)};
self.addEventListener("install",e=>e.waitUntil(caches.open(V).then(c=>c.addAll(["/",...F])).then(()=>self.skipWaiting())));
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(n=>n!==V).map(n=>caches.delete(n)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",e=>{const r=e.request;if(r.method!=="GET")return;const u=new URL(r.url);if(u.origin!==location.origin)return;
if(r.mode==="navigate"){if(P.includes(u.pathname.split("/")[1]))return;e.respondWith(caches.match("/",{cacheName:V}).then(m=>m||fetch(r)));return}
if(u.pathname.startsWith("/assets/"))e.respondWith(caches.match(r,{cacheName:V}).then(m=>m||fetch(r).then(res=>{if(res.ok){const c=res.clone();caches.open(V).then(x=>x.put(r,c))}return res})))});
`;
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile() && !PRECOMPRESSED.some(([, suffix]) => e.name.endsWith(suffix))) yield join(e.parentPath, e.name);
  }
}
