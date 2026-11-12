// Files of a workspace (PLNR-50): `PUT /files/:ws/:sha256` uploads, `GET` (and `HEAD`, which Fastify answers from the
// same route) reads. The browser hashes a file before it uploads it and asks HEAD first, so a file the workspace already
// has costs one request and no bytes.
//
// Access is the workspace's: a member reads and, with issues.write, uploads. Anyone else, signed in or not, gets 404, as
// for a file that does not exist, so an address tells nobody outside the workspace anything.
//
// What a file can do in the browser is cut down to nothing but showing an image: every response carries `CSP: sandbox`
// (no script, no same-origin rights even if the browser renders it), nosniff, and same-origin CORP; only a raster image
// whose bytes prove it (files/sniff.ts) is served inline, everything else (SVG and HTML included) as a download, typed
// application/octet-stream: a file declared text/javascript or text/css must not load as a same-origin script or
// stylesheet, which `script-src 'self'` would allow (the upload keeps its declared type only as the name of what it is).
import { can, GRANT_NAMES, refusal } from "@rsva/policy";
import { FILE_MAX, IMAGE_TYPES, SHA256 } from "@rsva/schema/models";
import { and, eq, sum } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { accessBySlug } from "../auth/access.ts";
import { requireActor } from "../auth/routes.ts";
import { db, schema } from "../db.ts";
import { uploads } from "../sync/limits.ts";
import { fileType } from "./sniff.ts";
import { BlobError, type BlobStore, type ByteRange } from "./store.ts";

const { blob } = schema;

type Params = { ws: string; sha: string };

/** All files of one workspace together, bytes; RSVA_WORKSPACE_FILES_MAX overrides it. */
const WORKSPACE_FILES_MAX = Number(process.env.RSVA_WORKSPACE_FILES_MAX) || 10 * 2 ** 30;

/** Cached for a year and never revalidated: the address is the content. `private`: only the member's own browser keeps it. */
export const IMMUTABLE = "private, max-age=31536000, immutable";
/** A file is a document of its own, with no rights in the app: no script, no plugins, no requests, no framing. */
export const FILE_CSP = "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'";

/** Why a file was not stored, as the upload answers it. */
export class StoreError extends Error {
  readonly status: 400 | 411 | 413 | 429;
  readonly code: string;
  readonly retryAfter: number | undefined;
  constructor(status: StoreError["status"], code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * Stores `length` bytes as the workspace's file `sha` for `userId`, after the workspace's quota and the person's upload
 * budget: the browser's upload and a photo sent to the bot (PLNR-205) go this one way. A file the workspace has is not
 * read again, so it needs no length. `budgetTaken`: the caller took the upload budget before it had the bytes.
 */
export async function storeFile(store: BlobStore, workspaceId: string, userId: string, sha: string, body: Readable, length: number, contentType: string | undefined, budgetTaken = false) {
  const [had] = await db.select({ size: blob.size, mime: blob.mime }).from(blob).where(and(eq(blob.workspaceId, workspaceId), eq(blob.sha256, sha)));
  if (had) return { created: false, ...had };
  if (!Number.isSafeInteger(length) || length < 0) throw new StoreError(411, "length_required", "send the file with a Content-Length");
  if (length > FILE_MAX) throw new StoreError(413, "too_large", `a file is at most ${FILE_MAX} bytes`);
  const [used] = await db.select({ n: sum(blob.size).mapWith(Number) }).from(blob).where(eq(blob.workspaceId, workspaceId));
  if ((used?.n ?? 0) + length > WORKSPACE_FILES_MAX) throw new StoreError(413, "quota", `the workspace's files are over ${WORKSPACE_FILES_MAX} bytes`);
  if (!budgetTaken && !uploads.take(userId, length)) throw new StoreError(429, "rate_limited", "too many uploads", uploads.retryAfter(userId, length));
  let put: { size: number; head: Buffer };
  try {
    put = await store.put(workspaceId, sha, body, Math.min(length, FILE_MAX));
  } catch (e) {
    if (!(e instanceof BlobError)) throw e;
    throw new StoreError(e.code === "too_large" ? 413 : 400, e.code, e.message);
  }
  const mime = fileType(put.head, contentType);
  await db.insert(blob).values({ workspaceId, sha256: sha, size: put.size, mime, createdById: userId }).onConflictDoNothing();
  return { created: true, size: put.size, mime };
}

/** `filename` for Content-Disposition: an ASCII fallback and the UTF-8 name (RFC 6266, RFC 8187). */
export function dispositionName(raw: string): string {
  const name = raw.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, 255) || "file";
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["%;]/g, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** One `bytes=a-b` range within `size`; null for none, "bad" for one that cannot be served (several, or out of the file). */
function byteRange(header: string | undefined, size: number): ByteRange | null | "bad" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return "bad";
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : "bad";
}

export function registerFileRoutes(root: FastifyInstance, store: BlobStore): void {
  void root.register(async (app) => {
    // The body of an upload is the file itself, of any type: the handler streams it; nothing parses it as JSON or form.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    // Runs after the app's own onSend (a child scope's hooks come after its parent's): the file's policy replaces the page's.
    app.addHook("onSend", async (_req, reply) => {
      reply.header("content-security-policy", FILE_CSP).header("cross-origin-resource-policy", "same-origin");
    });

    /** The workspace when the actor is a member, else null after a 404. */
    const member = async (req: FastifyRequest<{ Params: Params }>, reply: FastifyReply) => {
      if (!SHA256.test(req.params.sha)) return void reply.code(404).send({ error: "not_found" });
      const a = await accessBySlug(req.actor!, req.params.ws);
      if ("status" in a) return void reply.code(404).send({ error: "not_found" });
      return a;
    };

    app.get<{ Params: Params; Querystring: { name?: string } }>("/files/:ws/:sha", { preHandler: requireActor({ hidden: true }) }, async (req, reply) => {
      const a = await member(req, reply);
      if (!a) return reply;
      const [row] = await db.select({ size: blob.size, mime: blob.mime }).from(blob).where(and(eq(blob.workspaceId, a.workspaceId), eq(blob.sha256, req.params.sha)));
      if (!row) return reply.code(404).send({ error: "not_found" });
      const etag = `"${req.params.sha}"`;
      const image = IMAGE_TYPES.has(row.mime);
      reply
        .header("cache-control", IMMUTABLE)
        .header("etag", etag)
        .header("accept-ranges", "bytes")
        .header("content-type", image ? row.mime : "application/octet-stream")
        .header("content-disposition", `${image ? "inline" : "attachment"}; ${dispositionName(req.query.name ?? req.params.sha)}`);
      if (req.headers["if-none-match"] === etag) return reply.code(304).send();
      const range = byteRange(req.headers.range, row.size);
      if (range === "bad") return reply.code(416).header("content-range", `bytes */${row.size}`).send();
      if (req.method === "HEAD") return reply.header("content-length", row.size).send();
      if (!range) return reply.header("content-length", row.size).send(store.get(a.workspaceId, req.params.sha));
      return reply
        .code(206)
        .header("content-range", `bytes ${range.start}-${range.end}/${row.size}`)
        .header("content-length", range.end - range.start + 1)
        .send(store.get(a.workspaceId, req.params.sha, range));
    });

    app.put<{ Params: Params }>("/files/:ws/:sha", { preHandler: requireActor({ hidden: true }) }, async (req, reply) => {
      const a = await member(req, reply);
      if (!a) return reply;
      // An upload attaches nothing by itself: a file goes on an issue (issues.write) or into a comment's text (comments.write).
      if (!can(a.viewer, "issues.write") && !can(a.viewer, "comments.write"))
        return reply.code(403).send({ error: "forbidden", message: a.viewer.scope === "custom" ? `the token lacks ${GRANT_NAMES["issues.write"]} or ${GRANT_NAMES["comments.write"]}` : refusal(a.viewer, "issues.write", "upload files") });
      const sha = req.params.sha;
      const length = req.headers["content-length"] ? Number(req.headers["content-length"]) : NaN;
      try {
        const { created, size, mime } = await storeFile(store, a.workspaceId, req.actor!.userId, sha, req.body as Readable, length, req.headers["content-type"]);
        return reply.code(created ? 201 : 200).send({ ok: true, sha256: sha, size, mime });
      } catch (e) {
        if (!(e instanceof StoreError)) throw e;
        if (e.retryAfter !== undefined) reply.header("retry-after", String(e.retryAfter));
        return reply.code(e.status).send({ error: e.code, message: e.message });
      }
    });
  });
}
