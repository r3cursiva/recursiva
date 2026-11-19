// What a person sees when changes do not reach the server: the real app in real browsers against a real server. Needs a
// build (`pnpm build`). Pictures of each state land in perf/out/sync.
//
//   pnpm sync:browser
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { signInCookies } from "@rsva/fixtures/server";
import { chromium, type BrowserContext, type Page, type WebSocketRoute } from "playwright";
import { localTarget } from "./target.ts";

const OUT = resolve(import.meta.dirname, "../../../perf/out/sync");
const NOTICE = 20_000;
mkdirSync(OUT, { recursive: true });

const target = await localTarget("sync-lab", resolve(import.meta.dirname, "../../../apps/web/dist"));
const browser = await chromium.launch();
const ISSUE = `/${target.ws}/projects/CORE/issues/CORE-1`;

async function signedIn(who: "a" | "b"): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies(signInCookies(target.url, target.session!(who)));
  return context;
}

/** Stops whatever goes through the page's sockets while `dead` holds: a link that fails without saying so. */
async function silentLink(page: Page): Promise<{ dead: boolean }> {
  const link = { dead: false };
  await page.routeWebSocket(/\/ws$/, (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => void (link.dead || server.send(m)));
    server.onMessage((m) => void (link.dead || ws.send(m)));
  });
  return link;
}

/** The issue with its description ready to edit: a kept copy stays read-only until the catch-up has confirmed it. */
async function ready(page: Page): Promise<Page> {
  await page.goto(`${target.url}${ISSUE}`);
  await page.locator('[aria-label="Description"][contenteditable="true"]').first().waitFor({ timeout: NOTICE });
  await page.waitForFunction(() => document.body.innerText.includes("Online"), undefined, { timeout: NOTICE });
  return page;
}

const toast = (page: Page, text: string) => page.locator('[data-slot="toast"]').filter({ hasText: text });
const describe = async (page: Page, text: string) => {
  const editor = page.getByLabel("Description").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
};
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png` });
const check = async (name: string, run: () => Promise<void>) => {
  const t0 = performance.now();
  await run();
  console.log(`ok   ${name} ${Math.round(performance.now() - t0)} ms`);
};

let failed = false;
try {
  const [one, two] = await Promise.all([signedIn("a"), signedIn("b")]);
  const a = await ready(await one.newPage());
  const b = await ready(await two.newPage());

  await check("offline: the app says it, the edit waits, then it says all is saved", async () => {
    await one.setOffline(true);
    await describe(a, "typed offline");
    await toast(a, "Not saved: no connection").waitFor({ timeout: NOTICE });
    await shot(a, "offline");
    await one.setOffline(false);
    await toast(a, "All changes saved").waitFor({ timeout: NOTICE });
    await shot(a, "saved");
    await b.getByText("typed offline").waitFor({ timeout: NOTICE });
  });

  await check("a link dead without a word: the app finds out and says so", async () => {
    const page = await one.newPage();
    const link = await silentLink(page);
    await ready(page);
    link.dead = true;
    await describe(page, "typed into the void");
    await toast(page, "Not saved").waitFor({ timeout: NOTICE });
    await shot(page, "dead-link");
    link.dead = false;
    await toast(page, "All changes saved").waitFor({ timeout: NOTICE * 2 });
    await b.getByText("typed into the void").waitFor({ timeout: NOTICE });
    await page.close();
  });

  await check("two people rewrite one description offline: both texts stay, nobody is refused", async () => {
    await ready(a);
    await one.setOffline(true);
    await two.setOffline(true);
    await describe(a, "the words of A");
    await describe(b, "the words of B");
    await a.waitForTimeout(800);
    await one.setOffline(false);
    await a.getByText("Saved", { exact: true }).waitFor({ timeout: NOTICE });
    await two.setOffline(false);
    for (const page of [a, b]) for (const words of ["the words of A", "the words of B"]) await page.getByText(words).waitFor({ timeout: NOTICE });
    await shot(b, "merged");
    assert.equal(await toast(b, "Change not saved").count(), 0, "a merge refuses nobody");
  });

  await check("someone's save while you type comes into your text, and your typing goes on where it was", async () => {
    await describe(a, "first line");
    await a.keyboard.press("Enter");
    await a.keyboard.type("second line");
    await b.getByText("second line").waitFor({ timeout: NOTICE });
    await b.getByText("Saved", { exact: true }).waitFor({ state: "hidden", timeout: NOTICE });
    // B types slowly at the end of the second line; A's edit of the first arrives in the middle of it.
    await b.getByLabel("Description").first().getByText("second line").click();
    await b.keyboard.press("End");
    let typed = false;
    const typing = b.keyboard.type(" typed slowly by B here", { delay: 150 }).then(() => (typed = true));
    await a.waitForTimeout(300);
    await a.getByLabel("Description").first().getByText("first line").click();
    await a.keyboard.press("End");
    await a.keyboard.type("!");
    await b.getByText("first line!").waitFor({ timeout: NOTICE });
    assert.equal(typed, false, "A's edit shows while B is still typing, not after B's save");
    await typing;
    for (const page of [a, b]) {
      await page.getByText("first line!").waitFor({ timeout: NOTICE });
      await page.getByText("second line typed slowly by B here").waitFor({ timeout: NOTICE });
    }
    await shot(b, "typing-merged");
  });
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  await target.stop();
}
process.exit(failed ? 1 : 0);
