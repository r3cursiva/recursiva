// One filled-in copy of every email: what the tests read and the preview writes out.
import type { Mail } from "../auth/mail.ts";
import { admittedMail, emailChangedMail, emailCodeMail, emailRevertedMail, emailTakenMail, inviteMail, newSignInMail, passkeyMail, signInCodeMail, signInLinkMail, telegramActionsMail, telegramGroupLinkedMail, telegramLinkedMail, tokenMadeMail } from "./emails.ts";

export const SAMPLE_ORIGIN = "https://app.rsva.dev";
const NOW = new Date("2026-11-02T09:12:00Z");
const INVITE_TO = "kim@example.net";

export function sampleMails(names: { person: string; workspace: string; passkey: string; userAgent: string }): Record<string, Mail> {
  return {
    "sign-in-code": signInCodeMail("robin@example.com", "481207", new Date(NOW.getTime() + 10 * 60_000), SAMPLE_ORIGIN, NOW),
    "sign-in-link": signInLinkMail("robin@example.com", `${SAMPLE_ORIGIN}/#signin=q2Lr48HdW1x&email=robin%40example.com`, SAMPLE_ORIGIN, NOW),
    invite: inviteMail(
      {
        to: INVITE_TO,
        link: `${SAMPLE_ORIGIN}/join/7KQ29FXAM4TC`,
        inviterName: names.person,
        workspaceName: names.workspace,
        role: "member",
        expiresAt: new Date(NOW.getTime() + 7 * 24 * 3_600_000),
        origin: SAMPLE_ORIGIN,
      },
      NOW,
    ),
    passkey: passkeyMail({ to: "robin@example.com", passkeyName: names.passkey, userAgent: names.userAgent, host: "app.rsva.dev", origin: SAMPLE_ORIGIN }, NOW),
    "email-code": emailCodeMail("robin@example.org", "735190", new Date(NOW.getTime() + 10 * 60_000), SAMPLE_ORIGIN, NOW),
    "email-taken": emailTakenMail("robin@example.org", SAMPLE_ORIGIN, NOW),
    admitted: admittedMail("robin@example.com", SAMPLE_ORIGIN, NOW),
    "email-changed": emailChangedMail({ to: "robin@example.com", newEmail: "robin@example.org", userAgent: names.userAgent, revert: `${SAMPLE_ORIGIN}/#email-revert=Hq7Lw2xR0bN`, origin: SAMPLE_ORIGIN }, NOW),
    "email-reverted": emailRevertedMail("robin@example.org", "robin@example.com", SAMPLE_ORIGIN, NOW),
    "new-sign-in": newSignInMail({ to: "robin@example.com", device: "Firefox on Windows", method: "code", ip: "203.0.113.24", origin: SAMPLE_ORIGIN }, NOW),
    "telegram-linked": telegramLinkedMail({ to: "robin@example.com", chatName: names.person, username: "robin_v", origin: SAMPLE_ORIGIN }, NOW),
    "telegram-actions": telegramActionsMail({ to: "robin@example.com", chatName: names.person, username: "robin_v", origin: SAMPLE_ORIGIN }, NOW),
    "token-made": tokenMadeMail(
      {
        to: "robin@example.com",
        tokenName: names.passkey,
        holder: { name: names.person, email: "claude@example.com", agent: true },
        scope: "custom",
        grants: ["issues.write", "labels.write"],
        expiresAt: new Date(NOW.getTime() + 90 * 24 * 3_600_000),
        createdBy: { name: names.person, email: "kim@example.net" },
        workspaceName: names.workspace,
        origin: SAMPLE_ORIGIN,
      },
      NOW,
    ),
    "token-made-own": tokenMadeMail(
      {
        to: "robin@example.com",
        tokenName: names.passkey,
        holder: { name: names.person, email: "robin@example.com", agent: false },
        scope: "read",
        grants: [],
        expiresAt: null,
        createdBy: { name: names.person, email: "robin@example.com" },
        workspaceName: names.workspace,
        origin: SAMPLE_ORIGIN,
      },
      NOW,
    ),
    "token-widened": tokenMadeMail(
      {
        to: "robin@example.com",
        tokenName: names.passkey,
        holder: { name: names.person, email: "claude@example.com", agent: true },
        scope: "write",
        grants: [],
        was: { scope: "custom", grants: ["issues.write"] },
        expiresAt: new Date(NOW.getTime() + 90 * 24 * 3_600_000),
        createdBy: { name: names.person, email: "kim@example.net" },
        workspaceName: names.workspace,
        origin: SAMPLE_ORIGIN,
      },
      NOW,
    ),
    "telegram-group-linked": telegramGroupLinkedMail({ to: "robin@example.com", groupTitle: names.person, workspaceName: names.workspace, origin: SAMPLE_ORIGIN }, NOW),
  };
}
