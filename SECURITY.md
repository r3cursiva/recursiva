# Security policy

## Reporting a vulnerability

Please report it privately, through GitHub: on the repository's **Security** tab choose **Report a vulnerability**
(private vulnerability reporting). Do not open a public issue or pull request for a vulnerability.

Include what you found, the steps or a proof of concept, the version or commit, and what an attacker gains. We will
acknowledge the report, tell you what we decide, and credit you in the fix if you wish. This is a young project run by
a small team: we cannot promise a fixed response time, but a report is read by a person.

Please give us a reasonable time to fix the problem before you publish it.

## Scope

In scope: the code in this repository: the server (sign-in, sessions, passkeys, agent tokens, permissions, the write
pipeline and API, the GitHub webhook, file handling), the web app, the `rsva` CLI and the TUI, and the default
configuration in `deploy/`.

Out of scope: a deployment you set up yourself with weak settings (an open database, a missing `HOST` or
`RSVA_ALLOWED_ORIGINS`); denial of service by raw traffic volume; reports from automated scanners with no demonstrated
impact; missing best-practice headers with no exploit; social engineering; third-party services (Postgres, Resend, GitHub,
Telegram) and our dependencies, unless recursiva uses them in a vulnerable way. The hosted service at app.rsva.dev is covered
by the same reporting address, but testing against it must stay within your own account and workspace.

## No bounty

There is no bug bounty and no paid reward. We will say thank you in public if you want us to.

## Supported versions

Only the current `main` is supported. There are no maintained release branches yet.
