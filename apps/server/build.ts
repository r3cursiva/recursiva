// Production build: the server and its dependencies in one ES module, dist/main.js.
//
// Running src/main.ts directly makes Node strip types from every workspace .ts file and load several hundred
// node_modules files one by one. Measured on the reference Mac (docs/research/server-memory-2026-10-27.md): one file starts faster
// and uses less memory. dist/ sits at the same depth as src/, so the relative paths to the migrations and to the web
// build resolve the same way from both. The CLIs a deployed server needs (sign-in tokens and sessions, import) are
// bundled beside it, as dist/auth-cli.js, dist/import-cli.js, dist/github-cli.js, dist/rehost-cli.js and dist/waitlist-cli.js: the image has no
// node_modules.
import { build } from "esbuild";

const started = performance.now();
const result = await build({
  entryPoints: {
    main: new URL("src/main.ts", import.meta.url).pathname,
    "auth-cli": new URL("src/cli/auth.ts", import.meta.url).pathname,
    "import-cli": new URL("src/cli/import.ts", import.meta.url).pathname,
    "github-cli": new URL("src/cli/github.ts", import.meta.url).pathname,
    "rehost-cli": new URL("src/cli/rehost.ts", import.meta.url).pathname,
    "relink-cli": new URL("src/cli/relink.ts", import.meta.url).pathname,
    "waitlist-cli": new URL("src/cli/waitlist.ts", import.meta.url).pathname,
  },
  outdir: new URL("dist", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  minifySyntax: true,
  legalComments: "none",
  metafile: true,
  // ws uses these native helpers when they are installed and falls back to JS otherwise.
  external: ["bufferutil", "utf-8-validate"],
  // Bundled CommonJS packages (fastify, postgres) call require for Node built-ins.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  logLevel: "warning",
});
const main = Object.entries(result.metafile.outputs).find(([file]) => file.endsWith("dist/main.js"))![1];
console.log(`dist/main.js: ${(main.bytes / 1024).toFixed(0)} KB, ${Object.keys(main.inputs).length} modules, ${Math.round(performance.now() - started)} ms (with the CLIs)`);
