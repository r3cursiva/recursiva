// Image headers for tests: the server reads them and never decodes a picture, so the pixels can be anything.
const u32be = (n: number) => Buffer.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
export const u24le = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255, n >>> 16]);
export const png = (w: number, h: number, tail = "pixels") =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32be(13), Buffer.from("IHDR"), u32be(w), u32be(h), Buffer.from([8, 6, 0, 0, 0]), Buffer.from(tail)]);
/** A GIF: the screen, then one frame at `frame` (default: the whole screen), after an extension block and, if `local`, a local colour table. */
export const gif = (w: number, h: number, frame: [number, number, number, number] = [0, 0, w, h], local = false) => {
  const u16 = (n: number) => Buffer.from([n & 255, n >> 8]);
  return Buffer.concat([
    Buffer.from("GIF89a"), u16(w), u16(h), Buffer.from([0, 0, 0]),
    Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]), // graphic control extension: one sub-block of 4 bytes
    Buffer.from([0x2c]), u16(frame[0]), u16(frame[1]), u16(frame[2]), u16(frame[3]), Buffer.from([local ? 0x81 : 0]),
    local ? Buffer.alloc(6) : Buffer.alloc(0), // a local colour table of two entries
    Buffer.from([2, 3, 1, 2, 3, 0, 0x3b]),
  ]);
};
export const webp = (chunk: string, body: Buffer) => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.from(chunk), Buffer.alloc(4), body]);
/** SOI, APP0, `before` (more segments), SOF2, SOS. */
export const jpeg = (w: number, h: number, before = Buffer.alloc(0)) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]),
    Buffer.alloc(14),
    before,
    Buffer.from([0xff, 0xc2, 0, 19, 8]),
    Buffer.from([h >> 8, h & 255, w >> 8, w & 255]),
    Buffer.alloc(12),
    Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]),
    Buffer.from("scan"),
  ]);

const box = (type: string, ...body: Buffer[]) => {
  const b = Buffer.concat(body);
  return Buffer.concat([u32be(8 + b.length), Buffer.from(type), b]);
};
/** An AVIF's boxes as a decoder reads them: ftyp, then meta > iprp > ipco with one `ispe` per size given (thumbnail, tiles, canvas). */
export const avif = (...sizes: [number, number][]) =>
  Buffer.concat([
    box("ftyp", Buffer.from("avif"), Buffer.alloc(4), Buffer.from("avifmif1")),
    box("meta", Buffer.alloc(4), box("hdlr", Buffer.alloc(24)), box("iprp", box("ipco", ...sizes.map(([w, h]) => box("ispe", Buffer.alloc(4), u32be(w), u32be(h)))))),
    box("mdat", Buffer.from("pixels")),
  ]);
