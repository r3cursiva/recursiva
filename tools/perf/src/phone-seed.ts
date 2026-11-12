// What perf:phone's screens need and the sample fixture lacks (PLNR-283): two cycles in the project with the second
// one running, a comment on the issue, the saved view "Urgent work", and unread mentions of the owner for the Inbox and
// My work's Reply (--flow). Made once, as the signed-in owner from the page itself (the server takes a session's writes
// only from its own origin); the mentions come from another member, so they need that member's token. A workspace that
// has these already is left as it is.
import type { Page } from "playwright";

export const SEED_VIEW = "Urgent work";

interface Seed {
  ws: string;
  project: string;
  issue: string;
  /** Another member's token (an agent's: apps/server/src/cli/auth.ts token --user …): who mentions the owner. */
  token?: string | undefined;
}

/** How many Inbox lines the flow works through: it opens the second one. */
const INBOX_LINES = 3;

export async function seed(page: Page, base: string, s: Seed): Promise<{ made: string[]; missing: string[] }> {
  await page.goto(`${base}/${s.ws}/views`);
  const made: string[] = [];
  const missing: string[] = [];
  const api = (method: string, path: string, body?: unknown) =>
    page.evaluate(
      async ([method, url, body]) => {
        const r = await fetch(url, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`${method} ${url}: HTTP ${r.status} ${await r.text()}`);
        return r.json() as Promise<unknown>;
      },
      [method, `/api/v1/workspaces/${s.ws}${path}`, body] as const,
    );

  const cycles = (await api("GET", `/cycles?project=${s.project}`)) as unknown[];
  if (cycles.length === 0) {
    const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    await api("POST", "/cycles", { project: s.project, name: "Warm-up", startDate: day(-28), endDate: day(-15) });
    await api("POST", "/cycles", { project: s.project, name: "Phone pass", startDate: day(-7), endDate: day(6) });
    for (let n = 1; n <= 8; n++) await api("PATCH", `/issues/${s.project}-${n}`, { cycle: "C2" });
    made.push(`cycles C1 and C2 in ${s.project}, eight issues in C2`);
  }

  const { comments } = (await api("GET", `/issues/${s.issue}/comments`)) as { comments: unknown[] };
  if (comments.length === 0) {
    await api("POST", `/issues/${s.issue}/comments`, { body: "Checked on a phone: the sheet opens from the comment's actions." });
    made.push(`a comment on ${s.issue}`);
  }

  const views = (await api("GET", "/views")) as { name: string }[];
  if (!views.some((v) => v.name === SEED_VIEW)) {
    // No API makes a view: the app does, through its View panel.
    await page.locator('button[aria-label="New view"]').first().tap();
    await page.locator('input[aria-label="Name"]').fill(SEED_VIEW);
    await page.locator('input[aria-label="Query"]').fill("priority:urgent");
    await page.keyboard.press("Enter");
    await page.locator('button:has-text("Create view")').tap();
    // Saved through the socket: wait until the server lists it (the app's own navigation to it fires no load event).
    for (let i = 0; !((await api("GET", "/views")) as { name: string }[]).some((v) => v.name === SEED_VIEW); i++) {
      if (i === 25) throw new Error(`the view "${SEED_VIEW}" was not saved`);
      await page.waitForTimeout(200);
    }
    made.push(`the view "${SEED_VIEW}"`);
  }
  const { lines } = (await api("GET", "/inbox?all=1")) as { lines: unknown[] };
  if (lines.length < INBOX_LINES) {
    if (!s.token) missing.push(`the owner's Inbox has ${lines.length} of ${INBOX_LINES} lines: PHONE_TOKEN, another member's token, makes them`);
    else {
      const { me } = (await api("GET", "/workspace")) as { me: { email: string } };
      for (let n = 11; n < 11 + INBOX_LINES - lines.length; n++) {
        const r = await fetch(`${base}/api/v1/workspaces/${s.ws}/issues/${s.project}-${n}/comments`, {
          method: "POST",
          headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
          body: JSON.stringify({ body: `[](mention:${me.email}) could you look at this from a phone?` }),
        });
        if (!r.ok) throw new Error(`a mention by PHONE_TOKEN on ${s.project}-${n}: HTTP ${r.status} ${await r.text()}`);
      }
      made.push(`${INBOX_LINES - lines.length} mentions of the owner`);
    }
  }
  return { made, missing };
}
