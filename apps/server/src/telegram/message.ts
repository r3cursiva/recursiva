// What a Telegram message says (PLNR-202), after the TgChat artboard: the issue and why on the first line, what happened
// in bold, the issue's title as its link, and with "With the comment" the comment it is about. The words are the
// emails' (headline in mail/emails.ts): an event reads the same in the mail and in the chat.
import type { DigestItem, IssueNotice } from "../mail/emails.ts";
import { clipped, headline } from "../notify/words.ts";
import { mailText } from "../auth/mail.ts";
import { html, type Part } from "../mail/template.ts";

export type TelegramNotice = Pick<IssueNotice, "kind" | "byAgent" | "actor" | "issueKey" | "issueTitle" | "stateName" | "comment" | "link"> & { urgent: boolean };

export function telegramMessage(n: TelegramNotice, length: "short" | "full"): string {
  const { overline, title } = headline(n);
  // The same clipping as the email's: well inside Telegram's 4096 characters.
  const clip = clipped(n);
  return layout(n, `${overline}${n.urgent ? " · urgent" : ""}`, title, length === "full" ? clip.comment : undefined);
}

function layout(n: Pick<TelegramNotice, "issueKey" | "link" | "issueTitle">, overline: string, title: string, comment: string | undefined): string {
  const lines: Part[] = [
    html`<code>${n.issueKey}</code> · ${overline}`,
    html`<b>${title}</b>`,
    html`<a href="${n.link}">${clipped({ issueTitle: n.issueTitle }).title}</a>`,
    comment ? html`<blockquote>${comment}</blockquote>` : null,
  ];
  return html`${lines.filter(Boolean).map((l, i) => [i ? "\n" : "", l])}`.value;
}

/** What happened in a group chat's project (PLNR-204): the event the group was given, as everyone there reads it. */
export type GroupKind = "urgent_created" | "urgent_raised" | "plan";
export function groupMessage(n: Pick<TelegramNotice, "actor" | "issueKey" | "issueTitle" | "link">, kind: GroupKind): string {
  const actor = mailText(n.actor);
  const what: Record<GroupKind, [overline: string, title: string]> = {
    urgent_created: ["New urgent issue", `${actor} created ${n.issueKey} as urgent`],
    urgent_raised: ["Raised to urgent", `${actor} raised ${n.issueKey} to urgent`],
    plan: ["Plan waiting for approval", `${actor} moved ${n.issueKey} into review`],
  };
  const [overline, title] = what[kind];
  return layout(n, overline, title, undefined);
}

/** Lines per list in the morning message: well inside Telegram's 4096 characters; the rest is counted. */
const MORNING_LINES = 10;

/** What is due today and the cycles of the day (PLNR-206): one message at the digest time, a line per issue or cycle. */
export function morningMessage(m: { due: DigestItem[]; cycles: DigestItem[] }): string {
  const list = (name: string, items: DigestItem[]): Part[] =>
    items.length
      ? [
          html`<b>${name}</b>`,
          ...items.slice(0, MORNING_LINES).map((i) => html`<code>${i.key}</code> <a href="${i.link}">${clipped({ issueTitle: i.title }).title}</a>${i.line ? ` · ${i.line}` : ""}`),
          ...(items.length > MORNING_LINES ? [html`and ${items.length - MORNING_LINES} more`] : []),
        ]
      : [];
  const blocks = [list("Due today", m.due), list("Cycles", m.cycles)].filter((b) => b.length);
  return html`${blocks.map((b, i) => [i ? "\n\n" : "", b.map((l, j) => [j ? "\n" : "", l])])}`.value;
}

/** An address for a chat to show without giving it away: the first character, `•••`, the domain. `ann@example.com` is `a•••@example.com`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "•••" : `${[...email.slice(0, at)][0] ?? ""}•••${email.slice(at)}`;
}

/** The message a new chat gets at once, and "Send a test" sends again: whose chat it now is, by name and masked address (PLNR-256). */
export function testMessage(name: string, maskedEmail: string, settings: string, actions: boolean): string {
  const act = actions ? "Reply to a notification and your reply posts as a comment on its issue." : "Notifications only: buttons, commands and replies are off until you turn on Actions in Settings › Notifications › Telegram.";
  return html`<b>recursiva is connected</b>\nThis chat gets what you set to Instantly for Telegram, as ${name} (${maskedEmail}). Change it in <a href="${settings}">Settings › Notifications</a>.\n${act}`.value;
}
