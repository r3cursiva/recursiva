// The startup stylesheet paints the startup screen as the whole one does (PLNR-286, apps/web/build/startup-css.ts).
// It keeps a rule when a startup module mentions its class; a class put together at run time, or taken from a lazy
// module's text, would lose its rule here and show only once the whole sheet comes with the edit chunk. So: open the
// list with the whole sheet held back, take every element's computed style and box, add the whole sheet, compare.
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";

/** Values that follow from layout and fonts rather than from a rule; the boxes are compared instead. */
const LAYOUT = /^(width|height|inline-size|block-size|perspective-origin|transform-origin|margin(-[a-z]+)*)$/;

const SCREENS: { name: string; options: BrowserContextOptions }[] = [
  { name: "wide, light", options: { viewport: { width: 1280, height: 800 }, colorScheme: "light" } },
  { name: "phone, dark", options: { viewport: { width: 390, height: 844 }, colorScheme: "dark", hasTouch: true, isMobile: true } },
];

/** Throws, naming the first differences, when the list looks different with the startup sheet alone. */
export async function checkStartupCss(browser: Browser, url: string, cookies: Parameters<BrowserContext["addCookies"]>[0]): Promise<void> {
  const problems: string[] = [];
  for (const screen of SCREENS) {
    const ctx = await browser.newContext({ ...screen.options, serviceWorkers: "block" });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let whole = "";
    await page.route(/\/assets\/index-[\w-]+\.css$/, async (route) => {
      whole = new URL(route.request().url()).pathname;
      await held;
      await route.continue();
    });
    await page.goto(url);
    await page.waitForSelector("[data-issue]");
    const href = await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="rsva-css"]')?.content ?? "");
    if (!href) throw new Error("startup CSS: the page names no whole stylesheet (meta rsva-css)");
    // Settled: two looks a moment apart agree, so a difference below is the sheet's, not a late paint's.
    let before = await look(page);
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(300);
      const again = await look(page);
      if (same(before, again)) break;
      before = again;
    }
    release();
    await page.evaluate(
      (href) =>
        new Promise<void>((resolve) => {
          const link = document.querySelector<HTMLLinkElement>(`link[rel="stylesheet"][href="${href}"]`) ?? Object.assign(document.createElement("link"), { rel: "stylesheet", href });
          if (link.sheet) return resolve();
          link.addEventListener("load", () => resolve());
          if (!link.isConnected) document.head.append(link);
        }),
      href,
    );
    const after = await look(page);
    if (before.dom !== after.dom) throw new Error(`startup CSS (${screen.name}): the page changed while the whole sheet loaded; nothing to compare`);
    const diff = differences(before, after);
    if (diff.length) problems.push(`${screen.name}: ${diff.length} elements differ (${whole || href} was held back), first:\n  ${diff.slice(0, 5).join("\n  ")}`);
    await ctx.close();
  }
  if (problems.length) {
    throw new Error(`startup CSS: the list looks different without the whole stylesheet — a class the startup modules do not mention?\n${problems.join("\n")}`);
  }
}

interface Look {
  dom: string;
  elements: { what: string; box: string; style: string }[];
}

function look(page: Page): Promise<Look> {
  return page.evaluate((layout) => {
    const skip = new RegExp(layout);
    const elements = [...document.querySelectorAll("body *")].map((el) => {
      const r = el.getBoundingClientRect();
      let style = "";
      for (const pseudo of [null, "::before", "::after"]) {
        const cs = getComputedStyle(el, pseudo);
        for (let i = 0; i < cs.length; i++) if (!skip.test(cs[i]!)) style += `${pseudo ?? ""}${cs[i]}:${cs.getPropertyValue(cs[i]!)};`;
      }
      return { what: `<${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}">`, box: `${r.x},${r.y},${r.width},${r.height}`, style };
    });
    return { dom: document.body.innerHTML, elements };
  }, LAYOUT.source);
}

function same(a: Look, b: Look): boolean {
  return a.dom === b.dom && differences(a, b).length === 0;
}

function differences(a: Look, b: Look): string[] {
  const out: string[] = [];
  a.elements.forEach((x, i) => {
    const y = b.elements[i]!;
    if (x.box !== y.box) out.push(`${x.what.slice(0, 120)} box ${x.box} → ${y.box}`);
    else if (x.style !== y.style) {
      const p = x.style.split(";"), q = y.style.split(";");
      out.push(`${x.what.slice(0, 120)} ${p.filter((s, j) => s !== q[j]).slice(0, 3).join("; ")} → ${q.filter((s, j) => s !== p[j]).slice(0, 3).join("; ")}`);
    }
  });
  return out;
}
