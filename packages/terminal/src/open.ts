// The browser for a URL, for the CLI and the TUI (apps/tui).
import { spawn } from "node:child_process";

/**
 * The URL with the system's opener; false when there is none or it failed. No shell: the URL is one argument. macOS and
 * the rest of POSIX only, as the editor's `sh -c` and the Keychain are.
 */
export const open = (url: string) =>
  new Promise<boolean>((resolve) => {
    const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
