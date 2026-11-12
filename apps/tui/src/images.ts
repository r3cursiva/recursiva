// Images of a description or a comment on the issue screen (PLNR-327), drawn with the kitty graphics protocol: Rex,
// Ghostty and kitty speak it (Rex answered a=q, a transmit, a cropped placement and a virtual one OK, 2026-11-06).
// An image is fetched once with the TUI's credential, made a PNG of at most MAX_PX by `sips` when it is not one or is
// larger, sent to the terminal once, and placed over the blank rows the layout keeps for it. A frame places what is in
// view, crops what the scroll cuts, and deletes what left; a row the grid wrote again gets its image placed again.
//
// Considered (2026-11-06):
// - Unicode placeholders (U=1): the cells carry the image, so the grid's diff scrolls it and a panel covers it with no
//   bookkeeping; but a row's number is a diacritic from kitty's table of 297, which cannot be checked here without
//   seeing the screen, and one wrong entry shifts every row after it.
// - Half blocks in 24-bit colour: any terminal, two pixels a cell; needs the pixels, a later fallback.
// Placements over the grid need neither: what they need, Rex confirmed.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFilePath } from "@rsva/schema/models";

/** A cell's size in pixels, as Rex reports it (CSI 16 t: 8 × 16). Only the ratio matters: c and r scale the image. */
const CELL_W = 8;
const CELL_H = 16;
/** The most rows an image takes: a tall screenshot narrows to keep its shape. */
const MAX_ROWS = 24;
/** The longest side sent to the terminal: a screenshot of a whole screen is cut down once, not sent whole. */
const MAX_PX = 1200;
/** Base64 bytes in one escape sequence, as the protocol asks. */
const CHUNK = 4096;

/**
 * The loader of the issue screen's images (RSVA-477): a file of the workspace on this server, fetched with the run's
 * credential. As the web draws an image only when its source is such a file (packages/editor/src/render.ts, and the
 * page's CSP keeps img-src to 'self'), so here: any other source, another host's above all, is not fetched, so the
 * credential never leaves for it. The origin is compared as URL parses it, not as a string's prefix; a redirect fails
 * the load, as Client.send's do, rather than be followed with the credential (Node drops it only across origins).
 */
export function serverImages(origin: string, authorization: string, get: typeof fetch = fetch): (src: string) => Promise<Uint8Array> {
  const own = new URL(origin).origin;
  return async (src) => {
    const url = readFilePath(src) ? new URL(src, own) : null;
    if (url?.origin !== own) throw new Error("not a file of this server");
    const res = await get(url, { headers: { authorization }, redirect: "error" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

/** Whether this terminal draws kitty graphics. RSVA_TUI_IMAGES=0 or 1 decides; inside tmux the escapes do not pass. */
export function imagesOn(env: Record<string, string | undefined>): boolean {
  if (env.RSVA_TUI_IMAGES === "0" || env.RSVA_TUI_IMAGES === "1") return env.RSVA_TUI_IMAGES === "1";
  if (env.TMUX) return false;
  return ["rex", "ghostty"].includes(env.TERM_PROGRAM ?? "") || env.TERM === "xterm-kitty" || !!env.KITTY_WINDOW_ID;
}

/** The size in cells of an image `w` × `h` pixels in `room` columns: as wide as it is, at most the room, MAX_ROWS high. */
export function fitCells(w: number, h: number, room: number): { cols: number; rows: number } {
  let cols = Math.max(1, Math.min(room, Math.ceil(w / CELL_W)));
  let rows = Math.max(1, Math.round((cols * CELL_W * h) / w / CELL_H));
  if (rows > MAX_ROWS) {
    rows = MAX_ROWS;
    cols = Math.max(1, Math.min(room, Math.round((rows * CELL_H * w) / h / CELL_W)));
  }
  return { cols, rows };
}

/** A PNG's width and height from its IHDR; null for anything else. */
export function pngSize(b: Uint8Array): { w: number; h: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || sig.some((x, i) => b[i] !== x)) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

const sips = (args: string[]) => new Promise<string>((resolve, reject) => execFile("sips", args, (err, out) => (err ? reject(err) : resolve(out))));

/** The bytes as a PNG of at most MAX_PX a side, with the original's size: `sips` (macOS) when it is not one or larger. */
async function asPng(bytes: Uint8Array): Promise<{ png: Uint8Array; w: number; h: number }> {
  const size = pngSize(bytes);
  if (size && Math.max(size.w, size.h) <= MAX_PX) return { png: bytes, ...size };
  // In a folder of this user only: the image may say what its issue says.
  const dir = await mkdtemp(join(tmpdir(), "rsva-tui-image-"));
  try {
    const src = join(dir, "in");
    const out = join(dir, "out.png");
    await writeFile(src, bytes, { mode: 0o600 });
    const dims = /pixelWidth: (\d+)[\s\S]*pixelHeight: (\d+)/.exec(await sips(["-g", "pixelWidth", "-g", "pixelHeight", src]));
    if (!dims) throw new Error("not an image");
    const [w, h] = [Number(dims[1]), Number(dims[2])];
    await sips(["-s", "format", "png", ...(Math.max(w, h) > MAX_PX ? ["-Z", String(MAX_PX)] : []), src, "--out", out]);
    return { png: await readFile(out), w, h };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Where an image goes on this frame: its cells, and which of its rows the scroll leaves in view. */
export interface Placement {
  src: string;
  x: number;
  y: number;
  cols: number;
  /** All its rows, and from `skip` the `shown` ones on screen. */
  rows: number;
  skip: number;
  shown: number;
}

const apc = (params: string, data = "") => `\x1b_G${params}${data ? `;${data}` : ""}\x1b\\`;

/** The escapes that send a PNG as image `id`, in chunks; no answer is asked for (q=2), so none reaches the keys. */
function transmit(id: number, png: Uint8Array): string {
  const b64 = Buffer.from(png).toString("base64");
  let out = "";
  for (let at = 0; at < b64.length; at += CHUNK) {
    const more = at + CHUNK < b64.length ? 1 : 0;
    out += apc(`${at ? "" : `a=t,f=100,t=d,i=${id},q=2,`}m=${more}`, b64.slice(at, at + CHUNK));
  }
  return out;
}

/** The escape that puts placement `p` of image `id` at the cursor: `shown` rows of it, cropped to them, the cursor kept. */
function placeEscape(id: number, p: number, at: Placement, size: { w: number; h: number }): string {
  const crop = at.skip || at.shown < at.rows ? `,x=0,y=${Math.floor((at.skip / at.rows) * size.h)},w=${size.w},h=${Math.max(1, Math.round((at.shown / at.rows) * size.h))}` : "";
  return `\x1b[${at.y + 1};${at.x + 1}H${apc(`a=p,i=${id},p=${p},c=${at.cols},r=${at.shown}${crop},C=1,q=2`)}`;
}

interface Entry {
  state: "loading" | "ready" | "failed";
  id: number;
  png?: Uint8Array;
  /** The original's size, for the layout; the sent PNG's, for a crop. */
  w: number;
  h: number;
  sent: { w: number; h: number } | null;
}

/** The images of one run: fetched, sent and placed as the frames ask. */
export class Pictures {
  private readonly entries = new Map<string, Entry>();
  /** What is on the screen now, by "id:p": the escape that placed it. */
  private placed = new Map<string, string>();
  private next = 1;
  private readonly load: (src: string) => Promise<Uint8Array>;
  private readonly loaded: () => void;

  /** `load` fetches a source's bytes; `loaded` is called when one is ready or failed, to draw again. */
  constructor(load: (src: string) => Promise<Uint8Array>, loaded: () => void) {
    this.load = load;
    this.loaded = loaded;
  }

  /** Its size in `room` columns once it is here; null while it loads or when it failed (the layout shows its caption). */
  size(src: string, room: number): { cols: number; rows: number } | null {
    let e = this.entries.get(src);
    if (!e) {
      e = { state: "loading", id: this.next++, w: 0, h: 0, sent: null };
      this.entries.set(src, e);
      const entry = e;
      this.load(src)
        .then(asPng)
        .then(
          ({ png, w, h }) => Object.assign(entry, { state: "ready", png, w, h }),
          () => (entry.state = "failed"),
        )
        .then(this.loaded);
    }
    return e.state === "ready" ? fitCells(e.w, e.h, room) : null;
  }

  /**
   * The escapes for a frame: send what is new, place what moved or sits on a row the grid wrote again (`changed`),
   * delete what left. An empty list takes every image off the screen (a panel over it, another screen).
   */
  frame(list: readonly Placement[], changed: ReadonlySet<number> = new Set()): string {
    let out = "";
    const now = new Map<string, string>();
    const count = new Map<number, number>();
    for (const at of list) {
      const e = this.entries.get(at.src);
      if (e?.state !== "ready" || !e.png) continue;
      if (!e.sent) {
        out += transmit(e.id, e.png);
        e.sent = pngSize(e.png) ?? { w: e.w, h: e.h };
      }
      const p = (count.get(e.id) ?? 0) + 1;
      count.set(e.id, p);
      const key = `${e.id}:${p}`;
      const esc = placeEscape(e.id, p, at, e.sent);
      now.set(key, esc);
      const rewritten = [...changed].some((y) => y >= at.y && y < at.y + at.shown);
      if (this.placed.get(key) !== esc || rewritten) out += esc;
    }
    for (const key of this.placed.keys()) if (!now.has(key)) out += this.remove(key);
    this.placed = now;
    return out;
  }

  /** Takes every placement off: the screen is about to be left or drawn whole. */
  clear(): string {
    return this.frame([]);
  }

  /** Takes the images off and frees them in the terminal: the run ends. */
  free(): string {
    let out = this.clear();
    for (const e of this.entries.values())
      if (e.sent) {
        out += apc(`a=d,d=I,i=${e.id},q=2`);
        e.sent = null;
      }
    return out;
  }

  private remove(key: string): string {
    const [id, p] = key.split(":");
    return apc(`a=d,d=i,i=${id},p=${p},q=2`);
  }
}
