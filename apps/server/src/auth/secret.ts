// Random secrets and the hashes stored in their place.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url: 256 bits, nothing to guess. */
export const randomSecret = (): string => randomBytes(32).toString("base64url");

export const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("base64url");

/** Constant-time comparison of two strings of any length. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
