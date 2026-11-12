// Pictures of the demo workspace for the README and the Product Hunt gallery (RSVA-587): `pnpm demo:shots` (after
// `pnpm build`) makes the workspace in a database of its own (demo.ts), opens it in Chromium as its owner and writes
//   assets/screenshot.png, assets/screenshot-dark.png   the README's hero: the issue list, 2400×1500
//   assets/gallery/<screen>-<light|dark>.png            1270×760, the size of Product Hunt's gallery
//   assets/gallery/phone-<light|dark>.png               two phone screens side by side, 1270×760
//   assets/navigation.mp4, assets/navigation.gif        a walk through the app, under 10 s (needs ffmpeg)
// DEMO_OUT changes the folder, DEMO_ONLY=list,board takes only those screens. The server and the database go away at
// the end. The faces and names are the made-up team's: tools/fixtures/src/demo.ts.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { signInCookies } from "@rsva/fixtures/server";
import { DEMO_SLUG } from "@rsva/fixtures/demo";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { startDemo } from "./demo.ts";
import { ROOT } from "./report.ts";

const OUT = process.env.DEMO_OUT ?? join(ROOT, "assets");
const ONLY = process.env.DEMO_ONLY?.split(",");
const WS = `/${DEMO_SLUG}`;
type Scheme = "light" | "dark";
/**
 * Product Hunt's gallery wants 1270×760, but the header of a project page needs about 1400 CSS pixels to show its title
 * and the cycle chip whole: pages are laid out at 1400 wide and drawn at a scale (1270/1400 for the gallery, the hero at 2400/1400).
 */
const LAYOUT_W = 1400;
const HERO = { width: LAYOUT_W, height: Math.round((LAYOUT_W * 1500) / 2400), scale: 2400 / LAYOUT_W };
const GALLERY = { width: LAYOUT_W, height: Math.round((LAYOUT_W * 760) / 1270), scale: 1270 / LAYOUT_W };

interface Screen {
  name: string;
  path: string;
  act?: (p: Page) => Promise<void>;
  /** The sidebar folded away: a wide page needs the room. */
  wide?: boolean;
}
const click = (p: Page, sel: string) => p.locator(sel).first().click({ timeout: 4000 });

const boardView = (p: Page) => click(p, 'label[title^="Board"]:visible');

const SCREENS: Screen[] = [
  { name: "list", path: `${WS}/projects/WEB/issues` },
  { name: "board", path: `${WS}/projects/WEB/issues`, act: boardView, wide: true },
  { name: "issue", path: `${WS}/browse/API-1` },
  { name: "my-work", path: `${WS}/my-work` },
  { name: "inbox", path: `${WS}/inbox` },
  { name: "cycle", path: `${WS}/projects/WEB/cycles/1`, wide: true },
  { name: "palette", path: `${WS}/projects/WEB/issues`, act: (p) => p.keyboard.press("Control+k") },
];


async function settle(p: Page, path: string, act?: Screen["act"], wide?: boolean): Promise<void> {
  await p.goto(process.env.DEMO_BASE + path);
  await p.waitForLoadState("networkidle").catch(() => {});
  await p.waitForTimeout(700);
  // The sidebar's choice is kept on the device (apps/web/src/screens/sidebar-state.ts) and read before the first render.
  if (wide !== undefined) {
    await p.evaluate((v) => localStorage.setItem("rsva:sidebar-strip", v), String(wide));
    await p.reload();
    await p.waitForLoadState("networkidle").catch(() => {});
    await p.waitForTimeout(700);
  }
  if (act) {
    await act(p);
    await p.waitForTimeout(700);
  }
  // The pointer parked over a row would light it up.
  await p.mouse.move(0, 0);
}

async function context(browser: Browser, scheme: Scheme, o: { width: number; height: number; scale: number; phone?: boolean; video?: string }, session: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: o.width, height: o.height },
    deviceScaleFactor: o.scale,
    colorScheme: scheme,
    locale: "en-US",
    timezoneId: "UTC",
    ...(o.phone ? { isMobile: true, hasTouch: true } : {}),
    ...(o.video ? { recordVideo: { dir: o.video, size: { width: o.width, height: o.height } } } : {}),
  });
  await ctx.addCookies(signInCookies(process.env.DEMO_BASE!, session));
  return ctx;
}

/** Two phone screens (390×844 at 2×) side by side on a plain ground, 1270×760. */
async function phonePair(scheme: Scheme): Promise<void> {
  const phone = await context(browser, scheme, { width: 390, height: 844, scale: 2, phone: true }, demo.session);
  const p = await phone.newPage();
  const shots: string[] = [];
  for (const path of [`${WS}/projects/WEB/issues`, `${WS}/browse/API-1`]) {
    await settle(p, path);
    shots.push((await p.screenshot()).toString("base64"));
  }
  await phone.close();
  const ground = scheme === "dark" ? "#0b0b0c" : "#ece9e2";
  const frame = scheme === "dark" ? "0 0 0 1px #2c2c2e, 0 24px 60px #000a" : "0 0 0 1px #d6d2c8, 0 24px 60px #3a2f1a22";
  const sheet = await browser.newPage({ viewport: { width: 1270, height: 760 } });
  const img = (b64: string) => `<img src="data:image/png;base64,${b64}" style="height:672px;border-radius:34px;box-shadow:${frame}">`;
  await sheet.setContent(`<body style="margin:0;height:760px;background:${ground};display:flex;gap:72px;align-items:center;justify-content:center">${shots.map(img).join("")}</body>`);
  await sheet.screenshot({ path: join(OUT, "gallery", `phone-${scheme}.png`) });
  await sheet.close();
  console.log(`phone-${scheme}`);
}

/** A walk through the app, recorded as video: list → issue → My work → board → cycle → palette; trimmed and made into mp4 and gif. */
async function walk(): Promise<void> {
  const tmp = join(OUT, ".video");
  rmSync(tmp, { recursive: true, force: true });
  const ctx = await context(browser, "light", { ...GALLERY, video: tmp }, demo.session);
  const p = await ctx.newPage();
  const began = Date.now();
  await settle(p, `${WS}/projects/WEB/issues`);
  const trim = (Date.now() - began) / 1000;
  const beat = (ms = 1100) => p.waitForTimeout(ms);
  await beat(900);
  await click(p, 'text="Add CSV export to the issue list"');
  await beat(1500);
  await click(p, 'text="My work"');
  await beat(1700);
  await click(p, 'text="Web app"');
  await beat(900);
  await click(p, 'a:has-text("Issues")');
  await beat(700);
  await boardView(p);
  await beat(1300);
  await click(p, 'text="Cycles"');
  await beat(1700);
  await p.keyboard.press("Control+k");
  await beat(1200);
  await ctx.close();
  const raw = readdirSync(tmp).find((f) => f.endsWith(".webm"))!;
  const src = join(tmp, raw);
  const ff = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", trim.toFixed(2), "-i", src, "-t", "10", ...args], { stdio: "inherit" });
  ff("-vf", "scale=1270:-2", "-c:v", "libx264", "-crf", "30", "-pix_fmt", "yuv420p", "-an", join(OUT, "navigation.mp4"));
  ff("-vf", "fps=10,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", join(OUT, "navigation.gif"));
  rmSync(tmp, { recursive: true, force: true });
  console.log(`navigation: ${(Date.now() - began) / 1000 | 0}s recorded, ${(statSync(join(OUT, "navigation.gif")).size / 1e6).toFixed(1)} MB gif`);
}

const wanted = (name: string) => !ONLY || ONLY.includes(name);
const demo = await startDemo(Number(process.env.DEMO_PORT ?? 3898));
process.env.DEMO_BASE = demo.server.url;
mkdirSync(join(OUT, "gallery"), { recursive: true });
const browser = await chromium.launch();
try {
  for (const scheme of ["light", "dark"] as const) {
    const gallery = await context(browser, scheme, GALLERY, demo.session);
    const p = await gallery.newPage();
    for (const s of SCREENS.filter((s) => wanted(s.name))) {
      await settle(p, s.path, s.act, s.wide ?? false);
      await p.screenshot({ path: join(OUT, "gallery", `${s.name}-${scheme}.png`) });
      console.log(`${s.name}-${scheme}`);
    }
    await gallery.close();
    if (wanted("phone")) await phonePair(scheme);
    if (wanted("hero")) {
      const hero = await context(browser, scheme, HERO, demo.session);
      const h = await hero.newPage();
      await settle(h, `${WS}/projects/WEB/issues`);
      await h.screenshot({ path: join(OUT, scheme === "light" ? "screenshot.png" : "screenshot-dark.png") });
      await hero.close();
      console.log(`hero-${scheme}`);
    }
  }
  if (wanted("navigation")) await walk();
} finally {
  await browser.close();
  await demo.server.kill();
  await demo.db.drop();
}
