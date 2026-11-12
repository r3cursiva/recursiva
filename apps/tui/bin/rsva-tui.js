#!/usr/bin/env node
// `rsva tui` (src/main.ts), started by the CLI or on its own. JavaScript for the same reason as the CLI's launcher
// (apps/cli/bin/rsva.js): with Node's compile cache on, the .ts files come from the cache already stripped.
import { enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const caches = process.env.XDG_CACHE_HOME || join(homedir(), process.platform === "darwin" ? "Library/Caches" : ".cache");
enableCompileCache(join(caches, "rsva", "node-compile-cache"));
await import("../src/main.ts");
