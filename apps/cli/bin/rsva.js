#!/usr/bin/env node
// `rsva` (src/main.ts). This launcher is JavaScript so that Node strips no types to start it: with Node's compile
// cache on, the .ts files come from the cache already stripped and compiled, and the type stripper is not even loaded.
// Stripping was half of the start, 25 of 51 ms, and grew with the code (ADR 0015, 2026-11-04). The cache is in the
// person's own cache folder, not the shared temp one: whoever can write an entry there runs code as us.
import { enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const caches = process.env.XDG_CACHE_HOME || join(homedir(), process.platform === "darwin" ? "Library/Caches" : ".cache");
enableCompileCache(join(caches, "rsva", "node-compile-cache"));
await import("../src/main.ts");
