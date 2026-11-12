// The mail the server sends, each with its HTML and a text part written by hand: a text part stripped from the HTML glues
// a ledger's labels to its values. Names, passkey names and browsers are the client's words, cut to one line by mailText
// before they reach either part; `html` escapes them again for the HTML.
import { mailText, type Mail } from "../auth/mail.ts";
import { clipped, headline, noticeItem } from "../notify/words.ts";
import { button, codeCells, heading, html, issueList, ledger, linkInstead, mono, page, para, quote, strong, when, type Html, type Part } from "./template.ts";

const clock = (d: Date) => when(d).split(", ")[1]!;
/** A day as an invite's end or a token's expiry shows it: "Nov 9, 2026". */
const day = (d: Date) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(d);

/** The end of a sign-in code, in the mail and in Telegram (telegram/sign-in.ts). */
export const NOT_YOU = "Didn’t ask for a code? Someone typed your address. Without the code they can’t get in, so you can ignore this. We never ask for the code by phone or chat.";

export function signInCodeMail(to: string, code: string, expiresAt: Date, origin: string, now = new Date()): Mail {
  const expires = clock(expiresAt);
  return {
    to,
    subject: `${code} is your recursiva code`,
    text:
      `Your sign-in code: ${code}\n\n` +
      `Type it in the tab where you asked for it. It works once and expires at ${expires}, in 10 minutes.\n\n` +
      NOT_YOU,
    html: page({
      origin,
      sent: now,
      preheader: "Expires in 10 minutes.",
      overline: "Sign-in code",
      title: "Your sign-in code",
      blocks: [codeCells(code), para(["Type it in the tab where you asked for it. It works once and expires at ", strong(expires), ", in 10 minutes."]), ledger([["Requested", when(now)]])],
      footer: NOT_YOU,
    }),
  };
}

export function signInLinkMail(to: string, link: string, origin: string, now = new Date()): Mail {
  const why = "It comes instead of a code because many wrong codes were tried for this address today.";
  const ignore = "Didn’t try to sign in? Ignore this: without the link nobody can.";
  return {
    to,
    subject: "Your recursiva sign-in link",
    text: `Sign in: ${link}\n\nThe link works once, for 10 minutes. ${why}\n\n${ignore}`,
    html: page({
      origin,
      sent: now,
      preheader: "It works once, for 10 minutes.",
      overline: "Sign-in link",
      title: "Sign in to recursiva",
      blocks: [para(["The link works once, for ", strong("10 minutes"), `. ${why}`]), button(link, "Sign in"), linkInstead("Or open this link:", link)],
      footer: ignore,
    }),
  };
}

/** To an address let in from the waitlist (RSVA-542, ADR 0054): how to get in. */
export function admittedMail(to: string, origin: string, now = new Date()): Mail {
  const what = "You asked for access to recursiva, and your turn has come.";
  const how = "Sign in with this address: a code comes by email. Then create your workspace.";
  const why = "You get this because this address was put on the waitlist at rsva.dev.";
  return {
    to,
    subject: "You're in: recursiva",
    text: `${what}\n\n${how}\n\n${origin}\n\n${why}`,
    html: page({
      origin,
      sent: now,
      preheader: "Sign in and create your workspace.",
      overline: "Waitlist",
      title: "You're in",
      blocks: [para(what), para(how), button(origin, "Sign in"), linkInstead("Or open this link:", origin)],
      footer: why,
    }),
  };
}

export interface Invite {
  to: string;
  link: string;
  inviterName: string;
  workspaceName: string;
  role: "admin" | "member";
  expiresAt: Date;
  origin: string;
}

export function inviteMail(i: Invite, now = new Date()): Mail {
  const inviter = mailText(i.inviterName);
  const name = mailText(i.workspaceName);
  // In quotes in the subject and the text: a workspace's name is its creator's words, not the mail's.
  const title = `${inviter} invited you to "${name}"`;
  const role = i.role === "admin" ? "an admin" : "a member";
  const expires = day(i.expiresAt);
  const ignore = "Not expecting this? Ignore it: nothing happens until you open the link and sign in.";
  return {
    to: i.to,
    subject: title,
    text: `${inviter} invited you to "${name}" in recursiva as ${role}.\n\nJoin: ${i.link}\n\nThe link works for 7 days and only for ${i.to}. ${ignore}`,
    html: page({
      origin: i.origin,
      sent: now,
      preheader: `The invite expires on ${expires}.`,
      overline: "Invite",
      title,
      workspace: name,
      blocks: [
        para(["You join as ", strong(role), "."]),
        ledger([
          ["Workspace", name],
          ["Sign in as", mono(i.to)],
          ["Expires", `${expires}, in 7 days`],
        ]),
        button(i.link, `Join ${name}`),
        linkInstead("Or open this link:", i.link),
      ],
      footer: `The link works only for ${i.to}. ${ignore}`,
    }),
  };
}

/** The footer of every security mail. */
const SECURITY_FOOTER = "Security emails can’t be turned off.";
const NOTHING_TO_DO = "If it was you, there is nothing to do.";

/**
 * A mail that tells the person about a change to their account (a passkey, a chat, a sign-in, their address): the
 * text part, then the card with what happened, its details and what to do if it was not them. `then` follows that.
 */
function securityMail(m: { to: string; subject: string; text: string; origin: string; now: Date; title: string; workspace?: string; lead: string; rows: [string, string][]; notYou: string; then?: Html[] }): Mail {
  return {
    to: m.to,
    subject: m.subject,
    text: m.text,
    html: page({
      origin: m.origin,
      sent: m.now,
      preheader: "If it was you, there’s nothing to do.",
      overline: "Security",
      title: m.title,
      ...(m.workspace === undefined ? {} : { workspace: m.workspace }),
      blocks: [para(m.lead), ledger(m.rows), para(m.notYou), ...(m.then ?? [])],
      footer: SECURITY_FOOTER,
    }),
  };
}

export interface PasskeyNotice {
  to: string;
  passkeyName: string;
  userAgent: string;
  /** The site the passkey belongs to. */
  host: string;
  origin: string;
}

export function passkeyMail(n: PasskeyNotice, now = new Date()): Mail {
  const name = `"${mailText(n.passkeyName)}"`;
  const browser = mailText(n.userAgent);
  const notYou = "If it was not, someone else may be signed in as you: sign out your other devices in Settings › Security and tell the admin of your workspace right away.";
  return securityMail({
    to: n.to,
    subject: "A passkey was added to your recursiva account",
    text: `A passkey ${name} was added to your recursiva account on ${n.host} at ${when(now)}${browser ? `, from ${browser}` : ""}.\n\n${NOTHING_TO_DO} ${notYou}`,
    origin: n.origin,
    now,
    title: "A passkey was added to your account",
    lead: NOTHING_TO_DO,
    rows: [["Passkey", name], ["When", when(now)], ["Site", n.host], ...(browser ? ([["Browser", browser]] as [string, string][]) : [])],
    notYou,
  });
}

export interface TokenMade {
  to: string;
  tokenName: string;
  /** Whom the token acts as: the person themselves, or an agent of the workspace an admin made it for. */
  holder: { name: string; email: string; agent: boolean };
  scope: "read" | "write" | "custom";
  /** A custom token's grants: reads plus these (packages/policy). */
  grants: readonly string[];
  expiresAt: Date | null;
  /** Who made it, by name and address; for a person's own token, that person. When widened: who widened it. */
  createdBy: { name: string; email: string };
  /** A widened token's access before the change (RSVA-507); absent for a new token. */
  was?: { scope: "read" | "write" | "custom"; grants: readonly string[] };
  workspaceName: string;
  /** The deployment's origin; without one the mail names no site and has no images. */
  origin: string;
}

/** A token's access as a sentence ("read access and issues.write") and as a ledger row ("Read, issues.write"). */
const accessWords = (scope: TokenMade["scope"], grants: readonly string[]) => (scope === "custom" ? `read access and ${grants.join(", ")}` : `${scope} access`);
const accessRow = (scope: TokenMade["scope"], grants: readonly string[]) => (scope === "custom" ? `Read, ${grants.join(", ")}` : scope === "read" ? "Read" : "Write");

/**
 * A new API token (RSVA-188, after the MailSecurity artboard's block B), or one whose access was widened (RSVA-507, with
 * `was`): either outlives the session that did it, as a passkey does. An agent's goes to every owner of the workspace,
 * the person's own to that person, never the secret.
 */
export function tokenMadeMail(n: TokenMade, now = new Date()): Mail {
  const token = `"${mailText(n.tokenName)}"`;
  const name = mailText(n.workspaceName);
  const holder = mailText(n.holder.name);
  const by = `${mailText(n.createdBy.name)} (${n.createdBy.email})`;
  const expires = n.expiresAt ? day(n.expiresAt) : "Never";
  const meant = n.holder.agent ? "If it was meant, there is nothing to do." : NOTHING_TO_DO;
  const host = n.origin ? new URL(n.origin).host : null;
  const widened = n.was !== undefined;
  const what = `It ${widened ? "now acts" : "acts"} as ${n.holder.agent ? `the agent ${holder} (${n.holder.email})` : "you"} with ${accessWords(n.scope, n.grants)}${n.was ? ` (before: ${accessWords(n.was.scope, n.was.grants)})` : ""}`;
  const notYou = n.holder.agent
    ? `If nobody meant to ${widened ? "widen" : "make"} it, revoke it in Settings › API tokens of "${name}" right away, and ask ${mailText(n.createdBy.name)} to sign out their other devices in Settings › Security.`
    : `If it was not, someone else may be signed in as you: revoke it in Settings › API tokens of "${name}", sign out your other devices in Settings › Security, and tell the admin of your workspace right away.`;
  const rows: [string, string][] = [["Token", token]];
  if (n.holder.agent) rows.push(["Agent", `${holder} (${n.holder.email})`]);
  rows.push(["Access", accessRow(n.scope, n.grants)]);
  if (n.was) rows.push(["Before", accessRow(n.was.scope, n.was.grants)]);
  rows.push(["Expires", expires], [widened ? "Widened by" : "Created by", by], ["When", when(now)]);
  if (host) rows.push(["Site", host]);
  const subject = widened
    ? n.holder.agent
      ? `The access of ${holder}'s API token was widened in "${name}"`
      : `The access of your recursiva API token was widened in "${name}"`
    : n.holder.agent
      ? `An API token was made for ${holder} in "${name}"`
      : `An API token was made for your recursiva account in "${name}"`;
  const title = widened ? (n.holder.agent ? "An agent's API token was widened" : "Your API token was widened") : n.holder.agent ? "An agent got an API token" : "An API token was made for you";
  return securityMail({
    to: n.to,
    subject,
    text:
      `${widened ? `The access of the API token ${token} was widened` : `The API token ${token} was made`} in "${name}"${host ? ` on ${host}` : ""} at ${when(now)} by ${by}. ${what}, ${n.expiresAt ? `until ${expires}` : "with no expiry"}.\n\n` +
      `${meant} ${notYou}`,
    origin: n.origin,
    now,
    title,
    workspace: name,
    lead: `${what}. ${meant}`,
    rows,
    notYou,
  });
}

export interface TelegramLinked {
  to: string;
  /** The Telegram account's name and username, as Telegram sent them with Start. */
  chatName: string;
  username: string | null;
  /** The deployment's origin; without one the mail names no site and has no images. */
  origin: string;
}

/** The chat, its username, the time and the site, as the two personal-chat notices show them. */
function telegramFacts(n: TelegramLinked, now: Date) {
  const chat = mailText(n.chatName);
  const username = n.username ? `@${mailText(n.username)}` : null;
  const host = n.origin ? new URL(n.origin).host : null;
  const rows: [string, string][] = [["Telegram", chat]];
  if (username) rows.push(["Username", username]);
  rows.push(["When", when(now)]);
  if (host) rows.push(["Site", host]);
  return { who: `${chat}${username ? ` (${username})` : ""}`, on: host ? ` on ${host}` : "", rows };
}

/** A personal chat linked to the account (PLNR-223): sign-in codes go there too (PLNR-215), so the owner hears of it. */
export function telegramLinkedMail(n: TelegramLinked, now = new Date()): Mail {
  const { who, on, rows } = telegramFacts(n, now);
  const notYou = "If it was not, someone else may be signed in as you: disconnect it in Settings › Notifications › Telegram, sign out your other devices in Settings › Security, and tell the admin of your workspace right away.";
  return securityMail({
    to: n.to,
    subject: "Telegram was connected to your recursiva account",
    text: `The Telegram chat of ${who} was connected to your recursiva account${on} at ${when(now)}. Notifications and sign-in codes go there now.\n\n${NOTHING_TO_DO} ${notYou}`,
    origin: n.origin,
    now,
    title: "Telegram was connected to your account",
    lead: `Notifications and sign-in codes go to this chat now. ${NOTHING_TO_DO}`,
    rows,
    notYou,
  });
}

/**
 * Actions turned on in the personal chat (RSVA-496): from then the chat changes issues, comments and the inbox for the
 * person, so they hear of it as they do of a chat linked.
 */
export function telegramActionsMail(n: TelegramLinked, now = new Date()): Mail {
  const { who, on, rows } = telegramFacts(n, now);
  const notYou = "If it was not, someone else may be signed in as you: turn Actions off or disconnect the chat in Settings › Notifications › Telegram, sign out your other devices in Settings › Security, and tell the admin of your workspace right away.";
  return securityMail({
    to: n.to,
    subject: "Telegram can now act for your recursiva account",
    text: `Actions were turned on for the Telegram chat of ${who}${on} at ${when(now)}. Its buttons, commands and replies now change issues for you.\n\n${NOTHING_TO_DO} ${notYou}`,
    origin: n.origin,
    now,
    title: "Telegram can now act for you",
    lead: `Buttons, commands and replies in this chat now change issues for you. ${NOTHING_TO_DO}`,
    rows,
    notYou,
  });
}

export interface TelegramGroupLinked {
  to: string;
  /** The group's title as Telegram sent it: whoever made the group chose it. */
  groupTitle: string;
  workspaceName: string;
  /** The deployment's origin; without one the mail names no site and has no images. */
  origin: string;
}

/**
 * A group chat linked by the account (PLNR-246): it gets the workspace's notifications picked for it, also after the
 * session that linked it ends, so the owner hears of it.
 */
export function telegramGroupLinkedMail(n: TelegramGroupLinked, now = new Date()): Mail {
  const group = `"${mailText(n.groupTitle)}"`;
  const name = mailText(n.workspaceName);
  const host = n.origin ? new URL(n.origin).host : null;
  const what = "Everyone in the group sees the notifications picked for it, as far as you may read them.";
  const notYou =
    "If it was not, remove the group in Settings › Notifications › Telegram, sign out your other devices in Settings › Security, and tell the admin of your workspace right away.";
  const rows: [string, string][] = [["Group", group], ["Workspace", name], ["When", when(now)]];
  if (host) rows.push(["Site", host]);
  return securityMail({
    to: n.to,
    subject: `A Telegram group was linked to "${name}"`,
    text: `The Telegram group ${group} was linked to "${name}" from your recursiva account${host ? ` on ${host}` : ""} at ${when(now)}. ${what}\n\n${NOTHING_TO_DO} ${notYou}`,
    origin: n.origin,
    now,
    title: "A Telegram group was linked",
    workspace: name,
    lead: `${what} ${NOTHING_TO_DO}`,
    rows,
    notYou,
  });
}

export interface NewSignIn {
  to: string;
  /** "Chrome on macOS" (auth/device.ts). */
  device: string;
  method: "code" | "passkey";
  ip: string;
  /** The deployment's origin; without one the mail names no site and has no images. */
  origin: string;
}

const BY = { code: "an email code", passkey: "a passkey" } as const;

/** A sign-in from a browser the person had not signed in from (PLNR-252, auth/devices.ts). */
export function newSignInMail(n: NewSignIn, now = new Date()): Mail {
  const device = mailText(n.device);
  const ip = mailText(n.ip);
  const host = n.origin ? new URL(n.origin).host : null;
  const notYou =
    "If it was not, sign that session out in Settings › Security, and tell the admin of your workspace right away." +
    (n.method === "code" ? " Whoever it was got the sign-in code from this address: a new browser’s code goes nowhere else. Secure it too." : "");
  const rows: [string, string][] = [["Browser", device], ["Signed in with", BY[n.method]], ["When", when(now)]];
  if (ip) rows.push(["IP address", ip]);
  if (host) rows.push(["Site", host]);
  return securityMail({
    to: n.to,
    subject: "New sign-in to your recursiva account",
    text:
      `Someone signed in to your recursiva account${host ? ` on ${host}` : ""} at ${when(now)} from a new browser: ` +
      `${device}, with ${BY[n.method]}${ip ? `, from ${ip}` : ""}.\n\n${NOTHING_TO_DO} ${notYou}`,
    origin: n.origin,
    now,
    title: "New sign-in to your account",
    lead: `Someone signed in to your account from a browser it had not been signed in from. ${NOTHING_TO_DO}`,
    rows,
    notYou,
  });
}

/** The code that confirms a new sign-in address (PLNR-197): it goes to that address, before the account takes it. */
export function emailCodeMail(to: string, code: string, expiresAt: Date, origin: string, now = new Date()): Mail {
  const expires = clock(expiresAt);
  const notYou = "Didn’t ask for this? Someone typed your address as their new one. Without the code it doesn’t become theirs, so you can ignore this.";
  return {
    to,
    subject: `${code} confirms your new recursiva email`,
    text: `Your code: ${code}\n\nType it in Settings › Profile to make ${to} your sign-in email. It works once and expires at ${expires}, in 10 minutes.\n\n${notYou}`,
    html: page({
      origin,
      sent: now,
      preheader: "Expires in 10 minutes.",
      overline: "New email",
      title: "Confirm your new email",
      blocks: [codeCells(code), para(["Type it in Settings › Profile to make ", strong(to), " your sign-in email. It works once and expires at ", strong(expires), ", in 10 minutes."])],
      footer: notYou,
    }),
  };
}

/**
 * Instead of a code, when the new address already has an account: only its owner learns that, and the person who typed
 * it learns nothing they could not have learned from a sign-in form.
 */
export function emailTakenMail(to: string, origin: string, now = new Date()): Mail {
  const what = "Someone asked to make this address the sign-in email of another recursiva account. It already has an account of its own, so nothing changed.";
  const next = "If it was you, sign in with this address instead. If not, you can ignore this.";
  return {
    to,
    subject: "Your recursiva email was not changed",
    text: `${what}\n\n${next}`,
    html: page({ origin, sent: now, preheader: "Nothing changed.", overline: "Security", title: "This address already has an account", blocks: [para(what), para(next)], footer: SECURITY_FOOTER }),
  };
}

export interface EmailChanged {
  /** The address that was replaced: the mail goes there. */
  to: string;
  newEmail: string;
  userAgent: string;
  /** The link that puts `to` back, with its secret. */
  revert: string;
  origin: string;
}

/** To the address an account left (PLNR-197): what changed, and the link back for 7 days. */
export function emailChangedMail(n: EmailChanged, now = new Date()): Mail {
  const browser = mailText(n.userAgent);
  const notYou = "If it was not you, change it back: the link puts this address back, signs out every device and removes the passkeys, API tokens and Telegram links added since the change. Then sign in with this address. The link works for 7 days.";
  return securityMail({
    to: n.to,
    subject: "Your recursiva email was changed",
    text:
      `The sign-in email of your recursiva account was changed from ${n.to} to ${n.newEmail} at ${when(now)}${browser ? `, from ${browser}` : ""}.\n\n` +
      `${NOTHING_TO_DO} ${notYou}\n\nChange it back: ${n.revert}`,
    origin: n.origin,
    now,
    title: "Your email was changed",
    lead: NOTHING_TO_DO,
    rows: [["From", n.to], ["To", n.newEmail], ["When", when(now)], ...(browser ? ([["Browser", browser]] as [string, string][]) : [])],
    notYou,
    then: [button(n.revert, "Change it back"), linkInstead("Or open this link:", n.revert)],
  });
}

/** To the address an account was changed to, when the link from the old one put that back (PLNR-197). */
export function emailRevertedMail(to: string, restored: string, origin: string, now = new Date()): Mail {
  const what = `The sign-in email of your recursiva account was changed back to ${restored} at ${when(now)}, with the link sent there after the change. Every device was signed out.`;
  const next = "This address is no longer on the account. If you did not expect this, ask the admin of your workspace.";
  return {
    to,
    subject: "Your recursiva email was changed back",
    text: `${what}\n\n${next}`,
    html: page({ origin, sent: now, preheader: "Every device was signed out.", overline: "Security", title: "Your email was changed back", blocks: [para(what), para(next)], footer: SECURITY_FOOTER }),
  };
}

/** One notification by email (PLNR-200): what happened on an issue, by whom, and the comment if there is one. */
export interface IssueNotice {
  to: string;
  kind: "assigned" | "review" | "approved" | "state" | "mention" | "reply" | "comment";
  /** "plan" when an agent moved the issue into review (the "Agent asks for a review" row). */
  byAgent: boolean;
  actor: string;
  issueKey: string;
  issueTitle: string;
  stateName?: string;
  comment?: string;
  workspace: string;
  link: string;
  settings: string;
  origin: string;
  /** The person's unsubscribe link (notify/unsubscribe.ts). */
  unsubscribe: string;
  /** Message-ID of this mail and the issue's thread, so a mail client groups an issue's notifications. */
  messageId: string;
  threadId: string;
  /** Sent in place of a Telegram message: the person's chat stopped taking them (PLNR-204). */
  instead?: boolean;
  /** The mail's own reply address (PLNR-211): a reply to it posts as the person's comment. */
  replyTo?: string;
}

/**
 * The first line of a mail that takes replies (PLNR-211). The reply's text is cut where a mail client quotes it
 * (mail/inbound.ts, replyText), whatever the client writes above the quote.
 */
export const REPLY_LINE = "Reply above this line";

/** The footer of every notification email: why, where to change it, and the way out. */
function notifyFooter(why: string, settings: string, unsubscribe: string): { text: string; html: Part } {
  return {
    text: `${why} Change what reaches you by email: ${settings}\nUnsubscribe from notification emails: ${unsubscribe}`,
    html: [`${why} `, html`<a href="${settings}" style="color:inherit">Change what reaches you by email</a>`, " · ", html`<a href="${unsubscribe}" style="color:inherit">Unsubscribe</a>`],
  };
}

export function issueMail(n: IssueNotice, now = new Date()): Mail {
  const { overline, title, why } = headline(n);
  const key = n.issueKey;
  const { comment, title: issueTitle } = clipped(n);
  const footer = notifyFooter(n.instead ? `You get this by email because ${why} and Telegram stopped delivering to your chat.` : `You get this because ${why}.`, n.settings, n.unsubscribe);
  return {
    to: n.to,
    // The same subject for every notification of an issue: mail clients that thread by subject keep them together.
    subject: `[${key}] ${issueTitle}`,
    headers: {
      "Message-ID": n.messageId,
      "In-Reply-To": n.threadId,
      References: n.threadId,
      // A reply would post: an out-of-office answer must not, or two people away answer each other's comments forever.
      ...(n.replyTo ? { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" } : {}),
    },
    ...(n.replyTo ? { replyTo: n.replyTo } : {}),
    text: `${n.replyTo ? `${above(key)}\n\n` : ""}${title}\n${key} ${issueTitle}\n${comment === undefined ? "" : `\n${comment}\n`}\nOpen: ${n.link}\n\n${footer.text}`,
    html: page({
      origin: n.origin,
      sent: now,
      preheader: comment ?? issueTitle,
      overline,
      title,
      workspace: mailText(n.workspace),
      blocks: [para([mono(key), " ", strong(issueTitle)]), ...(comment === undefined ? [] : [quote(comment)]), button(n.link, `Open ${key}`)],
      footer: footer.html,
      ...(n.replyTo ? { above: above(key) } : {}),
    }),
  };
}

const above = (key: string) => `${REPLY_LINE} to comment on ${key}`;

/** A reply by email that did not post (PLNR-211), told to the person's own address. */
export interface ReplyRefused {
  to: string;
  /** The issue, when the reply could be tied to one the person may still see. */
  issueKey?: string;
  link?: string;
  why: string;
  origin: string;
  /** The address was too old: then a newer notification is where to reply. */
  stale?: boolean;
}

export function replyRefusedMail(n: ReplyRefused, now = new Date()): Mail {
  const where = n.issueKey ? ` to ${n.issueKey}` : "";
  return {
    to: n.to,
    subject: `Your reply was not posted${where}`,
    text: `Your reply by email was not posted${where}: ${n.why}${n.link ? `\n\nOpen ${n.issueKey}: ${n.link}` : ""}`,
    html: page({
      origin: n.origin,
      sent: now,
      preheader: n.why,
      overline: "Reply by email",
      title: `Your reply was not posted${where}`,
      blocks: [para(n.why), ...(n.link && n.issueKey ? [button(n.link, `Open ${n.issueKey}`)] : [])],
      footer: n.stale ? "Nothing was posted. Reply to the newest notification of the issue, or comment in recursiva." : "Nothing was posted.",
    }),
  };
}

/** Instant emails bundled every 30 minutes (PLNR-208): one mail with a row per notification, oldest first. */
export function bundleMail(items: IssueNotice[], now = new Date()): Mail {
  const first = items[0]!;
  const keys = [...new Set(items.map((n) => n.issueKey))];
  const title = `${items.length} updates on ${keys.length === 1 ? keys[0] : `${keys.length} issues`}`;
  const rows = items.map(noticeItem);
  const footer = notifyFooter("You get these every 30 minutes, as you chose on the Email page.", first.settings, first.unsubscribe);
  return {
    to: first.to,
    subject: `${title}: ${keys.slice(0, 3).join(", ")}${keys.length > 3 ? "…" : ""}`,
    text: `${title}\n\n${rows.map((r) => `${r.line}\n${r.key} ${r.title}\n${r.link}`).join("\n\n")}\n\n${footer.text}`,
    html: page({ origin: first.origin, sent: now, preheader: rows[0]!.line, overline: "Updates", title, blocks: [issueList(rows)], footer: footer.html }),
  };
}

/** A row of a digest: an issue, its link, and what to know about it. */
export interface DigestItem {
  key: string;
  title: string;
  link: string;
  line?: string;
}

/** Who a digest-like mail goes to, and its footer's links. */
interface Addressed {
  to: string;
  origin: string;
  settings: string;
  unsubscribe: string;
  /** "Tuesday, Nov 3" in the person's zone. */
  day: string;
}

export interface Digest extends Addressed {
  waiting: DigestItem[];
  due: DigestItem[];
  /** Cycles the person leads that start or end today (PLNR-206), when their email cell is Digest. */
  cycles: DigestItem[];
  finished: DigestItem[];
  /** What the person put in the digest since the last one (Digest cells). */
  updates: DigestItem[];
}

const sectionText = (name: string, items: DigestItem[]) =>
  items.length ? `${name}\n${items.map((i) => `- ${i.key} ${i.title}${i.line ? ` (${i.line})` : ""}\n  ${i.link}`).join("\n")}\n\n` : "";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A mail of the day in sections of issues and cycles, empty ones left out: the digest and the morning mail. */
function sectionsMail(a: Addressed, s: { title: string; counts: string; empty: string; why: string; parts: [string, DigestItem[]][] }, now: Date): Mail {
  const footer = notifyFooter(s.why, a.settings, a.unsubscribe);
  const none = s.parts.every(([, i]) => !i.length);
  return {
    to: a.to,
    subject: `${a.day}: ${s.counts || s.empty}`,
    text: `${s.title}\n\n${s.parts.map(([n, i]) => sectionText(n, i)).join("") || "Nothing new.\n\n"}${footer.text}`,
    html: page({
      origin: a.origin,
      sent: now,
      preheader: s.counts || "Nothing waits on you today.",
      overline: a.day,
      title: s.title,
      blocks: s.parts.flatMap(([n, items]) => (items.length ? [heading(n), issueList(items)] : [])).concat(none ? [para("Nothing new.")] : []),
      footer: footer.html,
    }),
  };
}

/** The morning digest (PLNR-201): what waits on the person, what is due today, what agents finished, and the rest. */
export function digestMail(d: Digest, now = new Date()): Mail {
  const counts = [d.waiting.length && `${d.waiting.length} waiting on you`, d.due.length && `${d.due.length} due today`].filter(Boolean).join(", ");
  const parts: [string, DigestItem[]][] = [
    ["Waiting on you", d.waiting],
    ["Due today", d.due],
    ["Cycles", d.cycles],
    ["Agents finished", d.finished],
    ["Since the last digest", d.updates],
  ];
  return sectionsMail(d, { title: counts ? `Good morning: ${counts}` : "Good morning", counts, empty: "your digest", why: "The morning digest, on the days you chose.", parts }, now);
}

export interface Morning extends Addressed {
  due: DigestItem[];
  cycles: DigestItem[];
}

/** What is due today and the cycles of the day (PLNR-206), at the digest time, for the rows set to Instantly by email. */
export function morningMail(m: Morning, now = new Date()): Mail {
  const counts = [m.due.length && `${count(m.due.length, "issue", "issues")} due today`, m.cycles.length && `${count(m.cycles.length, "cycle", "cycles")} starting or ending`].filter(Boolean).join(", ");
  const parts: [string, DigestItem[]][] = [
    ["Due today", m.due],
    ["Cycles", m.cycles],
  ];
  const title = counts.charAt(0).toUpperCase() + counts.slice(1);
  return sectionsMail(m, { title, counts, empty: "today", why: "You set due today or cycles to Instantly by email.", parts }, now);
}

export interface WeeklySummary {
  to: string;
  origin: string;
  settings: string;
  unsubscribe: string;
  /** "Oct 27 – Nov 2". */
  range: string;
  cycles: { name: string; project: string; done: number; open: number }[];
  projects: { key: string; name: string; done: number }[];
  /** Issues done by agents in the week. */
  agents: number;
}

/** The weekly summary (PLNR-201): cycles that ended, done per project, how much agents did. */
export function weeklyMail(w: WeeklySummary, now = new Date()): Mail {
  const done = w.projects.reduce((n, p) => n + p.done, 0);
  const title = `${done} ${done === 1 ? "issue" : "issues"} done this week`;
  const footer = notifyFooter("The weekly summary, on Mondays.", w.settings, w.unsubscribe);
  const cycles = w.cycles.map((c): [string, string] => [`${c.project} · ${mailText(c.name)}`, `${c.done} done, ${c.open} carried over`]);
  const projects = w.projects.map((p): [string, string] => [`${p.key} ${mailText(p.name)}`, `${p.done} done`]);
  const lines = (rows: [string, string][]) => rows.map(([a, b]) => `- ${a}: ${b}`).join("\n");
  return {
    to: w.to,
    subject: `Week of ${w.range}: ${title}`,
    text: `${title}, ${w.agents} by agents.\n\n${cycles.length ? `Cycles that ended\n${lines(cycles)}\n\n` : ""}${projects.length ? `Done per project\n${lines(projects)}\n\n` : ""}${footer.text}`,
    html: page({
      origin: w.origin,
      sent: now,
      preheader: `${w.agents} by agents.`,
      overline: `Week of ${w.range}`,
      title,
      blocks: [
        para([strong(String(w.agents)), ` of them by agents.`]),
        ...(cycles.length ? [heading("Cycles that ended"), ledger(cycles)] : []),
        ...(projects.length ? [heading("Done per project"), ledger(projects)] : []),
      ],
      footer: footer.html,
    }),
  };
}
