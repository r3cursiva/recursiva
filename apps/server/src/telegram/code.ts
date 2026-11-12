// The one-time codes that link a chat to recursiva: a personal chat's `/start <code>` (PLNR-202) and a group's
// `/link <code>` (PLNR-204). Stored as their SHA-256, good for ten minutes.
import { randomInt } from "node:crypto";
import { sha256 } from "../auth/secret.ts";
import type { TelegramApi } from "./api.ts";

const CODE_MS = 10 * 60_000;
/** Base62 without the look-alikes (0 O 1 l I): typed by hand when there is no camera. 57^10 ≈ 2^58. */
const ALPHABET = "23456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 10;

const newCode = (): string => Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

/**
 * A new code with the bot's name its link is built from, and `id`, the hash it is stored by. A 502 when Telegram does
 * not answer: a link to no bot is of no use.
 */
export async function freshCode(api: TelegramApi): Promise<{ bot: string; code: string; id: string; createdAt: string; expiresAt: string }> {
  const bot = await api.username().catch(() => {
    throw Object.assign(new Error("Telegram does not answer right now. Try again in a minute."), { statusCode: 502 });
  });
  const code = newCode();
  const now = Date.now();
  return { bot, code, id: sha256(code), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + CODE_MS).toISOString() };
}
