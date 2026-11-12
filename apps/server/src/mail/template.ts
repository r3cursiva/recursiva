// The one template behind every email, after the Mail* artboards of the Quire canvas: tables and inline styles, because
// that is what mail clients keep. Plain functions and no React Email: Node runs src/*.ts directly, .tsx does not load, and
// its render added 1.18 MB to the bundle and 32 MB of RSS against 4 KB and 1 MB here (measured 2026-11-02, PLNR-185).
//
// Light is the base. The Graphite colours sit in their own <style>, so a client that drops that block keeps the phone
// rules. Gmail ignores prefers-color-scheme and may darken the mail itself, so the light logo carries its own plate.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Markup that is already safe. Everything else that goes into `html` is escaped. */
export class Html {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
}

export type Part = string | number | Html | false | null | undefined | readonly Part[];

function part(v: Part): string {
  if (v == null || v === false) return "";
  if (v instanceof Html) return v.value;
  if (typeof v === "object") return v.map(part).join("");
  return String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

export const html = (strings: TemplateStringsArray, ...values: Part[]): Html =>
  new Html(strings.reduce((out, s, i) => out + s + (i < values.length ? part(values[i]) : ""), ""));

const LIGHT = {
  well: "#e8e6df",
  ground: "#f6f5f1",
  panel: "#fbfaf7",
  rule: "#e2e0d8",
  ruleSoft: "#e9e7e0",
  ruleStrong: "#cfccc2",
  ink: "#18181b",
  ink2: "#4a4a50",
  ink3: "#6b6a66",
  inverse: "#18181b",
  inverseInk: "#fbfaf7",
  input: "#ffffff",
};
const DARK: typeof LIGHT = {
  well: "#0f0f0e",
  ground: "#161615",
  panel: "#1c1c1a",
  rule: "#2b2a27",
  ruleSoft: "#242321",
  ruleStrong: "#4a4843",
  ink: "#edebe5",
  ink2: "#bdbab1",
  ink3: "#918e85",
  inverse: "#edebe5",
  inverseInk: "#161615",
  input: "#121211",
};
type Tone = keyof typeof LIGHT;

const rules = (tones: Tone[], prefix: string, property: string) => tones.map((t) => `.${prefix}-${t}{${property}:${DARK[t]}!important}`).join("");
const DARK_CSS =
  ":root{color-scheme:light dark}@media (prefers-color-scheme:dark){" +
  rules(["well", "ground", "panel", "inverse", "input"], "bg", "background-color") +
  rules(["ink", "ink2", "ink3", "inverseInk"], "c", "color") +
  rules(["rule", "ruleSoft", "ruleStrong"], "bd", "border-color") +
  ".logo-light{display:none!important}.logo-dark{display:inline-block!important}}";
const PHONE_CSS =
  "@media (max-width:480px){.well{padding:0!important}.card{border:0!important;border-radius:0!important}.foot{border-radius:0!important}" +
  ".pad{padding-left:20px!important;padding-right:20px!important}.key{width:96px!important}" +
  ".btn-table{width:100%!important}.btn{display:block!important;text-align:center!important;line-height:46px!important}" +
  ".code{line-height:52px!important;font-size:24px!important}}";

const SANS = '"Onest",system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
const MONO = '"JetBrains Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace';
const layoutTable = new Html('role="presentation" cellpadding="0" cellspacing="0" border="0"');

const fg = (t: Tone) => html`c-${t}`;

export const para = (content: Part): Html => html`<p class="${fg("ink2")}" style="margin:0;font-size:14.5px;line-height:1.55;color:${LIGHT.ink2}">${content}</p>`;

/** A name or a fact inside a paragraph. */
export const strong = (content: Part): Html => html`<b class="${fg("ink")}" style="font-weight:500;color:${LIGHT.ink}">${content}</b>`;

/** Keys, addresses and links. */
export const mono = (content: Part): Html => html`<span style="font-family:${MONO};font-size:.86em">${content}</span>`;

/** Facts as label and value. */
export function ledger(rows: [label: string, value: Part][]): Html {
  const row = ([label, value]: [string, Part]) => {
    const cell = "padding:8px 0;border-bottom:1px solid";
    return html`<tr><td class="key ${fg("ink3")} bd-ruleSoft" width="118" valign="top" style="width:118px;${cell} ${LIGHT.ruleSoft};font-size:13.5px;color:${LIGHT.ink3}">${label}</td><td class="${fg("ink")} bd-ruleSoft" valign="top" style="${cell} ${LIGHT.ruleSoft};font-size:13.5px;color:${LIGHT.ink};word-break:break-word">${value}</td></tr>`;
  };
  return html`<table ${layoutTable} width="100%" class="bd-rule" style="border-top:1px solid ${LIGHT.rule}">${rows.map(row)}</table>`;
}

/** Someone's words, a comment, set apart from the mail's own: a well, line breaks kept. */
export function quote(text: string): Html {
  return html`<div class="bg-ground ${fg("ink")}" style="padding:12px 14px;border-radius:6px;background-color:${LIGHT.ground};font-size:14px;line-height:1.55;color:${LIGHT.ink};white-space:pre-wrap;word-break:break-word">${text}</div>`;
}

/** A section's heading inside a mail with several (a digest). */
export const heading = (text: string): Html => html`<h2 class="${fg("ink")}" style="margin:6px 0 0;font-size:15px;font-weight:600;color:${LIGHT.ink}">${text}</h2>`;

/** Issues as rows: the key, the title as a link, and a line under it (what happened, by whom). */
export function issueList(rows: { key: string; title: string; link: string; line?: string }[]): Html {
  const row = (r: (typeof rows)[number]) =>
    html`<tr><td class="bd-ruleSoft" style="padding:9px 0;border-bottom:1px solid ${LIGHT.ruleSoft}"><span class="${fg("ink3")}" style="font-family:${MONO};font-size:12px;color:${LIGHT.ink3}">${r.key}</span> <a class="${fg("ink")}" href="${r.link}" style="font-size:14px;font-weight:500;color:${LIGHT.ink};text-decoration:none">${r.title}</a>${r.line ? html`<div class="${fg("ink3")}" style="padding-top:2px;font-size:12.5px;color:${LIGHT.ink3}">${r.line}</div>` : ""}</td></tr>`;
  return html`<table ${layoutTable} width="100%" class="bd-rule" style="border-top:1px solid ${LIGHT.rule}">${rows.map(row)}</table>`;
}

/** The one primary action. */
export function button(href: string, label: string): Html {
  return html`<table ${layoutTable} class="btn-table"><tr><td class="bg-inverse" bgcolor="${LIGHT.inverse}" style="border-radius:6px;background-color:${LIGHT.inverse}"><a class="btn ${fg("inverseInk")}" href="${href}" style="display:inline-block;padding:0 22px;line-height:42px;font-size:14.5px;font-weight:500;color:${LIGHT.inverseInk};text-decoration:none">${label}</a></td></tr></table>`;
}

/** The same link in the open, for a client that breaks the button. */
export function linkInstead(label: string, href: string): Html {
  return html`<div class="${fg("ink3")}" style="font-size:12.5px;line-height:1.5;color:${LIGHT.ink3}">${label}<br><a class="${fg("ink2")}" href="${href}" style="color:${LIGHT.ink2};word-break:break-all">${mono(href)}</a></div>`;
}

/**
 * The code as one run of text, so it copies as six digits and nothing else. The gap between the threes is padding, not a
 * space, and user-select:all takes the whole code at one click where the client allows it.
 */
export function codeCells(code: string): Html {
  const digits = html`${code.slice(0, 3)}<span class="code-break" style="padding-left:14px">${code.slice(3)}</span>`;
  return html`<table ${layoutTable}><tr><td class="code bg-input bd-ruleStrong ${fg("ink")}" bgcolor="${LIGHT.input}" style="padding:0 14px 0 20px;line-height:58px;border:1px solid ${LIGHT.ruleStrong};border-radius:6px;background-color:${LIGHT.input};font-family:${MONO};font-size:28px;font-weight:500;letter-spacing:.32em;white-space:nowrap;color:${LIGHT.ink};-webkit-user-select:all;user-select:all">${digits}</td></tr></table>`;
}

/** Nov 2, 09:12 UTC: the server knows no one's time zone yet. */
export function when(d: Date): string {
  return `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" }).format(d)} UTC`;
}

export interface Page {
  /** Where the logo and the footer's address come from; without one the mail has no images. */
  origin: string;
  sent: Date;
  /** The line a mail list shows after the subject. */
  preheader: string;
  overline: string;
  title: string;
  /** Blocks from top to bottom, 18 px apart. */
  blocks: Html[];
  /** Why it came. */
  footer: Part;
  /** The workspace the mail is about, on the right of the header. */
  workspace?: string;
  /** A small line above the card: where to write a reply (PLNR-211). */
  above?: string;
}

function logo(origin: string): Html | null {
  if (!origin) return null;
  const image = (name: string, style: string) =>
    html`<img class="logo-${name}" src="${origin}/mail-mark-${name}.png" width="22" height="22" alt="" style="${style};width:22px;height:22px;border:0;vertical-align:middle">`;
  return html`<td width="31" style="width:31px;line-height:0">${image("light", "display:inline-block")}${image("dark", "display:none;mso-hide:all")}</td>`;
}

function header(p: Page): Html {
  const tile = html`<span style="display:inline-block;width:16px;line-height:16px;margin-right:7px;border-radius:4px;background-color:#2f6f6a;color:#ffffff;text-align:center;font-family:${SANS};font-size:10px;font-weight:600">${p.workspace?.[0]?.toUpperCase()}</span>`;
  const workspace = p.workspace ? html`<td class="${fg("ink3")}" align="right" style="font-family:${MONO};font-size:11.5px;color:${LIGHT.ink3}">${tile}${p.workspace}</td>` : null;
  return html`<td class="pad bd-rule" style="padding:17px 32px;border-bottom:1px solid ${LIGHT.rule}"><table ${layoutTable} width="100%"><tr>${logo(p.origin)}<td class="${fg("ink")}" style="font-size:15px;font-weight:600;letter-spacing:-0.01em;color:${LIGHT.ink}">recursiva</td>${workspace}</tr></table></td>`;
}

const block = (content: Html) => html`<tr><td style="padding-top:18px">${content}</td></tr>`;

/** A whole HTML document for one mail. */
export function page(p: Page): string {
  const host = p.origin ? new URL(p.origin).host : "";
  const slip = html`<table ${layoutTable} width="100%" style="margin-top:8px"><tr><td class="${fg("ink3")}" style="font-family:${MONO};font-size:10.5px;color:${LIGHT.ink3}">${host}</td><td class="${fg("ink3")}" align="right" style="font-family:${MONO};font-size:10.5px;color:${LIGHT.ink3}">${when(p.sent)}</td></tr></table>`;
  const doc = html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="format-detection" content="telephone=no,date=no,address=no,email=no"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${p.title}</title><style>${new Html(PHONE_CSS)}</style><style>${new Html(DARK_CSS)}</style></head>
<body class="bg-well" style="margin:0;padding:0;background-color:${LIGHT.well};font-family:${SANS}"><div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${p.preheader}</div><table ${layoutTable} width="100%" class="bg-well" bgcolor="${LIGHT.well}" style="background-color:${LIGHT.well}"><tr><td class="well" align="center" style="padding:24px 16px">${p.above ? html`<div class="${fg("ink3")}" style="padding:0 0 10px;font-family:${MONO};font-size:11px;color:${LIGHT.ink3}">${p.above}</div>` : ""}<table ${layoutTable} width="600" class="card bg-panel bd-rule" bgcolor="${LIGHT.panel}" style="width:100%;max-width:600px;border:1px solid ${LIGHT.rule};border-radius:8px;border-collapse:separate;background-color:${LIGHT.panel};font-family:${SANS}"><tr>${header(p)}</tr><tr><td class="pad" style="padding:28px 32px 32px"><table ${layoutTable} width="100%"><tr><td class="${fg("ink3")}" style="font-family:${MONO};font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${LIGHT.ink3}">${p.overline}</td></tr><tr><td style="padding-top:12px"><h1 class="${fg("ink")}" style="margin:0;font-size:22px;line-height:1.25;font-weight:600;letter-spacing:-0.015em;color:${LIGHT.ink}">${p.title}</h1></td></tr>${p.blocks.map(block)}</table></td></tr><tr><td class="foot pad bg-ground bd-rule ${fg("ink3")}" bgcolor="${LIGHT.ground}" style="padding:18px 32px 22px;border-top:1px solid ${LIGHT.rule};border-radius:0 0 8px 8px;background-color:${LIGHT.ground};font-size:12px;line-height:1.5;color:${LIGHT.ink3}">${p.footer}${slip}</td></tr></table></td></tr></table></body></html>`;
  return doc.value;
}
