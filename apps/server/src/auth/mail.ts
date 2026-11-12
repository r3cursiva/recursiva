// Outgoing mail: sign-in codes, invites and account notices for now, digests later (docs/plan.html). Resend's HTTP API
// when RESEND_API_KEY is set. The server log instead only when asked (RSVA_MAIL=log: local runs, perf checks)
// and only on a loopback-only server without a proxy (HOST, RSVA_TRUST_PROXY): a deployment's logs go to Loki, where codes would be readable by
// whatever reads the logs. A server with neither does not start. A self-hosted server in a container listens on 0.0.0.0
// with its port published on loopback: its owner says so with RSVA_ALLOW_LOG_MAIL=1 (deploy/self-host).

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Extra headers: Message-ID and References thread notifications of one issue (notify/send.ts). */
  headers?: Record<string, string>;
  /** Where a reply goes: a notification's own reply address (PLNR-211, mail/inbound.ts). */
  replyTo?: string;
}

export type Mailer = (m: Mail) => Promise<void>;

/** Sends a mail without making the request wait for it: a failure is logged ("<what> not sent"), never answered. */
export function mailLater(mailer: Mailer, mail: Mail, log: { error(e: unknown, msg: string): void }, what: string): void {
  void mailer(mail).catch((e: unknown) => log.error(e, `${what} not sent`));
}

/**
 * Where links in mail point (invites, sign-in links): the deployment's https origin, not the request's Origin header
 * (the guard lets loopback origins through, so a link could point at someone's localhost). A local run without one
 * uses the request's.
 */
export const PUBLIC_ORIGIN = process.env.RSVA_ALLOWED_ORIGINS?.split(",").map((o) => o.trim()).find((o) => o.startsWith("https://"));
export const linkOrigin = (requestOrigin: string | undefined): string => PUBLIC_ORIGIN ?? requestOrigin ?? "";

/**
 * A name as mail shows it: one short line, no control characters, so a name cannot pose as the mail's own text. Marks
 * that reorder or hide text go too (bidi marks, overrides and isolates, zero-width spaces): a Telegram name is anyone's.
 * The joiners stay, which emoji and some scripts need.
 */
export const mailText = (s: string) =>
  s
    .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
/** A server only this machine reaches directly: loopback-only and not behind a proxy it trusts, as no deployment is. */
const localOnly = (env: NodeJS.ProcessEnv) => !env.RSVA_TRUST_PROXY && LOOPBACK.has(env.HOST ?? "127.0.0.1");

/**
 * A fixed sign-in code for a local run (RSVA_DEV_CODE, six digits; `pnpm dev` sets 000000), so signing in to a dev
 * server needs neither a mail nor the log. Only on a local-only server, which no deployment is; there it stands with or
 * without a mail key, and no code is mailed. Members and invited people only, as with any code.
 */
export function devCodeFromEnv(env: NodeJS.ProcessEnv): string | null {
  const code = env.RSVA_DEV_CODE;
  if (!code) return null;
  if (!/^\d{6}$/.test(code)) throw new Error("RSVA_DEV_CODE is six digits, e.g. 000000");
  if (!localOnly(env)) throw new Error("RSVA_DEV_CODE is only for a loopback-only server without a proxy");
  return code;
}

/**
 * Every mail comes from the product's name, the same on every server: only the address is the deployment's
 * (RSVA_MAIL_FROM, a bare address). A value with a name of its own stops the server, so no server sends as another
 * name again (PLNR-288: some mail came from "Plan", some from "PLNR").
 */
const SENDER_NAME = "recursiva";

export function senderFromEnv(address: string | undefined): string {
  if (!address) throw new Error("RSVA_MAIL_FROM is required with RESEND_API_KEY, e.g. 'plan@rsva.dev'");
  if (!/^[^\s<>@"]+@[^\s<>@"]+$/.test(address))
    throw new Error(`RSVA_MAIL_FROM is a bare address, e.g. 'plan@rsva.dev': the sender's name is ${SENDER_NAME} on every server`);
  return `${SENDER_NAME} <${address}>`;
}

export function mailerFromEnv(env: NodeJS.ProcessEnv, log: (msg: string) => void): Mailer {
  const key = env.RESEND_API_KEY;
  if (key) {
    const from = senderFromEnv(env.RSVA_MAIL_FROM);
    return async (m) => {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        // An empty html is a text-only mail (a person's choice on the Email page).
        body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), ...(m.headers ? { headers: m.headers } : {}), ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Resend answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    };
  }
  if (env.RSVA_MAIL !== "log") throw new Error("no mailer: set RESEND_API_KEY and RSVA_MAIL_FROM, or RSVA_MAIL=log for a local run");
  if (!localOnly(env) && env.RSVA_ALLOW_LOG_MAIL !== "1")
    throw new Error("RSVA_MAIL=log is only for a loopback-only server without a proxy: sign-in codes would reach the logs (RSVA_ALLOW_LOG_MAIL=1 if the logs are yours alone)");
  return async (m) => log(`mail to ${m.to}: ${m.subject}`);
}
