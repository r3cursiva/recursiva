// Security headers on every response (PLNR-32). The Content-Security-Policy is built once, when the server starts, from
// the shell it serves:
//
// - Scripts: our own files and, by hash, the inline theme script of index.html (it must run before the first paint, so
//   it cannot be a file without one more request on the critical path). The hash is computed here from the built
//   page, so editing the script needs no second edit anywhere. A per-request nonce was the alternative; it would mean
//   rewriting the page on every request and give up its precompressed variants, ETag and the Service Worker's copy.
// - Styles: stylesheets and <style> only from our files ('self'). Style attributes are allowed (style-src-attr
//   'unsafe-inline'), and only them: the app itself sets styles through the CSSOM (React's `style` prop, floating-ui,
//   the theme script), which CSP does not restrict, but the editor reads pasted formatting from the style attributes
//   of the clipboard's HTML (Google Docs marks bold and italic only so: schema.ts parseDOM), and under a blocked
//   attribute ProseMirror sees no style and pastes everything bold (checked in Chrome, PLNR-32). An attribute cannot
//   bring selectors (no CSS-based reading of the page) and its url() loads stay under img-src and font-src 'self'.
//   A browser without style-src-attr falls back to style-src 'self': the paste loses that formatting, nothing else.
// - connect-src: 'self' covers same-origin fetches and, in CSP Level 3 browsers, the WebSocket on the same host. The
//   ws(s) forms of the configured origins are listed as well, for browsers whose 'self' does not match ws: and wss:.
// - Strict-Transport-Security (RSVA-618) goes out only on a deployment, by the decision the guard already makes (an https
//   origin and a non-loopback bind: !guard.loopback). Local dev and portless *.localhost never get it: a browser would
//   pin the dev host to https. max-age one year, no includeSubDomains and no preload: the app does not own the parent
//   domain, and those two would reach its siblings.
// - The same policy goes on every response, not only on the page: the Service Worker script (/sw.js) runs under the
//   policy it was served with, and it fetches the shell.
import { createHash } from "node:crypto";
import type { GuardConfig } from "./guard.ts";
import type { StaticFile } from "./static.ts";

/** CSP sources for the inline scripts of a page: 'sha256-…' of each script's text, exactly as the browser hashes it. */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(attrs!)) continue;
    out.push(`'sha256-${createHash("sha256").update(body!, "utf8").digest("base64")}'`);
  }
  return out;
}

export function contentSecurityPolicy(files: Map<string, StaticFile>, guard: GuardConfig): string {
  const page = files.get("/index.html")?.variants.find((v) => v.encoding === null)?.body.toString("utf8") ?? "";
  const sockets = [...guard.origins].filter((o) => /^https?:\/\//.test(o)).map((o) => o.replace(/^http/, "ws"));
  const directives: [string, ...string[]][] = [
    ["default-src", "'self'"],
    ["script-src", "'self'", ...inlineScriptHashes(page)],
    ["style-src", "'self'"],
    ["style-src-attr", "'unsafe-inline'"],
    ["img-src", "'self'", "data:"],
    ["connect-src", "'self'", ...sockets],
    ["object-src", "'none'"],
    ["base-uri", "'none'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
  ];
  return directives.map((d) => d.join(" ")).join("; ");
}

export function securityHeaders(files: Map<string, StaticFile>, guard: GuardConfig): Record<string, string> {
  return {
    ...(guard.loopback ? {} : { "strict-transport-security": "max-age=31536000" }),
    "content-security-policy": contentSecurityPolicy(files, guard),
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
}
