import assert from "node:assert/strict";
import { test } from "node:test";
import { mailerFromEnv, mailText } from "../auth/mail.ts";
import { html, Html } from "./template.ts";
import { SAMPLE_ORIGIN, sampleMails } from "./samples.ts";

const plain = sampleMails({ person: "Robin", workspace: "beacon", passkey: "MacBook", userAgent: "Chrome" });
const hostile = "<img src=x onerror=alert(1)>\"'&";
const attacked = sampleMails({ person: hostile, workspace: hostile, passkey: hostile, userAgent: hostile });

test("html escapes values and keeps marked-up parts", () => {
  assert.equal(html`<b title="${`"><i>`}">${"a&b"}</b>`.value, '<b title="&quot;&gt;&lt;i&gt;">a&amp;b</b>');
  assert.equal(html`<p>${html`<b>${"<"}</b>`}${null}${false}${["x", 1]}</p>`.value, "<p><b>&lt;</b>x1</p>");
  assert.ok(html`` instanceof Html);
});

for (const [name, mail] of Object.entries(attacked)) {
  test(`${name}: a person's words stay text in the HTML`, () => {
    assert.doesNotMatch(mail.html, /<img src=x/);
    assert.doesNotMatch(mail.html, /onerror=alert\(1\)>/);
    assert.doesNotMatch(mail.subject + mail.text, /[\r\n]{1}<img/);
  });
}

for (const [name, mail] of Object.entries(plain)) {
  test(`${name}: a whole email in both themes`, () => {
    assert.match(mail.html, /^<!doctype html>/);
    assert.match(mail.html, /<meta name="color-scheme" content="light dark">/);
    assert.match(mail.html, /@media \(prefers-color-scheme:dark\)/);
    assert.match(mail.html, /@media \(max-width:480px\)/);
    // A client that drops the dark block must not take the phone rules with it.
    assert.equal(mail.html.match(/<style>/g)?.length, 2);
    assert.ok(mail.html.includes(`src="${SAMPLE_ORIGIN}/mail-mark-light.png"`));
    assert.ok(mail.html.includes(`src="${SAMPLE_ORIGIN}/mail-mark-dark.png"`));
    assert.match(mail.html, />recursiva</);
    assert.ok(mail.text.length > 40);
    assert.doesNotMatch(mail.text, /</);
    assert.doesNotMatch(mail.subject + mail.text + mail.html, /Planner|PLNR(?!-)/);
  });
}

test("a name cannot reorder or hide the mail's text; joiners stay", () => {
  assert.equal(mailText("Ann\u202egnp.exe\u2066x\u2069\u200b\u200f\ufeff"), "Anngnp.exex");
  assert.equal(mailText("\u{1f468}\u200d\u{1f469} Ann"), "\u{1f468}\u200d\u{1f469} Ann");
});

test("the code is first in the subject, in the text, and copies as six digits", () => {
  for (const [name, code, subject] of [["sign-in-code", "481207", "481207 is your recursiva code"], ["email-code", "735190", "735190 confirms your new recursiva email"]] as const) {
    const m = plain[name]!;
    assert.equal(m.subject, subject);
    const cell = /<td class="code [^>]*>(.*?)<\/td>/.exec(m.html)?.[1] ?? "";
    assert.equal(cell.replace(/<[^>]*>/g, ""), code, "nothing but the digits between the tags");
    assert.match(cell, /padding-left/, "the threes are apart by padding");
  }
  const m = plain["sign-in-code"]!;
  assert.match(m.text, /^Your sign-in code: 481207\n/);
  assert.match(m.text, /expires at 09:22 UTC/);
});

test("the link is a button and stays readable in the open", () => {
  for (const name of ["sign-in-link", "invite"]) {
    const m = plain[name]!;
    const link = /https:\S+/.exec(m.text)![0].replaceAll("&", "&amp;");
    assert.ok(m.html.includes(`href="${link}"`), link);
    assert.ok(m.html.includes(`${link}</span>`), link);
  }
});

test("a new sign-in sends the person to the settings page by its name, Security (PLNR-403)", () => {
  const m = plain["new-sign-in"]!;
  for (const part of [m.text, m.html]) assert.ok(part.includes("sign that session out in Settings › Security,"));
  for (const mail of Object.values(plain)) assert.doesNotMatch(mail.text + mail.html, /Security and sessions/);
});

test("the passkey and Telegram notices tell the person to sign out other devices (RSVA-249)", () => {
  for (const name of ["passkey", "telegram-linked", "telegram-group-linked", "new-sign-in", "token-made-own"]) {
    const m = plain[name]!;
    for (const part of [m.text, m.html]) assert.match(part, /sign (out your other devices|that session out) in Settings › Security/, name);
  }
});

test("a new token's notice names the token, whom it acts as, its access and expiry, and how to revoke it (RSVA-188)", () => {
  const agent = plain["token-made"]!;
  assert.equal(agent.subject, 'An API token was made for Robin in "beacon"');
  for (const part of [agent.text, agent.html]) {
    assert.match(part, /claude@example\.com/);
    assert.match(part, /issues\.write, labels\.write/);
    assert.match(part, /Jan 31, 2027/);
    assert.match(part, /kim@example\.net/);
    assert.match(part, /revoke it in Settings › API tokens of (&quot;|")beacon/);
  }
  const own = plain["token-made-own"]!;
  assert.equal(own.subject, 'An API token was made for your recursiva account in "beacon"');
  assert.match(own.text, /It acts as you with read access, with no expiry\./);
  assert.match(own.html, /Never/);
});

test("a widened token's notice names the access before and after and who widened it (RSVA-507)", () => {
  const m = plain["token-widened"]!;
  assert.equal(m.subject, `The access of Robin's API token was widened in "beacon"`);
  assert.match(m.text, /^The access of the API token .+ was widened in "beacon"/);
  assert.match(m.text, /It now acts as the agent Robin \(claude@example\.com\) with write access \(before: read access and issues\.write\), until Jan 31, 2027\./);
  assert.match(m.text, /If nobody meant to widen it, revoke it in Settings › API tokens of "beacon"/);
  for (const label of ["Before", "Widened by"]) assert.ok(m.html.includes(label), label);
  assert.ok(m.html.includes("kim@example.net"));
});

test("an invite names the workspace, the address and the day it ends", () => {
  const m = plain.invite!;
  assert.equal(m.subject, 'Robin invited you to "beacon"');
  assert.match(m.text, /as a member\./);
  assert.match(m.text, /only for kim@example\.net/);
  assert.match(m.html, /Nov 9, 2026, in 7 days/);
});

test("no origin, no logo", async () => {
  const { signInCodeMail } = await import("./emails.ts");
  const m = signInCodeMail("a@b.c", "000000", new Date(0), "", new Date(0));
  assert.doesNotMatch(m.html, /<img/);
});

test("Resend gets both parts", async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
    return new Response("{}");
  });
  await mailerFromEnv({ RESEND_API_KEY: "re_test", RSVA_MAIL_FROM: "a@b.c" }, () => {})(plain.passkey!);
  assert.equal(bodies[0]!.from, "recursiva <a@b.c>");
  assert.equal(bodies[0]!.text, plain.passkey!.text);
  assert.equal(bodies[0]!.html, plain.passkey!.html);
});
