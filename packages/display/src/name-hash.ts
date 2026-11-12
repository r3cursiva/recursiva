// The hash a name picks its tone by (avatar.ts, tile.ts): the same name, the same tone, on every screen.

/** A signed 32-bit hash of the name; take `Math.abs(h) % tones.length`. */
export function nameHash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return h;
}
