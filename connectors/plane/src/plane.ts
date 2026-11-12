// Plane's encodings → the bundle's, shared by both Plane connectors: the API one (export.ts) and the database one
// (connectors/plane-db). Pure functions, no I/O.
import { fromHtml } from "@rsva/editor/html";
import { toMarkdown } from "@rsva/editor/markdown";
import { STATE_GROUPS as SCHEMA_STATE_GROUPS } from "@rsva/schema/models";

/** Plane's priority names → ours (0 none, 1 urgent … 4 low, as in Linear). */
export const PRIORITY: Record<string, 0 | 1 | 2 | 3 | 4> = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 };

/** State groups we keep; `triage` is Plane's internal intake state and is skipped. */
export const STATE_GROUPS = new Set<string>(SCHEMA_STATE_GROUPS);

/** Plane workspace roles: 20 admin, 15 member, 5 guest. The workspace owner is a separate field. */
export function memberRole(role: number): "admin" | "member" | "guest" {
  return role >= 20 ? "admin" : role >= 15 ? "member" : "guest";
}

/** Our bot account (bot@…) and Plane's own bot users are agents. */
export function userKind(email: string, isBot = false): "human" | "agent" {
  return isBot || email.startsWith("bot@") ? "agent" : "human";
}

export function displayName(u: { email: string; displayName?: string | null; firstName?: string | null; lastName?: string | null }): string {
  return u.displayName || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email;
}

/**
 * Plane stores a reaction as the emoji's code points in decimal joined by "-" ("128077" is 👍, "10084-65039" is ❤️ with
 * its variation selector). A value that is already an emoji passes through; anything malformed is null.
 */
export function decodeReaction(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (!/^\d+(-\d+)*$/.test(v)) return /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️]+$/u.test(v) ? v : null;
  const points = v.split("-").map(Number);
  if (points.some((p) => p <= 0 || p > 0x10ffff || (p >= 0xd800 && p <= 0xdfff))) return null;
  return String.fromCodePoint(...points);
}

export interface HtmlContext {
  /** A user's display name by Plane user id, for mentions: a user it names is in the bundle, so the mention links them. */
  userName?: (id: string) => string | undefined;
  /** A link to an uploaded file by Plane asset id; null drops the image. */
  assetUrl?: (assetId: string) => string | null;
}

/** What the rewrite met, for the connector's report. */
export interface HtmlStats {
  mentions: number;
  /** Mentions of a user the bundle does not have (or of something else): the text "@Name". */
  mentionsAsText: number;
  images: number;
  imagesDropped: number;
  attachmentsDropped: number;
}

export const emptyHtmlStats = (): HtmlStats => ({ mentions: 0, mentionsAsText: 0, images: 0, imagesDropped: 0, attachmentsDropped: 0 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function attrsOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of raw.matchAll(/([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[a[1]!.toLowerCase()] = a[3] ?? a[4] ?? "";
  return out;
}

/**
 * Plane's custom editor components → plain HTML that packages/editor understands:
 * - `<mention-component entity_identifier=<user id> entity_name="user_mention">` carries no visible name (entity_name is
 *   the mention type), so it gets the member's name as `label` and, for a user `userName` knows, the Plane user id as
 *   `user`: planeMarkdown writes it as `[@Name](mention:<Plane user id>)`, a mention of the bundle's user by `ext` that
 *   the import maps to ours (RSVA-42);
 * - `<image-component src=<asset id | URL>>` becomes `<img>` (the editor turns it into a link "image"): an asset id
 *   resolves through `assetUrl`, without one the image is dropped;
 * - `<attachment-component>` has no reachable source in the HTML and is dropped.
 */
export function planeHtml(html: string, ctx: HtmlContext = {}, stats: HtmlStats = emptyHtmlStats()): string {
  return html
    .replace(/<mention-component\b([^>]*)>(?:\s*<\/mention-component>)?/gi, (_, raw: string) => {
      const a = attrsOf(raw);
      const person = (a.entity_name ?? "user_mention") === "user_mention" && a.entity_identifier ? a.entity_identifier : null;
      const known = person ? ctx.userName?.(person) : undefined;
      if (known) stats.mentions++;
      else stats.mentionsAsText++;
      const name = known || a.label || "user";
      return `<mention-component${known ? ` user="${escapeAttr(person!)}"` : ""} label="${escapeAttr(name)}"></mention-component>`;
    })
    .replace(/<image-component\b([^>]*?)\/?>(?:\s*<\/image-component>)?/gi, (_, raw: string) => {
      const src = attrsOf(raw).src ?? "";
      const url = /^https?:\/\//i.test(src) ? src : UUID.test(src) ? (ctx.assetUrl?.(src) ?? null) : null;
      if (!url) {
        stats.imagesDropped++;
        return "";
      }
      stats.images++;
      return `<p><img src="${escapeAttr(url)}" alt="image"></p>`;
    })
    .replace(/<attachment-component\b[^>]*?\/?>(?:\s*<\/attachment-component>)?/gi, () => {
      stats.attachmentsDropped++;
      return "";
    });
}

/** A mention planeHtml linked: its target is the Plane user id, the bundle user's `ext`. */
const bundleUser = (ext: string) => ({ id: ext });

/** Plane's HTML → Markdown in our dialect (packages/editor), the bundle's text format for descriptions and comments. */
export function planeMarkdown(html: string | null | undefined, ctx: HtmlContext = {}, stats?: HtmlStats): string {
  return html ? toMarkdown(fromHtml(planeHtml(html, ctx, stats), { mention: bundleUser })).trimEnd() : "";
}
