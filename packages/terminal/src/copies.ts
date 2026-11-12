// Where the TUI (apps/tui) keeps its copies of the workspaces: a folder per credential under the user's caches, named by
// the credential's hash, never the credential (PLNR-306). The CLI knows it too, so `rsva logout` takes the copies the
// session made along with the session (PLNR-326): a signed-out terminal keeps no workspace in the clear.
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The terminal's own folder under the user's caches, for the copies, the TUI's runs and the editor's scratch files:
 * `$XDG_CACHE_HOME/rsva`, else `~/Library/Caches/rsva` on macOS and `~/.cache/rsva` elsewhere.
 */
export const cacheRoot = (env: Record<string, string | undefined> = process.env): string =>
  join(env.XDG_CACHE_HOME || join(homedir(), process.platform === "darwin" ? "Library/Caches" : ".cache"), "rsva");

/** The folder of a credential's copies: `<cacheRoot>/<16 hex of sha256(Authorization value)>`. */
export const credentialFolder = (authorization: string, env: Record<string, string | undefined> = process.env): string =>
  join(cacheRoot(env), createHash("sha256").update(authorization).digest("hex").slice(0, 16));

/** Deletes a credential's copies; nothing to delete is fine. */
export const removeCopies = (authorization: string): Promise<void> => rm(credentialFolder(authorization), { recursive: true, force: true });
