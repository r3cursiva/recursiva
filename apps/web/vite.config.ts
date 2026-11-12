import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { cn } from "cn/vite";
import { defineConfig } from "vite";
import { readdirSync } from "node:fs";
import { phosphorWeights } from "./build/phosphor.ts";
import { shell } from "./build/shell.ts";
import { startupCss } from "./build/startup-css.ts";

const server = process.env.RSVA_SERVER ?? "http://127.0.0.1:3800";

/** Where Phosphor icons are imported: the app and the workspace packages it bundles. */
function iconSources(): string[] {
  const packages = new URL("../../packages/", import.meta.url).pathname;
  return [new URL("src", import.meta.url).pathname, ...readdirSync(packages).map((p) => `${packages}${p}/src`)];
}

const root = new URL("../../", import.meta.url).pathname;

/**
 * cn's merge tables, built from the theme in globals.css and only for the class groups the sources use: a size or color
 * added to the theme is known to cn on the next build, and a dev server rebuilds them on a save. The file is generated,
 * not committed (`pnpm cn:tables` writes it after an install, for the type check and tests).
 */
function cnTables() {
  return cn({
    cwd: root,
    css: "packages/ui/src/styles/globals.css",
    content: ["apps/web/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
    out: "packages/ui/src/lib/cn-tables.ts",
  });
}

export default defineConfig({
  plugins: [phosphorWeights(iconSources()), react(), tailwindcss(), cnTables(), startupCss(), shell()],
  build: {
    target: "es2023",
    // The size check (tools/perf) reads the manifest to see which files load at startup.
    manifest: true,
    sourcemap: "hidden",
    reportCompressedSize: false,
    rolldownOptions: {
      output: {
        // React, MobX and the scheduler change only on a dependency bump; our code changes on every deploy. Apart, a
        // deploy re-downloads only our chunk and the libraries stay cached (immutable names, Service Worker).
        advancedChunks: {
          groups: [{ name: "vendor", test: /node_modules[\\/]\.pnpm[\\/](react|react-dom|scheduler|mobx|mobx-react-lite)@/ }],
        },
      },
    },
  },
  server: {
    // portless --tailscale (pnpm dev:ts) passes the tailnet URL; Vite rejects unknown Host names otherwise.
    allowedHosts: [".localhost", ...(process.env.PORTLESS_TAILSCALE_URL ? [new URL(process.env.PORTLESS_TAILSCALE_URL).hostname] : [])],
    proxy: {
      // changeOrigin: the API server accepts only loopback Host names; the page's Origin still reaches it and is checked
      // there (string targets below get changeOrigin by default, this object form does not).
      "/ws": { target: server.replace(/^http/, "ws"), ws: true, changeOrigin: true },
      "/healthz": server,
      "/sync": server,
      "/api": server,
      "/auth": server,
      "/files": server,
      "/pictures": server,
    },
  },
});
