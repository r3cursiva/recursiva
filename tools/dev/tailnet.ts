// `pnpm dev:ts`: the dev setup reachable from the tailnet (e.g. from the second Mac), through portless --tailscale.
// portless serves Vite at https://<this node>.ts.net[:8443…] via `tailscale serve`; the API server must accept that
// Origin for /ws. Only the dev server gets it — the production defaults stay loopback-only.
import { execFileSync, spawn } from "node:child_process";

const status = JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8" })) as { Self: { DNSName: string } };
const host = status.Self.DNSName.replace(/\.$/, "");
// portless gives the first app port 443 and the next ones 8443, 8444…; which one we get is decided at start.
const origins = ["https://rsva.localhost", `https://${host}`, ...Array.from({ length: 8 }, (_, i) => `https://${host}:${8443 + i}`)];

const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
const children = [
  spawn("pnpm", ["--filter", "@rsva/server", "dev"], {
    stdio: "inherit",
    env: { ...env, RSVA_ALLOWED_ORIGINS: origins.join(",") },
  }),
  spawn("pnpm", ["--filter", "@rsva/web", "exec", "portless", "plnr", "--tailscale", "vite"], { stdio: "inherit", env }),
];
const stop = () => children.forEach((c) => c.kill("SIGTERM"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
