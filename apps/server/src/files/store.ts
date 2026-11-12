// Where file bytes live (PLNR-50). One small interface, so S3 can come later as a second implementation (the plan: "disk
// by default, S3 by choice"); today there is only the disk.
//
// Content-addressed: a file is named by the SHA-256 of its bytes, inside its workspace's directory. A name is checked
// against the bytes as they stream in, so a stored file is always what its name says; it never changes, so the browser
// caches it forever. The same file in two workspaces is two copies: dedupe stays inside a workspace, so asking whether a
// file exists tells nothing about anyone else's.
//
// Considered (docs/research/files-2026-10-30.md): bytea rows in Postgres (no new moving part, but every dump, restore
// and WAL carries the files) and an S3-compatible service (presigned uploads straight to it, but one more container and
// its own backup). The disk joins the production host's existing backup as one more directory.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** A byte range of a file, both ends included, as HTTP's Range header gives it. */
export interface ByteRange {
  start: number;
  end: number;
}

export class BlobError extends Error {
  readonly code: "too_large" | "hash_mismatch";
  constructor(code: BlobError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface BlobStore {
  /**
   * Streams `body` in as the file `sha256` of `space`. Resolves once the bytes are stored and their hash matched; throws
   * BlobError past `maxBytes` or on a mismatch, keeping nothing. `head` is the first bytes, for telling the file's type.
   */
  put(space: string, sha256: string, body: Readable, maxBytes: number): Promise<{ size: number; head: Buffer }>;
  /** The file's bytes, or a range of them. */
  get(space: string, sha256: string, range?: ByteRange): Readable;
  has(space: string, sha256: string): Promise<boolean>;
  delete(space: string, sha256: string): Promise<void>;
}

/**
 * Bytes kept for telling a file's type and an image's size (files/sniff.ts). A JPEG's size comes after its APPn segments
 * (EXIF with a thumbnail, ICC profile, maker notes: tens to a few hundred KB on a phone photo), so 64 bytes were not enough.
 */
const HEAD_BYTES = 512 * 1024;

/**
 * Files under `root`: `<space>/<first two hex digits>/<sha256>`, so no directory holds more than a few thousand. An upload
 * goes to `.tmp/` first and is renamed into place once its hash matched: a reader never sees half a file, and two uploads
 * of the same file at once both end in the same bytes.
 */
export class DiskBlobStore implements BlobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private path(space: string, sha256: string): string {
    return join(this.root, space, sha256.slice(0, 2), sha256);
  }

  async put(space: string, sha256: string, body: Readable, maxBytes: number): Promise<{ size: number; head: Buffer }> {
    const tmpDir = join(this.root, ".tmp");
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, randomUUID());
    const hash = createHash("sha256");
    let size = 0;
    // The head is collected as pieces and joined once: appending to one buffer per chunk copies it again each time, which
    // a client sending one byte at a time turns into quadratic work.
    const head: Buffer[] = [];
    let headLength = 0;
    const check = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > maxBytes) return done(new BlobError("too_large", `a file is at most ${maxBytes} bytes`));
        if (headLength < HEAD_BYTES) {
          head.push(Buffer.from(chunk.subarray(0, HEAD_BYTES - headLength)));
          headLength += head[head.length - 1]!.length;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    const file = await open(tmp, "wx", 0o600);
    try {
      await pipeline(body, check, file.createWriteStream());
      const got = hash.digest("hex");
      if (got !== sha256) throw new BlobError("hash_mismatch", `the bytes hash to ${got}, not ${sha256}`);
      const to = this.path(space, sha256);
      await mkdir(join(to, ".."), { recursive: true });
      await rename(tmp, to);
      return { size, head: Buffer.concat(head) };
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    } finally {
      await file.close().catch(() => {});
    }
  }

  get(space: string, sha256: string, range?: ByteRange): Readable {
    return createReadStream(this.path(space, sha256), range ? { start: range.start, end: range.end } : {});
  }

  async has(space: string, sha256: string): Promise<boolean> {
    return stat(this.path(space, sha256)).then(
      (s) => s.isFile(),
      () => false,
    );
  }

  async delete(space: string, sha256: string): Promise<void> {
    await rm(this.path(space, sha256), { force: true });
  }
}

/**
 * The store the server uses: RSVA_FILES_DIR (production sets it), else `.data/files` of the repository the server runs
 * in (the nearest directory up with pnpm-workspace.yaml: `pnpm dev` runs in apps/server), else of the working directory.
 */
export function blobStoreFromEnv(env: NodeJS.ProcessEnv = process.env): BlobStore {
  if (env.RSVA_FILES_DIR) return new DiskBlobStore(env.RSVA_FILES_DIR);
  let dir = process.cwd();
  while (!existsSync(join(dir, "pnpm-workspace.yaml")) && dirname(dir) !== dir) dir = dirname(dir);
  return new DiskBlobStore(join(existsSync(join(dir, "pnpm-workspace.yaml")) ? dir : process.cwd(), ".data/files"));
}
