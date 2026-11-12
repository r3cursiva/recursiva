// Profile pictures (PLNR-244): `PUT /auth/me/picture` sets the signed-in person's, `DELETE` takes it away, and
// `GET /pictures/<sha256>` serves one.
//
// The browser cuts and encodes the picture (apps/web/src/screens/picture-editor.tsx): one square of PICTURE_SIDE pixels,
// WebP or JPEG, tens of KB. The server only checks it: a PNG, JPEG or WebP by its bytes, at most PICTURE_MAX bytes and
// PICTURE_PIXELS_MAX pixels a side (files/sniff.ts reads the header; nothing here decodes an image), so a small file
// that would take a gigabyte to draw never reaches anyone's avatars.
//
// One picture per person, the same in every workspace: `user.picture` holds its hash and reaches the clients as the name
// does (account.ts), the bytes are a row of `user_picture`. Considered: the workspace's files (files/routes.ts), one copy
// per workspace and a change in each; and a data: URL in the user row, which every snapshot would carry for every member.
//
// A picture is read by the person and whoever shares a workspace with them (a token: in the token's workspace); anyone
// else gets 404, as for a picture that does not exist. Its address is its content: cached for good, never revalidated.
import { PICTURE_MAX, SHA256 } from "@rsva/schema/models";
import { and, eq, exists, or, sql as dsql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { db, schema } from "../db.ts";
import { FILE_CSP, IMMUTABLE } from "../files/routes.ts";
import { imageSize, sniffImage } from "../files/sniff.ts";
import { uploads } from "../sync/limits.ts";
import { changeOwnRow } from "./account.ts";
import { requireActor } from "./routes.ts";

const { member, user, userPicture } = schema;

/** Types a picture may be: what a canvas encodes. */
const PICTURE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Largest side the server takes, pixels: room for a picture made elsewhere than this app's editor. */
const PICTURE_PIXELS_MAX = 1024;

/** Sets the person's picture (`bytes` hashing to `sha256`), or takes it away with null. */
async function setPicture(userId: string, picture: { sha256: string; bytes: Buffer } | null): Promise<void> {
  await changeOwnRow(userId, async (tx) => {
    const [u] = await tx.select({ picture: user.picture }).from(user).where(eq(user.id, userId)).for("no key update");
    const to = picture?.sha256 ?? null;
    if (u!.picture === to) return null;
    if (picture) {
      await tx
        .insert(userPicture)
        .values({ userId, ...picture })
        .onConflictDoUpdate({ target: userPicture.userId, set: { ...picture, createdAt: dsql`now()` } });
    } else await tx.delete(userPicture).where(eq(userPicture.userId, userId));
    await tx.update(user).set({ picture: to }).where(eq(user.id, userId));
    return { d: { picture: to }, p: { picture: u!.picture } };
  });
}

export function registerPictureRoutes(root: FastifyInstance): void {
  void root.register(async (app) => {
    // The body of an upload is the image itself; Fastify answers 413 past the limit.
    app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: PICTURE_MAX }, (_req, body, done) => done(null, body));

    app.put<{ Body: Buffer }>("/auth/me/picture", { preHandler: requireActor({ sessionOnly: true }) }, async (req, reply) => {
      const bytes = req.body;
      if (!Buffer.isBuffer(bytes)) return reply.code(415).send({ error: "unsupported_media_type", message: "send the picture as image/webp, image/jpeg or image/png" });
      const size = imageSize(bytes);
      if (!size || !PICTURE_TYPES.has(sniffImage(bytes)!)) return reply.code(400).send({ error: "invalid", message: "a picture is a PNG, JPEG or WebP image" });
      if (size.width > PICTURE_PIXELS_MAX || size.height > PICTURE_PIXELS_MAX)
        return reply.code(400).send({ error: "invalid", message: `a picture is at most ${PICTURE_PIXELS_MAX} × ${PICTURE_PIXELS_MAX} pixels` });
      const me = req.actor!.userId;
      if (!uploads.take(me, bytes.length)) return reply.code(429).header("retry-after", String(uploads.retryAfter(me, bytes.length))).send({ error: "rate_limited", message: "too many uploads" });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await setPicture(me, { sha256, bytes });
      return { picture: sha256 };
    });

    app.delete("/auth/me/picture", { preHandler: requireActor({ sessionOnly: true }) }, async (req) => {
      await setPicture(req.actor!.userId, null);
      return { picture: null };
    });

    app.get<{ Params: { sha: string } }>("/pictures/:sha", { preHandler: requireActor({ hidden: true }) }, async (req, reply) => {
      const { sha } = req.params;
      if (!SHA256.test(sha)) return reply.code(404).send({ error: "not_found" });
      const actor = req.actor!;
      const mine = alias(member, "mine");
      const theirs = alias(member, "theirs");
      const shared = db
        .select({ x: mine.userId })
        .from(mine)
        .innerJoin(theirs, eq(theirs.workspaceId, mine.workspaceId))
        .where(and(eq(mine.userId, actor.userId), eq(theirs.userId, userPicture.userId), actor.token ? eq(mine.workspaceId, actor.token.workspaceId) : undefined));
      const [row] = await db
        .select({ bytes: userPicture.bytes })
        .from(userPicture)
        .where(and(eq(userPicture.sha256, sha), or(actor.token ? undefined : eq(userPicture.userId, actor.userId), exists(shared))))
        .limit(1);
      if (!row) return reply.code(404).send({ error: "not_found" });
      // postgres.js reads bytea as a Buffer; the schema types it as the Uint8Array it is, for the browser's packages.
      const bytes = Buffer.from(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength);
      const etag = `"${sha}"`;
      reply
        .header("cache-control", IMMUTABLE)
        .header("etag", etag)
        .header("content-type", sniffImage(bytes)!)
        .header("content-disposition", "inline")
        .header("content-security-policy", FILE_CSP)
        .header("cross-origin-resource-policy", "same-origin");
      if (req.headers["if-none-match"] === etag) return reply.code(304).send();
      return reply.header("content-length", bytes.length).send(bytes);
    });
  });
}
