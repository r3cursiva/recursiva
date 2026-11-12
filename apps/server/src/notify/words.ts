// What a notification says, in every channel alike: the headline of an event and the clipped title and comment, in an
// email, a bundle or digest row, and a Telegram message (telegram/message.ts, lists.ts).
import { mailText } from "../auth/mail.ts";
import type { DigestItem, IssueNotice } from "../mail/emails.ts";

/** A comment's first lines: enough to answer from the mail's preview, the rest is a click away. */
const COMMENT_MAX = 600;

/** An issue's or a cycle's title as notifications quote it. */
export const TITLE_CLIP = 200;

/** A notification's comment and issue title as every channel quotes them: the comment's first lines, a title's TITLE_CLIP. */
export function clipped(n: Pick<IssueNotice, "comment" | "issueTitle">): { comment: string | undefined; title: string } {
  const comment = n.comment === undefined ? undefined : n.comment.length > COMMENT_MAX ? `${n.comment.slice(0, COMMENT_MAX).trimEnd()}…` : n.comment;
  return { comment, title: n.issueTitle.slice(0, TITLE_CLIP) };
}

/** What happened, as an overline, a headline and why it reached the person: the same words in every mail it is in. */
export function headline(n: Pick<IssueNotice, "kind" | "byAgent" | "actor" | "issueKey" | "stateName">): { overline: string; title: string; why: string } {
  const actor = mailText(n.actor);
  const key = n.issueKey;
  const state = n.stateName ? mailText(n.stateName) : "";
  const what: Record<IssueNotice["kind"], [overline: string, title: string, why: string]> = {
    assigned: ["Assigned to you", `${actor} assigned ${key} to you`, "it was assigned to you"],
    review: [n.byAgent ? "Waiting on you" : "Review requested", `${actor} moved ${key} into review`, "you created it and it waits for your review"],
    approved: ["Approved", `${actor} approved ${key}`, "it is assigned to you"],
    state: ["State changed", `${actor} moved ${key} to ${state}`, "you follow it"],
    mention: ["Mentioned", `${actor} mentioned you on ${key}`, "you were mentioned"],
    reply: ["Reply", `${actor} replied on ${key}`, "you wrote in the thread"],
    comment: ["New comment", `${actor} commented on ${key}`, "you follow it"],
  };
  const [overline, title, why] = what[n.kind];
  return { overline, title, why };
}

/** A notification as a row of a bundle or a digest: the issue, its link, and what happened. */
export function noticeItem(n: IssueNotice): DigestItem & { line: string } {
  return { key: n.issueKey, title: clipped(n).title, link: n.link, line: headline(n).title };
}
