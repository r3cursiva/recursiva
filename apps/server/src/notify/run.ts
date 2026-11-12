// The notifier's loop (PLNR-200): classify what the logs gained (follow.ts), then send what is due (send.ts, and
// telegram.ts when the server has a bot, group chats included), the digests (digest.ts) and the day's notices
// (morning.ts, group chats' cycles included). It runs every TICK_MS, and sooner after a write in this process:
// notifyChanged() is called when a transaction is published (sync/write.ts). Writes of another process or an import
// are picked up by the tick. Started by main.ts only: test servers do not mail notifications unless a test runs the
// steps itself.
import type { Mailer } from "../auth/mail.ts";
import { behind, follow } from "./follow.ts";
import { sendDigests } from "./digest.ts";
import { sendGroupCycles, sendMornings } from "./morning.ts";
import { sendDue } from "./send.ts";
import { sendGroupsDue, sendTelegramDue } from "./telegram.ts";
import type { TelegramApi } from "../telegram/api.ts";

const TICK_MS = 30_000;
/** A burst of writes wakes the loop once. */
const SETTLE_MS = 1_000;

let wake: (() => void) | null = null;

/** Called after every published transaction; does nothing until the notifier runs. */
export function notifyChanged(): void {
  wake?.();
}

/** One pass: every workspace's new actions classified, then everything due sent. */
async function notifyPass(mailer: Mailer, origin: string, log: Log, tg: TelegramApi | null, replyDomain: string | null): Promise<void> {
  // One workspace that fails (its cursor stays, the next pass tries again) does not stop the others or the sending.
  for (const ws of await behind()) {
    try {
      while (await follow(ws, new Date(), !!tg));
    } catch (e) {
      log.error(e, `notifier could not read the log of workspace ${ws}`);
    }
  }
  while ((await sendDue(mailer, origin, new Date(), null, replyDomain)) > 0);
  if (tg) {
    while ((await sendTelegramDue(tg, origin, new Date(), null)) > 0);
    while ((await sendGroupsDue(tg, origin, new Date(), null)) > 0);
  }
  // Emails in place of Telegram messages that refused just now go in this pass, not the next.
  while ((await sendDue(mailer, origin, new Date(), null, replyDomain)) > 0);
  await sendDigests(mailer, origin, log);
  await sendMornings(mailer, origin, log, tg);
  if (tg) await sendGroupCycles(tg, origin, log, new Date(), null);
}

type Log = { error: (e: unknown, msg: string) => void };

/**
 * Starts the loop; the function it returns stops it and resolves once a pass under way has finished. With `replyDomain`
 * (the server takes replies, mail/inbound.ts) a single notification email gets its own reply address.
 */
export function startNotifier(mailer: Mailer, origin: string, log: Log, tg: TelegramApi | null = null, replyDomain: string | null = null): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  let soon: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const run = (): void => {
    if (stopped) return;
    if (running) return void (again = true);
    running = notifyPass(mailer, origin, log, tg, replyDomain)
      .catch((e: unknown) => log.error(e, "notifier pass failed"))
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          run();
        }
      });
  };
  wake = () => {
    clearTimeout(soon);
    soon = setTimeout(run, SETTLE_MS);
  };
  const tick = setInterval(run, TICK_MS);
  tick.unref();
  run();
  return async () => {
    stopped = true;
    wake = null;
    clearInterval(tick);
    clearTimeout(soon);
    await running;
  };
}
