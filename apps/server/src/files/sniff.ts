// What type a file is served as. Only a raster image is ever shown in the page or opened inline, and only when its bytes
// start like that image: a "PNG" that is really HTML is served as a download. Every other file keeps the type its
// uploader declared, as a name for what it is (the list of files, the agent API); it is served as application/octet-stream
// (files/routes.ts), never as something the browser renders or runs here.
import { IMAGE_TYPES } from "@rsva/schema/models";

const ascii = (b: Buffer, at: number, s: string) => b.subarray(at, at + s.length).toString("latin1") === s;

/** The raster image type the bytes start with, or null. */
export function sniffImage(head: Buffer): string | null {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (ascii(head, 0, "GIF87a") || ascii(head, 0, "GIF89a")) return "image/gif";
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP")) return "image/webp";
  if (ascii(head, 4, "ftyp") && (ascii(head, 8, "avif") || ascii(head, 8, "avis"))) return "image/avif";
  return null;
}

/**
 * What a GIF will be drawn at: the larger of its logical screen (width and height, u16 little-endian, right after the
 * signature) and every frame's extent (left + width, top + height) among the blocks in the kept head, because a browser
 * sizes the canvas up to a first frame bigger than the screen, so a 1 × 1 screen is no promise. Null if the blocks are
 * malformed or end before the first Image Descriptor. Frames past the kept head are not seen: whether a browser clips a
 * later frame larger than the canvas or grows the canvas to it is not established here.
 */
function gifSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 13) return null;
  let width = b.readUInt16LE(6);
  let height = b.readUInt16LE(8);
  const colours = (flags: number) => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
  /** The position after the sub-blocks that start at `i` (each a length byte and that many bytes, ended by a 0). */
  const skip = (i: number) => {
    while (i < b.length && b[i] !== 0) i += b[i]! + 1;
    return i + 1;
  };
  let frames = 0;
  for (let i = 13 + colours(b[10]!); i < b.length; ) {
    if (b[i] === 0x21) i = skip(i + 2);
    else if (b[i] === 0x2c && i + 10 <= b.length) {
      width = Math.max(width, b.readUInt16LE(i + 1) + b.readUInt16LE(i + 5));
      height = Math.max(height, b.readUInt16LE(i + 3) + b.readUInt16LE(i + 7));
      frames++;
      i = skip(i + 11 + colours(b[i + 9]!));
    } else break;
  }
  return frames ? { width, height } : null;
}

/**
 * The largest size an AVIF declares: its `ispe` boxes (4 bytes of version and flags, then width and height, u32
 * big-endian) inside meta > iprp > ipco, by walking the boxes as a decoder does. An AVIF with a thumbnail or tiles has
 * several, and the biggest counts, so a bomb cannot hide behind a small first one; a grid's canvas is the ispe of the grid
 * item itself, larger than any tile's, so it is the one found. Considered: searching the head for the bytes "ispe": fewer
 * lines, but a fake one inside any other box (a text field, the mdat start) would be found, and the walk is the only way
 * to say which ones are properties.
 */
function avifSize(b: Buffer, from = 0, to = b.length, depth = 0): { width: number; height: number } | null {
  let best: { width: number; height: number } | null = null;
  for (let i = from; i + 8 <= to; ) {
    const len = b.readUInt32BE(i);
    const end = len === 0 ? to : len === 1 ? Infinity : i + len;
    if (end < i + 8 || len === 1) break;
    const type = b.toString("latin1", i + 4, i + 8);
    const inside = type === "meta" ? i + 12 : i + 8;
    let found: { width: number; height: number } | null = null;
    if (type === "ispe" && i + 20 <= b.length) found = { width: b.readUInt32BE(i + 12), height: b.readUInt32BE(i + 16) };
    else if ((type === "meta" || type === "iprp" || type === "ipco") && depth < 4) found = avifSize(b, inside, Math.min(end, b.length), depth + 1);
    if (found && (!best || found.width * found.height > best.width * best.height)) best = found;
    i = end;
  }
  return best;
}

/**
 * Whether an AVIF says it is an image sequence: the brand `avis`, major or among the compatible ones of its ftyp box. A
 * decoder then plays the track in `moov`, whose frames have a size of their own that no `ispe` states, so the size read
 * here would be a promise about another picture. Such a file has no readable size: it is a download.
 */
function avifSequence(b: Buffer): boolean {
  const end = Math.min(b.readUInt32BE(0), b.length);
  for (let i = 8; i + 4 <= end; i += i === 8 ? 8 : 4) if (ascii(b, i, "avis")) return true;
  return false;
}

/**
 * The pixel size a PNG, JPEG, GIF, WebP or AVIF says it has, read from its header, or null if the bytes are none of them or cut
 * short. For a limit before anyone decodes it: a few KB of WebP can describe 16383 × 16383 pixels, a gigabyte to draw.
 */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  switch (sniffImage(b)) {
    case "image/png":
      // The IHDR chunk comes first: width and height, big-endian.
      return b.length >= 24 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
    case "image/gif":
      return gifSize(b);
    case "image/avif":
      return avifSequence(b) ? null : avifSize(b);
    case "image/webp": {
      if (b.length < 30) return null;
      if (ascii(b, 12, "VP8 ")) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (ascii(b, 12, "VP8L")) {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (ascii(b, 12, "VP8X")) return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
      return null;
    }
    case "image/jpeg": {
      // The segments as a decoder walks them, up to the start of the scan: each after SOI has a length, and a frame has
      // one SOF (SOF0–SOF15 but DHT, JPG and DAC, which share the range). Anything else is refused, not skipped: a marker
      // without a length (RST0 here, which libjpeg passes over) would shift this walk onto bytes the decoder never reads.
      let size: { width: number; height: number } | null = null;
      for (let i = 2; ; ) {
        if (i + 4 > b.length || b[i] !== 0xff) return null;
        const marker = b[i + 1]!;
        if (marker === 0xff) {
          i++;
          continue;
        }
        if (marker === 0xda) return size;
        if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) return null;
        const length = b.readUInt16BE(i + 2);
        if (length < 2) return null;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          if (size || length < 8 || i + 9 > b.length) return null;
          size = { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
          // A height of 0 comes later, in a DNL segment: not a picture of a size known here.
          if (!size.width || !size.height) return null;
        }
        i += 2 + length;
      }
    }
    default:
      return null;
  }
}

/**
 * The most pixels an image served inline may declare: 100 megapixels, about 400 MB once decoded. A phone's 50 MP photo, an
 * 8K screen (33 MP) and a page screenshot 1440 px wide and 60 000 tall (86 MP) fit; what an image bomb claims (a WebP of
 * 16383 × 16383 = 268 MP, a PNG or JPEG of billions) does not. The browser shrinks what it uploads to 2560 px, 7 MP.
 */
const IMAGE_PIXELS_MAX = 100e6;

/** A declared Content-Type reduced to `type/subtype`, lower case; null for anything malformed. */
function declaredType(contentType: string | undefined): string | null {
  const t = contentType?.split(";", 1)[0]!.trim().toLowerCase();
  return t && t.length <= 100 && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(t) ? t : null;
}

/**
 * The type a new file is stored as: the image type its bytes prove, provided the header gives a size of at most
 * IMAGE_PIXELS_MAX pixels (an image with a larger or unreadable size is a download, application/octet-stream, so that no
 * member's browser is made to decode it); else the declared type unless it claims an image the bytes do not prove, else
 * application/octet-stream.
 */
export function fileType(head: Buffer, contentType: string | undefined): string {
  const image = sniffImage(head);
  if (image) {
    const size = imageSize(head);
    return size && size.width * size.height > 0 && size.width * size.height <= IMAGE_PIXELS_MAX ? image : "application/octet-stream";
  }
  const declared = declaredType(contentType);
  return declared && !IMAGE_TYPES.has(declared) ? declared : "application/octet-stream";
}
