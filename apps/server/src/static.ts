// Serves the built UI. Files are compressed at build time (brotli 11, zstd 19, gzip 9) and kept in memory:
// no disk reads and no on-the-fly compression per request. We serve the smallest variant the browser accepts.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { PRECOMPRESSED } from "@rsva/schema/models";
import { parseAcceptEncoding } from "./compress.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

type Encoding = (typeof PRECOMPRESSED)[number][0];

const isCompressedCopy = (ext: string) => PRECOMPRESSED.some(([, suffix]) => suffix === ext);

interface Variant {
  encoding: Encoding | null;
  body: Buffer;
}

export interface StaticFile {
  type: string;
  etag: string;
  cacheControl: string;
  /** Smallest first; the last one is uncompressed. */
  variants: Variant[];
}

export function loadStatic(root: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  for (const abs of walk(root)) {
    const ext = extname(abs);
    // Source maps and the build manifest are for the checks, not the browser.
    if (isCompressedCopy(ext) || ext === ".map") continue;
    if (abs.includes(`${sep}.vite${sep}`)) continue;
    const url = "/" + relative(root, abs).split(sep).join("/");
    const body = readFileSync(abs);
    const variants: Variant[] = [{ encoding: null, body }];
    for (const [encoding, suffix] of PRECOMPRESSED) {
      try {
        variants.push({ encoding, body: readFileSync(abs + suffix) });
      } catch {}
    }
    variants.sort((a, b) => a.body.length - b.body.length);
    files.set(url, {
      type: TYPES[ext] ?? "application/octet-stream",
      etag: '"' + createHash("sha256").update(body).digest("base64url").slice(0, 16) + '"',
      // Names under /assets/ contain a content hash, so they can be cached forever.
      cacheControl: url.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      variants,
    });
  }
  return files;
}

export function pickVariant(file: StaticFile, acceptEncoding: string | undefined): Variant {
  const accepted = parseAcceptEncoding(acceptEncoding);
  for (const v of file.variants) {
    if (v.encoding === null || accepted.has(v.encoding)) return v;
  }
  // The uncompressed variant always exists; unreachable.
  return file.variants.at(-1)!;
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) yield join(e.parentPath, e.name);
  }
}
