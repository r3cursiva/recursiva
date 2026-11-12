#!/usr/bin/env node
// `pnpm public:tree <empty folder>`: writes the public tree (tools/public/tree.ts) there. Switch-over day (RSVA-591) makes the
// first commit of the public repository from it; `pnpm public:check` looks the same tree over for what must not be in it.
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot, writePublicTree } from "./tree.ts";

const dest = process.argv[2] && resolve(process.argv[2]);
if (!dest) (console.error("usage: pnpm public:tree <empty folder>"), process.exit(2));
if ((await readdir(dest).catch(() => [])).length) (console.error(`${dest} is not empty`), process.exit(2));
const files = await writePublicTree(repoRoot(), dest);
console.log(`public tree: ${files.length} files in ${dest}`);
