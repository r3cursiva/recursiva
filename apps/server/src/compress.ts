// Compression for responses built per request (snapshot, descriptions, the agent API). Static files are precompressed
// (static.ts).
// brotli 5: on our snapshot it is within 1% of brotli 9 at half the CPU; brotli 11 is 16% smaller but 70x slower
// (docs/research/snapshot-2026-10-27.md).
import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import { brotliCompressSync, constants, createBrotliCompress, createGzip, gzipSync } from "node:zlib";

export type Encoding = "br" | "gzip" | null;

/** The encodings a client accepts: names lower-cased, those with q=0 left out. */
export function parseAcceptEncoding(header: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (header ?? "").split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (!name) continue;
    if (params.some((p) => /^\s*q=0(\.0*)?\s*$/.test(p))) continue;
    out.add(name.toLowerCase());
  }
  return out;
}

export function pickEncoding(accept: string | undefined): Encoding {
  const accepted = parseAcceptEncoding(accept);
  if (accepted.has("br")) return "br";
  if (accepted.has("gzip")) return "gzip";
  return null;
}

const BR = { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } };

export function compressStream(src: Readable, enc: Encoding): Readable {
  if (enc === "br") return src.pipe(createBrotliCompress(BR));
  if (enc === "gzip") return src.pipe(createGzip({ level: 6 }));
  return src;
}

/**
 * A body over 1 KB in the encoding asked for; a smaller one gains less than its headers cost. gzip is for clients that do
 * not ask for brotli: Node's fetch sends "gzip, deflate".
 */
function compressBody(body: string, enc: Encoding): Buffer | string {
  if (!enc || body.length <= 1024) return body;
  return enc === "br" ? brotliCompressSync(body, BR) : gzipSync(body, { level: 6 });
}

/**
 * The one compression path for JSON built per request (the sync routes and the agent API): an onSend hook for the whole
 * app. Only string JSON bodies are touched; streams, buffers (the snapshot, static files) and other types pass as they are.
 */
export function compressJsonResponses(app: FastifyInstance): void {
  app.addHook("onSend", async (req, reply, payload) => {
    if (typeof payload !== "string" || reply.getHeader("content-encoding")) return payload;
    if (!String(reply.getHeader("content-type") ?? "").startsWith("application/json")) return payload;
    reply.header("vary", "accept-encoding");
    const enc = pickEncoding(req.headers["accept-encoding"]);
    const body = compressBody(payload, enc);
    if (typeof body === "string") return payload;
    reply.header("content-encoding", enc!).removeHeader("content-length");
    return body;
  });
}
