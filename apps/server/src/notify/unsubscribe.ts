// Unsubscribing from notification email without signing in (PLNR-208): every notification, digest and summary carries a
// link with the person's id and a random key of theirs, and the List-Unsubscribe headers that let a mail client do it
// in one click (RFC 8058: a POST with "List-Unsubscribe=One-Click"). It turns every email cell, the digest and the weekly
// summary off, as "Unsubscribe from everything" on the Email page does; sign-in and security mail are not notifications.
//
// The key is random, kept in account_settings.unsubscribe_key and made with the first such email. It can only unsubscribe:
// a leaked link costs its owner their notification email, which they turn back on in the settings.
import { unsubscribed, type NotifyPrefs } from "@rsva/protocol";
import { UUID } from "@rsva/schema/models";
import type { Mail } from "../auth/mail.ts";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomSecret, sameSecret } from "../auth/secret.ts";
import { db, schema } from "../db.ts";
import { prefsOf, savePrefs } from "./prefs.ts";

const { accountSettings } = schema;

/** A mail to this person as their settings want it: text only if they chose so, with their unsubscribe headers. */
export function forPerson(mail: Mail, prefs: NotifyPrefs, headers: Record<string, string>): Mail {
  return { ...mail, ...(prefs.email.textOnly ? { html: "" } : {}), headers: { ...mail.headers, ...headers } };
}

/** The link and headers for this person's mail; the key is made on first use. */
export async function unsubscribeLink(userId: string, origin: string): Promise<{ link: string; headers: Record<string, string> }> {
  await db.insert(accountSettings).values({ userId }).onConflictDoNothing();
  await db.update(accountSettings).set({ unsubscribeKey: randomSecret() }).where(and(eq(accountSettings.userId, userId), isNull(accountSettings.unsubscribeKey)));
  const [row] = await db.select({ key: accountSettings.unsubscribeKey }).from(accountSettings).where(eq(accountSettings.userId, userId));
  const link = `${origin}/notify/unsubscribe?u=${userId}&k=${row!.key}`;
  return { link, headers: { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
}

async function keyMatches(userId: unknown, key: unknown): Promise<string | null> {
  if (typeof userId !== "string" || !UUID.test(userId) || typeof key !== "string" || !key) return null;
  const [row] = await db.select({ key: accountSettings.unsubscribeKey }).from(accountSettings).where(eq(accountSettings.userId, userId));
  return row?.key && sameSecret(row.key, key) ? userId : null;
}

const PAGE = (body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>recursiva notifications</title>` +
  `<body style="margin:0;font:15px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#1d1c1a"><main style="max-width:420px;margin:12vh auto;padding:0 16px">${body}</main></body></html>`;

export function registerUnsubscribe(root: FastifyInstance): void {
  void root.register(async (app) => routes(app));
}

function routes(app: FastifyInstance): void {
  // The form and a mail client post "List-Unsubscribe=One-Click", urlencoded or, as RFC 8058 recommends, multipart; the
  // body says nothing the query does not.
  app.addContentTypeParser(["application/x-www-form-urlencoded", "multipart/form-data"], { parseAs: "string", bodyLimit: 4096 }, (_req, _body, done) => done(null, {}));

  // The page a person opens from the link: one button, so a link scanner that follows it unsubscribes nobody.
  app.get<{ Querystring: { u?: string; k?: string } }>("/notify/unsubscribe", async (req, reply) => {
    const ok = await keyMatches(req.query.u, req.query.k);
    reply.type("text/html; charset=utf-8").header("cache-control", "no-store");
    if (!ok) return reply.code(404).send(PAGE("<h1 style=\"font-size:20px\">This link no longer works</h1><p>Change what reaches you by email in recursiva, Settings › Notifications.</p>"));
    return PAGE(
      `<h1 style="font-size:20px">Stop notification emails?</h1><p>Every email notification, the morning digest and the weekly summary stop. Sign-in codes and security emails still arrive. You can turn them back on in Settings › Notifications.</p>` +
        `<form method="post"><button style="font:inherit;padding:10px 18px;border:0;border-radius:6px;background:#1d1c1a;color:#fff;cursor:pointer">Unsubscribe</button></form>`,
    );
  });

  // The button above, and a mail client's one-click unsubscribe: both are POSTs to the same address.
  app.post<{ Querystring: { u?: string; k?: string } }>("/notify/unsubscribe", async (req, reply) => {
    const userId = await keyMatches(req.query.u, req.query.k);
    if (!userId) return reply.code(404).type("text/html; charset=utf-8").send(PAGE("<h1 style=\"font-size:20px\">This link no longer works</h1>"));
    await savePrefs(userId, unsubscribed((await prefsOf([userId])).get(userId)!.prefs));
    return reply.type("text/html; charset=utf-8").send(PAGE("<h1 style=\"font-size:20px\">Unsubscribed</h1><p>No more notification emails. Turn them back on in recursiva, Settings › Notifications.</p>"));
  });
}

