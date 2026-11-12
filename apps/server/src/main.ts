import { resolve } from "node:path";
import { TELEGRAM_COMMANDS } from "@rsva/protocol";
import { buildApp } from "./app.ts";
import { mailerFromEnv, PUBLIC_ORIGIN } from "./auth/mail.ts";
import { inboundFromEnv } from "./mail/inbound.ts";
import { startNotifier } from "./notify/run.ts";
import { sweepCodes } from "./auth/codes.ts";
import { sweepEmailChanges } from "./auth/email-change.ts";
import { sweepDevices } from "./auth/devices.ts";
import { sweepSessions } from "./auth/sessions.ts";
import { migrateDb, sql } from "./db.ts";
import { loadStatic, type StaticFile } from "./static.ts";
import { sweepTrash } from "./sync/purge.ts";
import { sweepCycles } from "./sync/rollover.ts";
import { closeSockets } from "./sync/socket.ts";
import { telegramFromEnv } from "./telegram/api.ts";

const port = Number(process.env.PORT ?? 3800);
// Loopback by default; production sets HOST and puts Caddy in front (RSVA_ALLOWED_HOSTS/ORIGINS, RSVA_TRUST_PROXY).
const host = process.env.HOST ?? "127.0.0.1";
const webDist = resolve(process.env.WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname);

await migrateDb();
let files = new Map<string, StaticFile>();
let staticError = false;
try {
  files = loadStatic(webDist);
} catch {
  staticError = true;
}
// One mailer for sign-in mail and notifications; on a local run (RSVA_MAIL=log) it writes to the server's log.
let mailLog = (msg: string) => console.warn(msg);
const mailer = mailerFromEnv(process.env, (msg) => mailLog(msg));
const telegram = telegramFromEnv();
// Replies by email (PLNR-211): the webhook and the reply addresses of the notifier, from one reading of the setup.
const inbound = inboundFromEnv();
// Notifications by email (PLNR-200). Only where asked for (RSVA_NOTIFY=on, the live server's rsva.env), or with mail
// to the log: a local run holds a copy of the live data with real addresses, and often the real mail key too.
const notify = process.env.RSVA_NOTIFY === "on" || (process.env.RSVA_NOTIFY !== "off" && !process.env.RESEND_API_KEY);
// Telegram goes only from the live server (RSVA_NOTIFY=on), notifications and sign-in codes alike: a local run on a
// copy of the data holds real chat IDs, and mail to the log does not make its messages to them any less real.
const telegramLive = telegram && process.env.RSVA_NOTIFY === "on" ? telegram : null;
const app = buildApp({ files, mailer, telegram, signInTelegram: telegramLive?.api ?? null, inbound });
mailLog = (msg) => app.log.warn(msg);
if (staticError) app.log.warn({ webDist }, "no web build, serving API only");
else app.log.info({ files: files.size, webDist }, "static loaded");

const stopNotifier = notify ? startNotifier(mailer, PUBLIC_ORIGIN ?? `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`, app.log, telegramLive?.api ?? null, inbound?.domain ?? null) : async () => {};
if (!notify) app.log.warn("notifications are not mailed: set RSVA_NOTIFY=on to mail them");

// Telegram (PLNR-202) calls back the server that registered last, so only the live one does (and with its https origin):
// a local run with a copy of the token would take the bot's messages away from it.
if (telegramLive && PUBLIC_ORIGIN)
  void telegramLive.api
    .setWebhook(`${PUBLIC_ORIGIN}/api/telegram/webhook`, telegramLive.secret)
    .then(() => app.log.info("telegram webhook registered"))
    // The command menu (PLNR-205) is Telegram's own list: commands work without it.
    .then(() => telegramLive.api.setCommands(TELEGRAM_COMMANDS).catch((e: unknown) => app.log.error(e, "telegram commands not registered")))
    .catch((e: unknown) => app.log.error(e, "telegram webhook not registered"));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // A stuck request must not keep the old process alive past a restart.
    setTimeout(() => process.exit(1), 5000).unref();
    // A mail being sent finishes and is marked, so it does not go again after its lease.
    void stopNotifier()
      .then(() => app.close())
      .then(() => sql.end({ timeout: 2 }))
      .then(() => process.exit(0));
  });
}

// Ended sessions and old codes are refused on use anyway; this only keeps the tables small.
// Sockets of swept sessions close too (they would on their next re-check anyway).
setInterval(
  () =>
    void Promise.all([sweepSessions().then((ids) => ids.forEach(closeSockets)), sweepCodes(), sweepEmailChanges(), sweepDevices()]).catch((e: unknown) => app.log.error(e, "sign-in sweep failed")),
  3_600_000,
).unref();

// Hourly, and at start so that a server that was off catches up: cycles that are over complete themselves in projects
// that ask for it (sync/rollover.ts), then issues in the trash for 30 days are deleted for good (sync/purge.ts). A sweep
// still running when the next is due is not doubled.
let sweeping = false;
const hourly = () => {
  if (sweeping) return;
  sweeping = true;
  void sweepCycles((e, cycleId) => app.log.error({ err: e, cycleId }, "cycle rollover failed"))
    .then((n) => n && app.log.info({ cycles: n }, "cycles rolled over"))
    .catch((e: unknown) => app.log.error(e, "cycle rollover sweep failed"))
    .then(() => sweepTrash((e, issueId) => app.log.error({ err: e, issueId }, "trash purge failed")))
    .then((n) => n && app.log.info({ issues: n }, "issues deleted from the trash for good"))
    .catch((e: unknown) => app.log.error(e, "trash sweep failed"))
    .finally(() => (sweeping = false));
};
setInterval(hourly, 3_600_000).unref();

await app.listen({ port, host });
hourly();
