// The app on a phone. By default opens every screen and popup at phone width and takes a picture of each, then reports
// what a picture can hide: sideways scrolling, controls cut off by the screen, tap targets under the minimum, fields iOS
// zooms into, sideways strips that also scroll up and down. With --flow it uses the app with a finger instead: tap,
// long press, sheets, search, a new issue, a comment over the keyboard.
//
// Against a running app, as the workspace's owner (a session from apps/server/src/cli/auth.ts session, on the database
// that server uses). The cycles, the comment, the saved view and the Inbox lines the screens open are made first where
// missing (phone-seed.ts), so a fresh sample fixture is enough; the Inbox lines are mentions by another member, whose
// token is PHONE_TOKEN (`cli/auth.ts token --ws sample --user bot@sample.test`):
//   PHONE_URL=https://rsva.localhost PHONE_SID=… PHONE_TOKEN=… PHONE_WS=sample PHONE_OUT=/tmp/shots pnpm perf:phone [name… | --flow]
// PHONE_WIDTH, PHONE_HEIGHT and PHONE_SCHEME=dark for other screens, PHONE_ENGINE=webkit for Safari's engine.
// Exits 1 when the session does not sign in (every screen would be the sign-in one), a screen fails, a --flow check fails,
// the page throws or the Content-Security-Policy blocks something on it (all but the <style> of Playwright's own
// screenshot in WebKit); the findings of a picture (overflow, small targets…) and console errors are a report and do not.
import { mkdirSync, writeFileSync } from "node:fs";
import { signInCookies } from "@rsva/fixtures/server";
import { chromium, webkit, type BrowserContext, type Page } from "playwright";
import { seed, SEED_VIEW } from "./phone-seed.ts";

const URL_ = process.env.PHONE_URL ?? "http://127.0.0.1:3800";
const SID = process.env.PHONE_SID ?? "";
const WS = process.env.PHONE_WS ?? "sample";
const OUT = process.env.PHONE_OUT ?? "perf/out/phone";
const KEY = process.env.PHONE_PROJECT ?? "CORE";
const ISSUE = process.env.PHONE_ISSUE ?? "CORE-92";
const WIDTH = Number(process.env.PHONE_WIDTH ?? 390);
const HEIGHT = Number(process.env.PHONE_HEIGHT ?? 844);
const SCHEME = process.env.PHONE_SCHEME === "dark" ? "dark" : "light";
/** The phone every context here emulates; the signed-in one also says it is Safari on iOS. */
const PHONE = { viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: SCHEME } as const;
const MIN_TARGET = 32;

interface Scene {
  name: string;
  path: string;
  act?: (p: Page) => Promise<void>;
  /** Run only when this is on the page, else report the reason as a skip, not a failure. */
  when?: { selector: string; otherwise: string };
}

const tap = (p: Page, sel: string) => p.locator(sel).first().tap({ timeout: 4000 });
const issues = `/${WS}/projects/${KEY}/issues`;

export const SCENES: Scene[] = [
  { name: "issues", path: issues },
  { name: "issues-issue", path: `${issues}/${ISSUE}` },
  { name: "browse", path: `/${WS}/browse/${ISSUE}` },
  { name: "projects", path: `/${WS}/projects` },
  { name: "projects-archived", path: `/${WS}/projects/archived` },
  { name: "cycles", path: `/${WS}/projects/${KEY}/cycles` },
  { name: "cycle", path: `/${WS}/projects/${KEY}/cycles/2` },
  { name: "history", path: `/${WS}/projects/${KEY}/history` },
  { name: "archive", path: `/${WS}/projects/${KEY}/archive` },
  { name: "settings", path: `/${WS}/projects/${KEY}/settings` },
  { name: "inbox", path: `/${WS}/inbox` },
  { name: "my-work", path: `/${WS}/my-work` },
  { name: "views", path: `/${WS}/views` },
  { name: "ws-settings", path: `/${WS}/settings` },
  { name: "ws-members", path: `/${WS}/settings/members` },
  { name: "ws-tokens", path: `/${WS}/settings/tokens` },
  { name: "ws-profile", path: `/settings/profile` },
  { name: "ws-preferences", path: `/settings/preferences` },
  { name: "ws-appearance", path: `/settings/appearance` },
  { name: "ws-security", path: `/settings/security` },
  // Shows its chat and groups only on a server with a bot (TELEGRAM_BOT_TOKEN); without one, "Not set up".
  { name: "telegram", path: `/settings/notifications/telegram` },
  {
    name: "telegram-group",
    path: `/settings/notifications/telegram`,
    act: (p) => tap(p, 'button:has-text("Add a group chat")'),
    when: { selector: 'button:has-text("Add a group chat")', otherwise: "no Telegram bot on this server" },
  },
  { name: "new-ws", path: `/new` },
  { name: "palette", path: issues, act: (p) => tap(p, 'nav[aria-label="Main"] button[aria-label="Search"]') },
  { name: "new-issue", path: issues, act: (p) => tap(p, 'button[aria-label="New issue"]') },
  // The description's "/" menu: a bottom sheet, as every popup.
  {
    name: "slash-menu",
    path: issues,
    act: async (p) => {
      await tap(p, 'button[aria-label="New issue"]');
      await tap(p, '[role=textbox][aria-label="Description"]');
      await p.keyboard.type("/");
    },
  },
  // The comment field's "#" menu: a row of chips over the field, as its "@" menu, not a sheet.
  {
    name: "comment-hash",
    path: `/${WS}/browse/${ISSUE}`,
    act: async (p) => {
      await tap(p, "[data-composer] .ProseMirror");
      await p.keyboard.type("#core");
    },
  },
  { name: "date", path: `${issues}/${ISSUE}`, act: (p) => tap(p, 'button[aria-label^="Start date"]') },
  { name: "cycle-details", path: `/${WS}/projects/${KEY}/cycles/2`, act: (p) => tap(p, 'button[aria-label="Details"]') },
  { name: "view", path: `/${WS}/views`, act: async (p) => { await tap(p, `a:has-text("${SEED_VIEW}"):visible`); await p.waitForTimeout(500); } },
  { name: "new-cycle", path: `/${WS}/projects/${KEY}/cycles`, act: (p) => tap(p, 'button[aria-label="New cycle"]') },
  { name: "complete-cycle", path: `/${WS}/projects/${KEY}/cycles/2`, act: (p) => tap(p, 'button:has-text("Complete")') },
  { name: "edit-cycle", path: `/${WS}/projects/${KEY}/cycles/2`, act: (p) => tap(p, 'button[aria-label="Edit cycle"]') },
  { name: "invite", path: `/${WS}/settings/members`, act: (p) => tap(p, 'button:has-text("Invite people")') },
  { name: "new-token", path: `/${WS}/settings/tokens`, act: (p) => tap(p, 'button:has-text("New token")') },
  {
    name: "new-token-custom",
    path: `/${WS}/settings/tokens`,
    act: async (p) => {
      await tap(p, 'button:has-text("New token")');
      await p.waitForTimeout(400);
      await tap(p, '[role=radiogroup][aria-label="Access"] label:has-text("Custom")');
    },
  },
  {
    name: "select",
    path: `/${WS}/settings/tokens`,
    act: async (p) => {
      await tap(p, 'button:has-text("New token")');
      await p.waitForTimeout(400);
      await tap(p, '[role=combobox][aria-label="For"]');
    },
  },
  { name: "time-zone", path: `/settings/preferences`, act: (p) => tap(p, '[role="combobox"]') },
  {
    name: "leave",
    path: issues,
    act: async (p) => {
      await tap(p, 'nav[aria-label="Main"] button[aria-label="More"]');
      await p.waitForTimeout(400);
      await tap(p, '[role=menuitem]:has-text("Leave")');
    },
  },
  { name: "inbox-filter", path: `/${WS}/inbox`, act: (p) => tap(p, 'button[aria-label^="Filter"]') },
  { name: "inbox-display", path: `/${WS}/inbox`, act: (p) => tap(p, 'button[aria-label="Display options"]') },
  { name: "inbox-bulk", path: `/${WS}/inbox`, act: (p) => tap(p, 'button[aria-label="Inbox actions"]') },
  { name: "view-menu", path: `/${WS}/views`, act: async (p) => { await tap(p, `a:has-text("${SEED_VIEW}"):visible`); await p.waitForTimeout(500); await tap(p, 'button[aria-label="View options"]'); } },
  { name: "assignee-picker", path: `/${WS}/browse/${ISSUE}`, act: (p) => tap(p, 'aside[aria-label="Properties"] button:has-text("Owner")') },
  { name: "parent-picker", path: `/${WS}/browse/${ISSUE}`, act: (p) => tap(p, 'aside[aria-label="Properties"] button:has-text("No parent")') },
  {
    name: "add-link",
    path: `/${WS}/browse/${ISSUE}`,
    act: async (p) => {
      await tap(p, 'button[aria-label="Add a relation, link or file"]');
      await p.waitForTimeout(400);
      await tap(p, '[role=menuitem]:has-text("Link")');
    },
  },
  { name: "comment-sheet", path: `/${WS}/browse/${ISSUE}`, act: (p) => tap(p, 'button[aria-label="Comment actions"]') },
  // The issue's own picker, under the description: the first Add reaction (a comment's opens comment-sheet instead).
  { name: "reactions", path: `/${WS}/browse/${ISSUE}`, act: (p) => tap(p, 'button[aria-label="Add reaction"]') },
  {
    name: "reactions-more",
    path: `/${WS}/browse/${ISSUE}`,
    act: async (p) => {
      await tap(p, 'button[aria-label="Add reaction"]');
      await p.waitForTimeout(400);
      await tap(p, 'button[aria-label="More reactions"]');
    },
  },
  { name: "more", path: issues, act: (p) => tap(p, 'nav[aria-label="Main"] button[aria-label="More"]') },
  {
    name: "connection",
    path: issues,
    act: async (p) => {
      await tap(p, 'nav[aria-label="Main"] button[aria-label="More"]');
      await tap(p, '[role="menuitem"]:has-text("Online")');
      await p.waitForTimeout(500); // the menu's sheet goes down before this one comes up
    },
  },
  { name: "state-picker", path: `/${WS}/browse/${ISSUE}`, act: (p) => tap(p, 'aside[aria-label="Properties"] button') },
  { name: "issue-menu", path: `/${WS}/browse/${ISSUE}`, act: (p) => tap(p, 'article header button[aria-label="More actions"]') },
  { name: "project-menu", path: issues, act: (p) => tap(p, 'header button[aria-label$=" options"]') },
  { name: "filter-panel", path: issues, act: (p) => tap(p, 'button[aria-label="View"]') },
  { name: "display", path: issues, act: (p) => tap(p, 'button[aria-label="Display"]') },
  {
    name: "board",
    path: issues,
    // On a phone List or Board is in Display's popover (PLNR-400).
    act: async (p) => {
      await tap(p, 'button[aria-label="Display"]');
      await tap(p, '[role="dialog"][aria-label="Display"] label:has-text("Board")');
      await p.keyboard.press("Escape");
      await p.waitForTimeout(600);
    },
  },
];

async function audit(p: Page) {
  return p.evaluate((min) => {
    const vw = innerWidth;
    const root = document.documentElement;
    const visible = (el: Element) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0 && r.width > 0 && r.height > 0;
    };
    const scrollsSideways = (el: Element | null): boolean => {
      for (let e = el?.parentElement; e; e = e.parentElement) {
        const o = getComputedStyle(e).overflowX;
        if ((o === "auto" || o === "scroll") && e.scrollWidth > e.clientWidth) return true;
      }
      return false;
    };
    const say = (el: Element) => {
      const r = el.getBoundingClientRect();
      const name = el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 28);
      return `${el.tagName.toLowerCase()} "${name}" ${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)}`;
    };
    const controls = [...document.querySelectorAll("a[href],button,input,select,textarea,[role=button],[role=menuitem],[role=option],[role=tab],label:has(> input[type=radio])")]
      .filter(visible)
      // Base UI's hidden form inputs, and what a sheet covers.
      .filter((el) => el.getBoundingClientRect().width > 1)
      .filter((el) => {
        const sheet = document.querySelector(".sheet");
        return !sheet || sheet.contains(el);
      });
    const small = controls.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top < innerHeight && r.bottom > 0 && (r.height < min || r.width < min);
    });
    const cut = controls.filter((el) => {
      const r = el.getBoundingClientRect();
      return (r.right > vw + 1 || r.left < -1) && !scrollsSideways(el);
    });
    // A strip that scrolls sideways and, by a few pixels, up and down too: overflow-x alone makes overflow-y auto.
    const wobbly = [...document.querySelectorAll("*")].filter((el) => {
      const s = getComputedStyle(el);
      return (s.overflowX === "auto" || s.overflowX === "scroll") && s.overflowY !== "hidden" && el.clientHeight > 0 && el.clientHeight <= 64 && el.scrollHeight > el.clientHeight;
    });
    const tiny = [...document.querySelectorAll("input,textarea,select,[contenteditable=true]")].filter(visible).filter((el) => el.getBoundingClientRect().width > 1).filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16);
    return {
      overflow: root.scrollWidth > vw ? root.scrollWidth - vw : 0,
      small: small.length,
      smallList: small.slice(0, 12).map(say),
      cut: cut.slice(0, 8).map(say),
      zoomOnFocus: tiny.slice(0, 6).map(say),
      wobbly: wobbly.slice(0, 6).map(say),
    };
  }, MIN_TARGET);
}

const only = process.argv.slice(2).filter((a) => a !== "--flow");
// PHONE_ENGINE=webkit: the nearest thing to Safari on iOS that runs without a simulator.
const browser = await (process.env.PHONE_ENGINE === "webkit" ? webkit : chromium).launch();
const context = await browser.newContext({
  ...PHONE,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
});
// The cookies a sign-in on this page leaves: __Host-rsva_sid on https, rsva_sid on plain http.
const cookies = signInCookies(URL_, SID);
const SESSION_COOKIE = cookies[0]!.name;
await context.addCookies(cookies);
mkdirSync(OUT, { recursive: true });
const page = await context.newPage();
// The browser's own request with those cookies: a session the server does not take turns every screen into the sign-in
// screen, whose pictures report nothing wrong. Only the sign-in screen itself is taken signed out.
if (!only.length || only.some((n) => n !== "sign-in")) {
  const status = (await page.goto(`${URL_}/auth/me`))?.status();
  if (status !== 200) {
    console.error(`perf:phone: ${URL_}/auth/me answers ${status} to ${SESSION_COOKIE}=PHONE_SID, so every screen would be the sign-in screen.`);
    console.error(`  PHONE_SID takes a session of the database that server uses: node apps/server/src/cli/auth.ts session --ws ${WS}`);
    await browser.close();
    process.exit(1);
  }
}
if (!only.length || only.some((n) => n !== "sign-in")) {
  const { made, missing } = await seed(page, URL_, { ws: WS, project: KEY, issue: ISSUE, token: process.env.PHONE_TOKEN });
  if (made.length) console.log(`made for the screens: ${made.join("; ")}`);
  // The flow walks the Inbox and My work's Reply; the pictures of an empty Inbox are still worth taking.
  if (missing.length && process.argv.includes("--flow")) {
    console.error(`perf:phone --flow: ${missing.join("; ")}`);
    await browser.close();
    process.exit(1);
  }
  for (const m of missing) console.log(`note: ${m}`);
}
const errors: string[] = [];
/** Uncaught exceptions: a failure of the run. Console errors are reported only. */
const crashes: string[] = [];
/** What the Content-Security-Policy blocked, by screen: a failure of the run (PLNR-274: Base UI's inline <style>). */
const blocked: string[] = [];
let screen = "flow";
async function watchCsp(ctx: BrowserContext): Promise<void> {
  await ctx.exposeBinding("__cspViolation", (_, v: string) => void blocked.push(`${screen}: ${v}`));
  // All but Playwright's own: its screenshot in WebKit adds a <style>body {}</style> (inPagePrepareForScreenshots in
  // playwright-core), blocked as an inline style-src-elem from no file. Anything else from no file counts: an <img> or
  // a url() in a style attribute blocked by img-src may come without one too.
  await ctx.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) => {
      if (!e.sourceFile && e.effectiveDirective === "style-src-elem" && e.blockedURI === "inline") return;
      (window as unknown as { __cspViolation(v: string): void }).__cspViolation(`${e.effectiveDirective} ${e.blockedURI} from ${e.sourceFile}:${e.lineNumber}`);
    }),
  );
}
await watchCsp(context);
page.on("pageerror", (e) => {
  errors.push(String(e));
  crashes.push(String(e));
});
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
/** Uses the app with a finger; returns how many checks failed. */
async function flow(p: Page, ctx: BrowserContext): Promise<number> {
  let failed = 0;
  const cdp = await ctx.newCDPSession(p);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x?: number, y?: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: x === undefined ? [] : [{ x, y: y! }] });
  const swipe = async (x0: number, y0: number, x1: number, y1 = y0) => {
    await touch("touchStart", x0, y0);
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8);
      await p.waitForTimeout(16);
    }
    await touch("touchEnd");
    await p.waitForTimeout(450);
  };
  const hold = async (x: number, y: number) => {
    await touch("touchStart", x, y);
    await p.waitForTimeout(600);
    await touch("touchEnd");
    await p.waitForTimeout(350);
  };
  const shot = (n: string) => p.screenshot({ path: `${OUT}/${n}.png` });
  const ok = (name: string, v: unknown) => {
    if (!v) failed++;
    console.log(v ? "ok  " : "FAIL", name);
  };
  const go = async (path: string) => {
    await p.goto(URL_ + path);
    await p.waitForLoadState("networkidle").catch(() => {});
    await p.waitForTimeout(700);
  };
  const keyboard = (height: number) =>
    p.evaluate((h) => {
      const r = document.documentElement;
      r.style.setProperty("--keyboard", `${h}px`);
      r.toggleAttribute("data-keyboard", h > 0);
    }, height);

  // 1. list → issue → back keeps the scroll
  await go(issues);
  await p.evaluate(() => void (document.querySelector("[data-slot=issue-list]")!.scrollTop = 900));
  await p.waitForTimeout(200);
  const row = p.locator("[data-slot=issue-list] [data-issue]").nth(14);
  await row.locator("a").tap();
  await p.waitForTimeout(500);
  ok("issue opened", /issues\/CORE-/.test(p.url()));
  ok("no tab bar on an issue", !(await p.locator("[data-tabbar]").isVisible()));
  await p.locator('button[aria-label^="Back to"]').first().tap();
  await p.waitForTimeout(500);
  ok("list scroll kept", await p.evaluate(() => document.querySelector("[data-slot=issue-list]")!.scrollTop));
  await shot("back-to-list");

  // 2. long press a row → the menu sheet
  await p.evaluate(() => void (document.querySelector("[data-slot=issue-list]")!.scrollTop = 0));
  await p.waitForTimeout(200);
  // On a row's title: a press that starts on a button (a property chip) is the button's, not the row's (row-menu.tsx).
  const title = (await p.locator("[data-slot=issue-list] [data-issue]").nth(2).locator("a").boundingBox())!;
  await hold(title.x + 120, title.y + 14);
  ok("long press menu", await p.locator('[data-slot=dropdown-menu-content]').isVisible());
  await shot("long-press");
  await p.mouse.click(195, 60);
  await p.waitForTimeout(400);
  ok("sheet closed by the backdrop", !(await p.locator('[data-slot=dropdown-menu-content]').isVisible()));
  ok("still on the list", /issues$/.test(p.url()));

  // 3. state glyph in a row → picker sheet
  await p.locator('[data-slot=issue-list] [data-chip=state]').nth(2).tap();
  await p.waitForTimeout(450);
  await shot("row-state");
  ok("state sheet", await p.locator("[data-slot=combobox-content]").isVisible());
  ok("no keyboard field focused", await p.evaluate(() => document.activeElement?.tagName !== "INPUT"));
  await p.locator('[data-slot=combobox-item]:has-text("In Review")').tap();
  await p.waitForTimeout(450);
  ok("sheet gone after pick", !(await p.locator("[data-slot=combobox-content]").isVisible()));
  await shot("after-state");

  // 3b. a row's "…": the row menu, no long press needed
  await p.evaluate(() => void (document.querySelector("[data-slot=issue-list]")!.scrollTop = 0));
  await p.locator("[data-slot=issue-list] [data-issue]").nth(1).locator('button[aria-label="More actions"]').tap();
  await p.waitForTimeout(450);
  await shot("row-menu");
  ok("row menu by its button", await p.locator("[data-slot=dropdown-menu-content]").isVisible());
  ok("still on the list", /issues$/.test(p.url()));
  await p.mouse.click(195, 60);
  await p.waitForTimeout(400);

  // 4. inbox: a row's "…" archives with undo, marks read and back
  await go(`/${WS}/inbox`);
  const more = () => p.locator('button[aria-label="More actions"]').first().tap();
  await more();
  await p.waitForTimeout(450);
  await shot("inbox-menu");
  ok("actions shown", await p.locator('[role=menuitem]:has-text("Tomorrow")').first().isVisible());
  await tap(p, '[role=menuitem]:has-text("Archive")');
  await p.waitForTimeout(500);
  await shot("inbox-archived");
  ok("undo toast", await p.locator('button:has-text("Undo")').isVisible());
  await p.locator('button:has-text("Undo")').tap();
  await p.waitForTimeout(400);
  const dots = () => p.locator('[aria-label="Unread"]').count();
  const before = await dots();
  await more();
  await tap(p, '[role=menuitem]:has-text("Mark as")');
  await p.waitForTimeout(400);
  ok("the menu toggles read", (await dots()) !== before);
  await more();
  await tap(p, '[role=menuitem]:has-text("Mark as")');
  await p.waitForTimeout(400);
  await p.locator("[role=option]").nth(1).tap();
  await p.waitForTimeout(500);
  await shot("inbox-detail");
  await p.locator('button[aria-label="Back to Inbox"]').tap();
  await p.waitForTimeout(300);
  await p.locator('[aria-label="Inbox filter"] button:has-text("Mentions")').tap();
  await p.waitForTimeout(300);
  await shot("inbox-mentions");

  // 5. my work: tap a row opens the issue, Reply bar
  await go(`/${WS}/my-work`);
  await p.locator('button:has-text("Reply")').first().tap();
  await p.waitForTimeout(400);
  await shot("mywork-reply");
  await p.locator('button:has-text("Cancel")').first().tap();
  await p.locator('[role=option]').first().tap();
  await p.waitForTimeout(600);
  ok("my work opens the issue", /browse\//.test(p.url()));

  // 5b. a sheet goes down with a finger
  await go(`/${WS}/inbox`);
  await p.locator('nav[aria-label="Main"] button[aria-label="More"]').tap();
  await p.waitForTimeout(500);
  const sheet = (await p.locator(".sheet").boundingBox())!;
  await swipe(195, sheet.y + 12, 195, sheet.y + 320);
  await p.waitForTimeout(400);
  ok("sheet dragged away", !(await p.locator(".sheet").isVisible()));

  // 6. search
  await go(`/${WS}/inbox`);
  await p.locator('nav[aria-label="Main"] button[aria-label="Search"]').tap();
  await p.waitForTimeout(400);
  await p.keyboard.type("deploy");
  await p.waitForTimeout(400);
  await shot("search");
  await p.locator("[data-slot=command-item]").first().tap();
  await p.waitForTimeout(600);
  await shot("search-picked");

  // 7. new issue
  await go(issues);
  await p.locator('button[aria-label="New issue"]').tap();
  await p.waitForTimeout(500);
  await p.keyboard.type("Created from a phone");
  await p.waitForTimeout(200);
  await shot("new-typed");
  await p.locator('button[type=submit]').tap();
  await p.waitForTimeout(600);
  await shot("new-created");

  // 8. comment
  await go(`/${WS}/browse/${ISSUE}`);
  await p.locator('[data-composer] .ProseMirror').tap();
  await p.keyboard.type("A comment from the phone");
  await p.waitForTimeout(200);
  await keyboard(336);
  await p.waitForTimeout(300);
  await shot("comment-keyboard");
  await keyboard(0);
  await p.locator('button[aria-label="Comment"]').tap();
  await p.waitForTimeout(500);
  await p.evaluate(() => void (document.querySelector("article .overflow-y-auto")!.scrollTop = 1e6));
  await p.waitForTimeout(300);
  await shot("comment-sent");

  // 9. sheet with search and the keyboard
  // The labels property, whether the issue has labels or not.
  const props = 'aside[aria-label="Properties"]';
  await p.locator(`${props} button:has([data-slot=label-tag]), ${props} button:has-text("No labels")`).first().tap();
  await p.waitForTimeout(400);
  ok("labels sheet", await p.locator("[data-slot=combobox-content]").isVisible());
  await keyboard(336);
  await p.waitForTimeout(300);
  await shot("sheet-keyboard");
  await keyboard(0);
  await p.keyboard.press("Escape");
  return failed;
}

const report: Record<string, unknown> = {};
if (process.argv.includes("--flow")) {
  const failed = await flow(page, context);
  if (errors.length) console.log("page errors:", [...new Set(errors)].slice(0, 5));
  if (failed) console.log(`${failed} check(s) failed`);
  if (crashes.length) console.log(`${crashes.length} uncaught exception(s) on the page`);
  if (blocked.length) console.log("blocked by the CSP:", blocked);
  await browser.close();
  process.exit(failed || crashes.length || blocked.length ? 1 : 0);
}
const signedOut = await browser.newContext(PHONE);
await watchCsp(signedOut);
if (!only.length || only.includes("sign-in")) {
  screen = "sign-in";
  const p = await signedOut.newPage();
  await p.goto(`${URL_}/`);
  await p.waitForTimeout(900);
  report["sign-in"] = await audit(p);
  await p.screenshot({ path: `${OUT}/sign-in.png` });
}
for (const s of SCENES) {
  if (only.length && !only.includes(s.name)) continue;
  screen = s.name;
  try {
    await page.goto(URL_ + s.path);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(600);
    if (s.when && !(await page.locator(s.when.selector).count())) {
      report[s.name] = { skipped: s.when.otherwise };
      continue;
    }
    await s.act?.(page);
    await page.waitForTimeout(500);
    report[s.name] = await audit(page);
    await page.screenshot({ path: `${OUT}/${s.name}.png` });
  } catch (e) {
    report[s.name] = { failed: String(e).split("\n")[0] };
  }
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
const failedScreens: string[] = [];
for (const [name, r] of Object.entries(report)) {
  const a = r as { overflow?: number; small?: number; cut?: string[]; zoomOnFocus?: string[]; wobbly?: string[]; failed?: string; skipped?: string };
  if (a.failed) failedScreens.push(name);
  console.log(a.failed ? `${name}: FAILED ${a.failed}` : a.skipped ? `${name}: skipped, ${a.skipped}` : `${name}: overflow ${a.overflow}, small ${a.small}, cut ${a.cut?.length}, zoom ${a.zoomOnFocus?.length}, wobbly ${a.wobbly?.length}`);
}
if (errors.length) console.log("page errors:", [...new Set(errors)].slice(0, 5));
if (failedScreens.length) console.log(`${failedScreens.length} of ${Object.keys(report).length} screens failed: ${failedScreens.join(", ")}`);
await browser.close();
if (crashes.length) console.log(`${crashes.length} uncaught exception(s) on the page`);
if (blocked.length) console.log("blocked by the CSP:", blocked);
process.exitCode = failedScreens.length || crashes.length || blocked.length ? 1 : 0;
