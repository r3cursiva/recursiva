// Uploading a file of the workspace (PLNR-50): hash it here, ask the server whether it has it (HEAD), and only if not
// send the bytes (PUT). The address is the hash, so a file pasted twice, or into two issues, goes over the network once.
//
// Images shrink first: a screenshot of a Retina screen is 3–6 MB of PNG; as WebP at its longest side of 2560 px it is
// usually a few hundred KB. Only when that saves a fifth or more: a small PNG of a diagram stays as it is. Hold Alt while
// dropping or pasting, or pick files with Alt, to upload originals. Animated GIFs never shrink (a canvas keeps one frame).
import { FILE_MAX, filePath, IMAGE_TYPES } from "@rsva/schema/models";
import { holdReloadFor } from "./new-version.ts";

export interface Uploaded {
  sha256: string;
  size: number;
  mime: string;
  /** The file's name; a shrunk image's extension becomes .webp. */
  name: string;
  /** Where it is served: an image's `src`. */
  src: string;
}

class UploadError extends Error {}

/** Longest side of a shrunk image, pixels. */
const SHRINK_SIDE = 2560;
const SHRINK_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const WEBP_QUALITY = 0.9;

/** The image as WebP no larger than SHRINK_SIDE, or the file itself when that does not pay (or the browser cannot). */
async function shrink(file: File): Promise<File> {
  if (!SHRINK_TYPES.has(file.type) || typeof OffscreenCanvas === "undefined") return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, SHRINK_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const out = await canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
    // Safari has no WebP encoder and hands back PNG: keep the original then.
    if (out.type !== "image/webp" || out.size > file.size * 0.8) return file;
    return new File([out], file.name.replace(/\.[^.]*$/, "") + ".webp", { type: "image/webp" });
  } catch {
    return file;
  }
}

async function sha256(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Uploads one file to the workspace, unless it is there already; `original` skips shrinking. A reload waits for it. */
export function uploadFile(slug: string, picked: File, opts: { original?: boolean } = {}): Promise<Uploaded> {
  return holdReloadFor(upload(slug, picked, opts));
}

async function upload(slug: string, picked: File, opts: { original?: boolean }): Promise<Uploaded> {
  const file = opts.original ? picked : await shrink(picked);
  if (file.size > FILE_MAX) throw new UploadError(`${picked.name} is over ${FILE_MAX / 2 ** 20} MB`);
  const hash = await sha256(file);
  const url = filePath(slug, hash);
  const done = (size: number, mime: string): Uploaded => ({ sha256: hash, size, mime, name: file.name || "file", src: url });
  const head = await fetch(url, { method: "HEAD", credentials: "same-origin" });
  if (head.ok) return done(Number(head.headers.get("content-length")) || file.size, head.headers.get("content-type") ?? file.type);
  const put = await fetch(url, { method: "PUT", body: file, credentials: "same-origin", headers: { "content-type": file.type || "application/octet-stream" } });
  const body = (await put.json().catch(() => ({}))) as { size?: number; mime?: string; message?: string };
  if (!put.ok) throw new UploadError(body.message ?? `${picked.name} did not upload (${put.status})`);
  return done(body.size ?? file.size, body.mime ?? "application/octet-stream");
}

/** Shown as an image (and served inline): the type the server proved from the bytes. */
export const isImage = (mime: string | null | undefined): boolean => !!mime && IMAGE_TYPES.has(mime);

/** "12 KB", "3.4 MB". */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

/** Whether Alt is held: drops and pastes with it upload originals. Read from the last key or pointer event. */
let alt = false;
if (typeof window !== "undefined") {
  for (const t of ["keydown", "keyup", "pointerdown", "dragover"] as const) window.addEventListener(t, (e) => (alt = (e as KeyboardEvent).altKey), { capture: true, passive: true });
}
export const altHeld = (): boolean => alt;
