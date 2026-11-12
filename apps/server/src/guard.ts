// Request guard: which Host and Origin headers the server answers.
//
// - Host: only loopback names (any port) and RSVA_ALLOWED_HOSTS. Stops DNS rebinding, where a foreign domain
//   resolves to 127.0.0.1 and a page on it calls our API as same-origin.
// - Origin: browsers do not apply CORS to WebSocket, so any open page could connect to /ws and read or change data.
//   Only loopback origins (the Vite dev proxy runs on 5173–5175) and RSVA_ALLOWED_ORIGINS pass, on HTTP as well.
//   A missing Origin means a non-browser client (tests, CLI, agents) or a same-origin GET and is allowed for now.
// - A deployment (an https origin in RSVA_ALLOWED_ORIGINS and HOST other than loopback, as in production) takes no
//   loopback Host or Origin: there a page on some localhost port of a visitor's machine is not ours (PLNR-32). Local
//   dev keeps them: its servers listen on loopback, and the Vite proxy sends a loopback Host even for an https page.
// - GET /healthz skips both checks: it says only {ok:true}, and health checks call it by address (127.0.0.1).
// - /api/waitlist also takes the origins in RSVA_WAITLIST_ORIGINS (the landing, https://rsva.dev): it only puts an
//   address on the waitlist (waitlist.ts), so a page there may call it and nothing else.
//
// This is not authentication; sign-in is auth/.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const list = (v: string | undefined) =>
  new Set(
    (v ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

export interface GuardConfig {
  /** Extra Host values, exactly as sent (name or name:port). */
  hosts: Set<string>;
  /** Extra origins, e.g. https://planner.example.com. */
  origins: Set<string>;
  /** Loopback Hosts and Origins pass: off on a deployment. */
  loopback: boolean;
  /** Origins that may call /api/waitlist and nothing else: the landing's. */
  waitlist: Set<string>;
}

/** The one path the landing calls (waitlist.ts). */
export const WAITLIST_PATH = "/api/waitlist";

const LOOPBACK_BIND = new Set(["127.0.0.1", "::1", "localhost"]);

export function guardConfig(env: NodeJS.ProcessEnv = process.env): GuardConfig {
  const origins = list(env.RSVA_ALLOWED_ORIGINS);
  const deployed = [...origins].some((o) => o.startsWith("https://")) && !LOOPBACK_BIND.has(env.HOST ?? "127.0.0.1");
  return { hosts: list(env.RSVA_ALLOWED_HOSTS), origins, loopback: !deployed, waitlist: list(env.RSVA_WAITLIST_ORIGINS) };
}

/** Host name without the port; IPv6 keeps its brackets. */
function hostname(host: string): string {
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":", 1)[0]!;
}

export function hostAllowed(host: string | undefined, cfg: GuardConfig): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return (cfg.loopback && LOOPBACK.has(hostname(h))) || cfg.hosts.has(h);
}

export function originAllowed(origin: string | undefined, cfg: GuardConfig): boolean {
  if (origin === undefined) return true;
  const o = origin.toLowerCase();
  if (cfg.origins.has(o)) return true;
  if (!cfg.loopback) return false;
  let url: URL;
  try {
    url = new URL(o);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname) && url.origin === o;
}

/** Whether a page at this origin may call the waitlist (and so may read its answer: waitlist.ts sends it back as CORS). */
export const waitlistOrigin = (origin: string | undefined, cfg: GuardConfig): boolean => origin !== undefined && cfg.waitlist.has(origin.toLowerCase());

/** Status for a rejected request, or null when it may proceed. `url` lets the landing's origin reach the waitlist. */
export function rejectStatus(headers: { host?: string | undefined; origin?: string | undefined }, cfg: GuardConfig, url = ""): number | null {
  if (!hostAllowed(headers.host, cfg)) return 421;
  if (url.split("?", 1)[0] === WAITLIST_PATH && waitlistOrigin(headers.origin, cfg)) return null;
  if (!originAllowed(headers.origin, cfg)) return 403;
  return null;
}
