// Plane against the planner on the functions both have, on the same data, from the same machine and over the same path
// (PLNR-79, repeated 2026-11-05). Every app sits on one host behind the same front: on 2026-11-05 the Plane stand
// (plane-stg, our CE fork with a copy of prod) and two planner builds with that copy imported as workspace plane-copy,
// all on one host behind `tailscale serve`. Real network, no throttling, except for the slow pass; the runs alternate
// between the apps, so the network's mood falls on all alike. Median of PERF_RUNS (default 5).
//
//   PLANE_URL=https://plane.example.test:8443 PLANE_CREDENTIALS=~/.config/plane-stg/credentials \
//   PLANE_KEY_FILE=.data/plane-stg/plane-key \
//   RSVA_APPS='plnr-1030 https://plane.example.test:8445 .data/plane-stg/plnr-old-token;plnr https://plane.example.test:8446 .data/plane-stg/plnr-new-token' \
//   PERF_LIST=… PERF_OTHER=… PERF_ISSUE=… PERF_COMMENT_ISSUE=… PERF_SEARCH=… PERF_FOUND=… PERF_LABEL=… \
//   pnpm perf:vs-plane
//
// PERF_DEBUG=1 prints each step, PERF_ONLY=plane,plnr limits the apps, PERF_SLOW_RUNS=0 skips the slow pass. Results:
// perf/out/vs-plane.json or PERF_OUT (nothing is compared with a baseline or budget).
//
// PLANE_CREDENTIALS is an EMAIL=/PASSWORD= file of a Plane member; PLANE_KEY_FILE holds that member's API key, and each
// planner app names a file with a write token of its workspace (secrets are read from files, never from argv).
//
// "Ready" is the same test for every app: text on the page, checked every animation frame. A list is ready when it
// shows PERF_ROWS rows of the project, an issue when its title and its first comment are on the page, a search when the
// expected key is among the results, a filter when every row of the project on the page carries the label, a board when
// the project's cards stand in more than one column, a new issue or comment when it shows outside the editor. Each app
// is opened as it ships: its default layout, grouping and order.
//
// Writes are timed twice: on screen (every app here is optimistic or close to it) and confirmed by the server (Plane:
// the HTTP response; the planner: the socket's `ack`).
//
// It writes: the state change flips PERF_ISSUE to PERF_STATE and back, the REST part renames it and back, every run
// creates an issue in PERF_LIST and comments on PERF_COMMENT_ISSUE. The issues are deleted afterwards (to the trash in
// the planner), Plane's comments too; the planner's comments stay (the API of the 2026-10-30 build cannot delete them).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { quantile } from "@rsva/test-kit";
import { signInCookies } from "@rsva/fixtures/server";
import { chromium, type Browser, type BrowserContext, type Page, type Response as PageResponse } from "playwright";
import { profiledPage } from "./page.ts";
import { fmt, printTable, ROOT, runCount } from "./report.ts";

const RUNS = runCount("PERF_RUNS", 5);
const SLOW_RUNS = runCount("PERF_SLOW_RUNS", 3, 0);
// The data the runs touch belongs to the workspace being measured, so it has no defaults.
const need = (name: string) => process.env[name] ?? (() => { throw new Error(`set ${name}`); })();
const LIST = need("PERF_LIST");
const OTHER = need("PERF_OTHER");
const ISSUE = need("PERF_ISSUE");
const COMMENT_ISSUE = need("PERF_COMMENT_ISSUE");
const SEARCH = need("PERF_SEARCH");
const FOUND = need("PERF_FOUND");
const STATE = process.env.PERF_STATE ?? "In Progress";
const LABEL = need("PERF_LABEL");
const ROWS = Number(process.env.PERF_ROWS ?? 20);
const REST_RUNS = runCount("PERF_REST_RUNS", 10);
const VIEWPORT = { width: 1440, height: 900 };
// The slow pass: Lighthouse's "slow 4G" on top of the real path, and a CPU four times slower (a modest laptop or phone).
const SLOW = { latency: 150, downloadThroughput: (1.6e6 / 8) | 0, uploadThroughput: (750e3 / 8) | 0, cpu: 4 };

const file = (p: string) => readFileSync(p.replace(/^~/, homedir()), "utf8").trim();
const ONLY = process.env.PERF_ONLY?.split(",").map((s) => s.trim());

interface Write {
  shown: number;
  saved: number;
}

/** What differs between the apps: addresses, selectors, the sign-in and how a write is confirmed. */
interface App {
  name: string;
  origin: string;
  context(browser: Browser): Promise<BrowserContext>;
  listUrl(key: string): string;
  issueUrl(key: string): string;
  /** Rows of an issue list and cards of a board; one belongs to a project when its text has `KEY-`. */
  rows: string;
  /** Gets the sidebar ready (untimed) and returns the one click that opens the project's list. */
  switchTo(page: Page, key: string): Promise<() => Promise<void>>;
  /** Moves the open issue from state `from` to `to` in its properties. */
  setState(page: Page, from: string, to: string): Promise<Write>;
  /** Prepares the filter (untimed) and returns its last step, which is timed; `undo` puts the list back. */
  filter(page: Page): Promise<() => Promise<void>>;
  undoFilter(page: Page): Promise<void>;
  /** The click that turns the open list into a board, and the one back. */
  board(page: Page): Promise<void>;
  list(page: Page): Promise<void>;
  /** Creates an issue titled `title` in the open project's list. */
  create(page: Page, title: string): Promise<Write>;
  /** Comments `text` on the open issue. */
  comment(page: Page, text: string): Promise<Write>;
  /** Puts back what an earlier run may have left on the account (untimed). */
  prepare(): Promise<void>;
  /** Removes what the runs made: issues with `prefix` in the title (and Plane's comments). */
  cleanup(prefix: string): Promise<number>;
  rest: Rest;
}

interface Rest {
  get(key: string): Promise<Response>;
  list(project: string): Promise<Response>;
  rename(key: string, title: string): Promise<Response>;
  title(body: any): string;
}

/** Plane: signs in once through its own form, then every new browser starts from that cookie jar. */
async function plane(): Promise<App> {
  const origin = need("PLANE_URL").replace(/\/+$/, "");
  const ws = need("PLANE_WS");
  const creds = Object.fromEntries(
    file(need("PLANE_CREDENTIALS"))
      .split("\n")
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const key = file(need("PLANE_KEY_FILE"));
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${origin}/api/v1/workspaces/${ws}${path}`, { ...init, headers: { "x-api-key": key, "content-type": "application/json", ...init.headers } });
  const projects = new Map<string, string>();
  for (const p of ((await (await api("/projects/")).json()) as { results: { id: string; identifier: string }[] }).results) projects.set(p.identifier, p.id);
  const issueIds = new Map<string, string>();
  const issueId = async (k: string) => {
    if (!issueIds.has(k)) issueIds.set(k, ((await (await api(`/work-items/${k}/`)).json()) as { id: string }).id);
    return issueIds.get(k)!;
  };
  const project = (k: string) => projects.get(k.split("-")[0]!)!;
  const comments: { issue: string; id: string }[] = [];

  // The form, with a retry: on the stand the first load of the sign-in page now and then stalls.
  const signIn = async () => {
    const login = await chromium.launch();
    try {
      const ctx = await login.newContext({ viewport: VIEWPORT });
      const page = await ctx.newPage();
      await page.goto(`${origin}/`);
      await page.fill('input[name="email"]', creds.EMAIL!, { timeout: 60_000 });
      await page.keyboard.press("Enter");
      await page.fill('input[type="password"]', creds.PASSWORD!);
      // The stand's WEB_URL may name another host, so the redirect after the form is not followed: the session cookie
      // is set on this origin by the form's own response.
      await Promise.all([page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/auth/sign-in")), page.keyboard.press("Enter")]);
      // The failed redirect may still be under way: wait for it to give up, then open the workspace, with a retry.
      for (let i = 0; i < 3 && !page.url().startsWith(`${origin}/${ws}`); i++) {
        await page.waitForTimeout(1500);
        await page.goto(`${origin}/${ws}/`).catch(() => {});
      }
      if (!page.url().startsWith(`${origin}/${ws}`)) throw new Error(`plane: sign-in did not stick (${page.url()})`);
      return await ctx.storageState();
    } finally {
      await login.close();
    }
  };
  let storageState: Awaited<ReturnType<typeof signIn>> | undefined;
  for (let i = 0; !storageState; i++) {
    try {
      storageState = await signIn();
    } catch (e) {
      if (i >= 2) throw e;
      console.error(`plane: sign-in failed, again (${(e as Error).message.split("\n")[0]})`);
    }
  }

  // Plane keeps the layout, grouping and filters of a project's list on the account. A board leaves the grouping by
  // state behind, a run cut short may leave the board or the filter: this puts the list back as it opens by default.
  const cookie = storageState.cookies.filter((c) => origin.includes(c.domain.replace(/^\./, ""))).map((c) => `${c.name}=${c.value}`).join("; ");
  const resetView = async () => {
    const url = `${origin}/api/workspaces/${ws}/projects/${projects.get(LIST)}/user-properties/`;
    const headers = { cookie, referer: `${origin}/`, origin, "content-type": "application/json" };
    const before = (await (await fetch(url, { headers })).json()) as { display_filters: object; filters: object };
    const body = JSON.stringify({ display_filters: { ...before.display_filters, layout: "list", group_by: null }, filters: { ...before.filters, labels: null }, rich_filters: {} });
    const res = await fetch(url, { method: "PATCH", headers, body });
    if (!res.ok) throw new Error(`plane: resetting the list's view answered ${res.status}`);
  };
  await resetView();
  const filterButton = async (page: Page) => {
    // The filter is an icon button between the layout switch and Display.
    const at = await page.evaluate(() => {
      const display = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Display")!.getBoundingClientRect();
      const b = [...document.querySelectorAll("button")]
        .map((e) => e.getBoundingClientRect())
        .filter((r) => Math.abs(r.y + r.height / 2 - (display.y + display.height / 2)) < 6 && r.right <= display.left && r.width > 20)
        .sort((a, b) => b.right - a.right)[0]!;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
    await page.mouse.click(at.x, at.y);
    await page.getByText("Label", { exact: true }).click();
    return page.getByRole("option", { name: LABEL, exact: true });
  };
  const layout = (page: Page) => page.locator("button.grid.place-items-center.rounded-sm");

  return {
    name: "plane",
    origin,
    context: (b) => b.newContext({ viewport: VIEWPORT, storageState }),
    listUrl: (k) => `${origin}/${ws}/projects/${projects.get(k)}/issues/`,
    issueUrl: (k) => `${origin}/${ws}/browse/${k}/`,
    rows: 'a[href*="/browse/"]',
    // A project in Plane's sidebar expands on click; its list is the "Work items" link inside. Expanding is not timed.
    async switchTo(page, k) {
      const item = page.locator(`a[href$="/projects/${projects.get(k)}/issues/"]`, { hasText: /^Work items$/ });
      if (!(await item.first().isVisible())) await page.locator(`a[href$="/projects/${projects.get(k)}/issues"]`).first().click();
      await item.first().waitFor();
      return () => item.first().click();
    },
    async setState(page, from, to) {
      const saved = answered(page, "PATCH", /\/(issues|work-items)\/[0-9a-f-]{36}\/$/);
      // The State value in the properties sidebar is a button with the state's name.
      return pickState(page, "button", from, to, async () => (await saved()).at);
    },
    async filter(page) {
      const option = await filterButton(page);
      await option.waitFor();
      return () => option.click();
    },
    async undoFilter(page) {
      const option = page.getByRole("option", { name: LABEL, exact: true });
      await ((await option.isVisible()) ? option : await filterButton(page)).click();
      await page.keyboard.press("Escape");
    },
    board: (page) => layout(page).nth(1).click(),
    // Back to the list keeps the board's grouping by state: the list is put back as it opens by default and reloaded.
    async list(page) {
      await layout(page).nth(0).click();
      await page.waitForTimeout(500);
      await resetView();
      await page.reload({ waitUntil: "commit" });
    },
    prepare: resetView,
    async create(page, title) {
      await page.getByRole("button", { name: "Add work item" }).click();
      await page.locator("input#name").fill(title);
      const saved = answered(page, "POST", /\/issues\/$/);
      return timedWrite(page, () => page.locator('button[type="submit"]').last().click(), () => rowWith(page, 'a[href*="/browse/"]', title), async () => (await saved()).at);
    },
    async comment(page, text) {
      await page.locator('.ProseMirror:has(p[data-placeholder="Add comment"])').click();
      await page.keyboard.insertText(text);
      const saved = answered(page, "POST", /\/comments\/$/);
      const issue = await issueId(COMMENT_ISSUE);
      return timedWrite(page, () => page.locator('button[type="submit"]', { hasText: "Comment" }).first().click(), () => shownOutsideEditor(page, text), async () => {
        const s = await saved();
        comments.push({ issue, id: ((await s.response.json()) as { id: string }).id });
        return s.at;
      });
    },
    async cleanup(prefix) {
      let n = 0;
      for (const c of comments.splice(0)) n += Number((await api(`/projects/${project(COMMENT_ISSUE)}/work-items/${c.issue}/comments/${c.id}/`, { method: "DELETE" })).ok);
      const pid = projects.get(LIST)!;
      for (let cursor: string | undefined, more = true; more; ) {
        const page = (await (await api(`/projects/${pid}/work-items/?per_page=100${cursor ? `&cursor=${cursor}` : ""}`)).json()) as {
          results: { id: string; name: string }[];
          next_cursor: string;
          next_page_results: boolean;
        };
        for (const i of page.results) if (i.name.startsWith(prefix)) n += Number((await api(`/projects/${pid}/work-items/${i.id}/`, { method: "DELETE" })).ok);
        ({ next_cursor: cursor, next_page_results: more } = page);
      }
      return n;
    },
    rest: {
      get: (k) => api(`/work-items/${k}/`),
      list: (p) => api(`/projects/${projects.get(p)}/work-items/?per_page=100`),
      rename: async (k, name) => api(`/projects/${project(k)}/work-items/${await issueId(k)}/`, { method: "PATCH", body: JSON.stringify({ name }) }),
      title: (b) => b.name,
    },
  };
}

/** Watches the planner's socket for `ack` frames; `after(t0)` resolves with the first one at or after t0. */
async function acks(page: Page): Promise<{ after(t0: number): Promise<number>; detach(): Promise<void> }> {
  const { cdp } = await profiledPage(page.context(), { page, watch: true });
  const at: number[] = [];
  let wake = () => {};
  let rejected = "";
  const seen: string[] = [];
  cdp.on("Network.webSocketFrameSent", (e) => void seen.push(`> ${e.response.payloadData.slice(0, 120)}`));
  cdp.on("Network.webSocketCreated", (e) => void seen.push(`ws ${e.url}`));
  cdp.on("Network.webSocketClosed", () => void seen.push("ws closed"));
  cdp.on("Network.webSocketFrameReceived", (e) => void seen.push(`< ${e.response.payloadData.slice(0, 120)}`));
  cdp.on("Network.webSocketFrameReceived", (e) => {
    if (e.response.payloadData.includes('"t":"ack"')) at.push(Date.now()), wake();
    if (e.response.payloadData.includes('"t":"rej"')) (rejected = e.response.payloadData.slice(0, 300)), wake();
  });
  return {
    async after(t0) {
      while (!at.some((a) => a >= t0)) {
        if (rejected) throw new Error(`planner: the write was rejected: ${rejected}`);
        // A missing ack is counted, not fatal: on loopback the 2026-10-30 build now and then sends no frame at all.
        if (Date.now() - t0 > 15_000) {
          console.error(`planner: no ack in 15 s; socket frames meanwhile: ${seen.slice(-8).join(" | ") || "none"}`);
          return Number.NaN;
        }
        await new Promise<void>((r) => ((wake = r), setTimeout(r, 1000)));
      }
      return at.find((a) => a >= t0)!;
    },
    detach: () => cdp.detach(),
  };
}

/** The planner: the token rides on every request and the socket (the server takes a token everywhere). */
function rsva(name: string, origin: string, tokenFile: string): App {
  origin = origin.replace(/\/+$/, "");
  const ws = process.env.RSVA_WS ?? "plane-copy";
  const token = file(tokenFile);
  const auth = { authorization: `Bearer ${token}` };
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${origin}/api/v1/workspaces/${ws}${path}`, { ...init, headers: { ...auth, "content-type": "application/json", ...init.headers } });
  const listUrl = (k: string) => `${origin}/${ws}/projects/${k}/issues`;
  const confirmed = async (page: Page, act: () => Promise<void>, shown: () => Promise<number>) => {
    const a = await acks(page);
    try {
      return await timedWrite(page, act, shown, (t0) => a.after(t0));
    } finally {
      await a.detach();
    }
  };
  return {
    name,
    origin,
    async context(b) {
      const ctx = await b.newContext({ viewport: VIEWPORT, extraHTTPHeaders: auth });
      await ctx.addCookies(signInCookies(origin));
      return ctx;
    },
    listUrl,
    issueUrl: (k) => `${origin}/${ws}/browse/${k}`,
    rows: "[data-issue]",
    // The sidebar's project link: a "Projects" nav in the 2026-10-30 build, the "Sidebar" nav later.
    switchTo: async (page, k) => () => page.locator(`nav a[href$="/projects/${k}/issues"]`).first().click(),
    async setState(page, from, to) {
      const a = await acks(page);
      // The State value in the properties column is a combobox with the state's name.
      try {
        return await pickState(page, 'button[role="combobox"]', from, to, (t0) => a.after(t0));
      } finally {
        await a.detach();
      }
    },
    // `/` focuses the query field; the list follows the query as it is typed.
    async filter(page) {
      await page.keyboard.press("/");
      await page.locator("input:focus").waitFor();
      return () => page.keyboard.insertText(`label:${LABEL}`);
    },
    async undoFilter(page) {
      await page.keyboard.press("Escape");
      // The 2026-10-30 build keeps the filter on the device and has "Clear all"; later ones keep it in the address.
      const clear = page.getByRole("button", { name: "Clear all", exact: true });
      if (await clear.isVisible()) await clear.click();
      else await page.goto(listUrl(LIST), { waitUntil: "commit" });
    },
    board: (page) => page.getByText("Board", { exact: true }).first().click(),
    list: (page) => page.getByText("List", { exact: true }).first().click(),
    async create(page, title) {
      // The header's button, as in Plane: after the List / Board switch the focus sits in its radio, where `c` is typed.
      await page.getByRole("button", { name: /^New work item/ }).first().click();
      await page.locator("[role=dialog] textarea").first().waitFor();
      await page.keyboard.insertText(title);
      return confirmed(page, () => page.keyboard.press("Meta+Enter"), () => rowWith(page, "[data-issue]", title));
    },
    async comment(page, text) {
      await page.locator('[contenteditable=true][aria-label^="Leave a comment"]').click();
      await page.keyboard.insertText(text);
      return confirmed(page, () => page.keyboard.press("Meta+Enter"), () => shownOutsideEditor(page, text));
    },
    prepare: async () => {},
    async cleanup(prefix) {
      const found = (await (await api(`/issues?project=${LIST}&limit=500`)).json()) as { issues: { key: string; title: string }[] };
      let n = 0;
      for (const i of found.issues) if (i.title.startsWith(prefix)) n += Number((await api(`/issues/${i.key}`, { method: "DELETE" })).ok);
      return n;
    },
    rest: {
      get: (k) => api(`/issues/${k}`),
      list: (p) => api(`/issues?project=${p}&limit=100`),
      rename: (k, title) => api(`/issues/${k}`, { method: "PATCH", body: JSON.stringify({ title }) }),
      title: (b) => b.title,
    },
  };
}

// ---- In-page checks: they run every frame, so most read textContent (no layout) ----

const raf = { polling: "raf" as const, timeout: 60_000 };

/** ms since navigation start when `n` rows of `key` are on the page. */
async function rowsReady(page: Page, sel: string, key: string, n: number): Promise<number> {
  const h = await page.waitForFunction(
    ({ sel, key, n }) => {
      let c = 0;
      for (const el of document.querySelectorAll(sel)) if (el.textContent?.includes(`${key}-`) && ++c >= n) return performance.now();
      return false;
    },
    { sel, key, n },
    raf,
  );
  return (await h.jsonValue()) as number;
}

/** ms when at least `n` rows of `key` are on the page and every one of them is in `keys`. */
async function filteredReady(page: Page, sel: string, key: string, keys: string[], n: number): Promise<number> {
  const h = await page.waitForFunction(
    ({ sel, key, keys, n }) => {
      const want = new Set(keys);
      const re = new RegExp(`${key}-\\d+`);
      let c = 0;
      for (const el of document.querySelectorAll(sel)) {
        const k = el.textContent?.match(re)?.[0];
        if (!k) continue;
        if (!want.has(k)) return false;
        c++;
      }
      return c >= n && performance.now();
    },
    { sel, key, keys, n },
    raf,
  );
  return (await h.jsonValue()) as number;
}

/** ms when `n` cards of `key` are on the page in more than one column (a list keeps them in one). */
async function boardReady(page: Page, sel: string, key: string, n: number): Promise<number> {
  const h = await page.waitForFunction(
    ({ sel, key, n }) => {
      const xs = new Set<number>();
      let c = 0;
      for (const el of document.querySelectorAll(sel)) {
        if (!el.textContent?.includes(`${key}-`)) continue;
        c++;
        xs.add(Math.round(el.getBoundingClientRect().x));
      }
      return c >= n && xs.size > 1 && performance.now();
    },
    { sel, key, n },
    raf,
  );
  return (await h.jsonValue()) as number;
}

/** Columns the rows of `key` stand in: 1 for a list. */
const columns = (page: Page, sel: string, key: string) =>
  page.evaluate(({ sel, key }) => new Set([...document.querySelectorAll(sel)].filter((e) => e.textContent?.includes(`${key}-`)).map((e) => Math.round(e.getBoundingClientRect().x))).size, { sel, key });

/** Keys of `key` rows on the page. */
const keysOnPage = (page: Page, sel: string, key: string) =>
  page.evaluate(({ sel, key }) => [...document.querySelectorAll(sel)].map((e) => e.textContent?.match(new RegExp(`${key}-\\d+`))?.[0]).filter(Boolean) as string[], { sel, key });

/** ms since navigation start when every fragment is on the page. */
async function textReady(page: Page, fragments: string[]): Promise<number> {
  const h = await page.waitForFunction((fs) => fs.every((f) => document.body?.textContent?.includes(f)) && performance.now(), fragments, raf);
  return (await h.jsonValue()) as number;
}

/** ms when a row or card carries `title`. */
async function rowWith(page: Page, sel: string, title: string): Promise<number> {
  const h = await page.waitForFunction(({ sel, title }) => [...document.querySelectorAll(sel)].some((e) => e.textContent?.includes(title)) && performance.now(), { sel, title }, raf);
  return (await h.jsonValue()) as number;
}

/** ms when `text` is on the page outside an editor (a posted comment, not the one being typed). */
async function shownOutsideEditor(page: Page, text: string): Promise<number> {
  const h = await page.waitForFunction(
    (text) => [...document.querySelectorAll("p, span, div")].some((e) => e.textContent?.trim() === text && !e.closest('[contenteditable="true"]')) && performance.now(),
    text,
    raf,
  );
  return (await h.jsonValue()) as number;
}

/** Times a write from `act`: until `shown` holds on the page and until `saved` (a Date.now() stamp) arrives. */
async function timedWrite(page: Page, act: () => Promise<void>, shown: () => Promise<number>, saved: (t0: number) => Promise<number>): Promise<Write> {
  const p0 = (await page.evaluate(() => performance.now())) as number;
  const t0 = Date.now();
  await act();
  const s = (await shown()) - p0;
  return { shown: s, saved: (await saved(t0)) - t0 };
}

/**
 * Opens the picker and times from the click on the option `to` (every app lists states as role=option; typing is no
 * common ground, since the planner's picker commits on a typed match): until the trigger shows the new state (`shown`)
 * and until `saved` (the server's confirmation, a Date.now() timestamp) arrives.
 */
async function pickState(page: Page, sel: string, from: string, to: string, saved: (t0: number) => Promise<number>): Promise<Write> {
  // The trigger is found by its text, before and after: the planner re-renders it when the picker opens.
  const showing = (s: string) => page.evaluate(({ sel, s }) => [...document.querySelectorAll(sel)].some((e) => e.textContent?.trim() === s), { sel, s });
  if (await showing(to)) throw new Error(`a ${sel} reads "${to}" before the change`);
  await page.locator(sel, { hasText: new RegExp(`^${from}$`) }).first().click();
  const option = page.getByRole("option", { name: to, exact: true });
  await option.waitFor();
  await page.waitForTimeout(300);
  const shownAt = page.waitForFunction(({ sel, to }) => [...document.querySelectorAll(sel)].some((e) => e.textContent?.trim() === to), { sel, to }, { polling: "raf", timeout: 10_000 });
  const t0 = Date.now();
  await option.click();
  await shownAt;
  const shown = Date.now() - t0;
  return { shown, saved: (await saved(t0)) - t0 };
}

/**
 * Watches for the answer to the first `method` request whose path matches `path`; `at` is when it arrived (Date.now()),
 * taken as it came, not when the caller awaits it.
 */
function answered(page: Page, method: string, path: RegExp): () => Promise<{ at: number; response: PageResponse }> {
  let at = 0;
  const res = page.waitForResponse((r) => {
    const hit = r.request().method() === method && path.test(new URL(r.url()).pathname);
    if (hit) at = Date.now();
    return hit;
  });
  return async () => {
    const response = await res;
    return { at, response };
  };
}

/** Runs `act` and returns ms until `ready` holds, both measured on the page's own clock. */
async function interaction(page: Page, act: () => Promise<void>, ready: () => Promise<number>): Promise<number> {
  const t0 = (await page.evaluate(() => performance.now())) as number;
  await act();
  return (await ready()) - t0;
}

/**
 * Opens a page that counts what the network delivered, by CDP: encoded bytes of every finished response (headers
 * included) and WebSocket payloads, and requests that reached the network. Resource Timing does not do here: Plane's
 * API responses come back with transferSize 0 on a warm start, and WebSocket frames are not in it at all. `slow` puts
 * the page on the slow pass's network and CPU before it loads.
 */
async function openPage(ctx: BrowserContext, slow = false): Promise<{ page: Page; net: () => { bytes: number; requests: number } }> {
  const { page, cdp } = await profiledPage(ctx, { watch: true, ...(slow ? { network: SLOW, cpu: SLOW.cpu } : {}) });
  let bytes = 0;
  let requests = 0;
  // A request counts when it went to the network: not answered by the HTTP cache or a Service Worker.
  const local = new Set<string>();
  cdp.on("Network.requestServedFromCache", (e) => void local.add(e.requestId));
  cdp.on("Network.responseReceived", (e) => void ((e.response.fromDiskCache || e.response.fromServiceWorker || e.response.fromPrefetchCache || e.response.url.startsWith("data:")) && local.add(e.requestId)));
  cdp.on("Network.loadingFinished", (e) => {
    bytes += e.encodedDataLength;
    if (!local.has(e.requestId)) requests++;
  });
  cdp.on("Network.webSocketFrameReceived", (e) => (bytes += e.response.payloadData.length));
  return { page, net: () => ({ bytes, requests }) };
}

interface Run {
  listCold: number;
  listColdBytes: number;
  listColdRequests: number;
  /** Everything fetched in the first 10 s: what keeps loading after the list is up. */
  listColdBytes10s: number;
  listColdRequests10s: number;
  listToIssue: number;
  switchProject: number;
  switchBack: number;
  search: number;
  filter: number;
  board: number;
  createShown: number;
  createSaved: number;
  listWarm: number;
  listWarmBytes: number;
  listWarmRequests: number;
  issueCold: number;
  issueColdBytes: number;
  issueWarm: number;
  stateShown: number;
  stateSaved: number;
  commentShown: number;
  commentSaved: number;
}

const PREFIX = "perf-vs-plane";

async function run(app: App, issue: Fixture, n: number): Promise<Run> {
  const r = {} as Run;
  let current: Page | undefined;
  const step = async (name: string) => {
    if (!process.env.PERF_DEBUG) return;
    console.error(`  ${app.name}: ${name}`);
    if (current) await current.screenshot({ path: join(process.env.PERF_DEBUG_DIR ?? "/tmp", `vs-plane-${app.name}.png`) }).catch(() => {});
  };
  await app.prepare();
  const browser = await chromium.launch();
  try {
    // A fresh browser: empty HTTP cache, no Service Worker, no IndexedDB.
    const ctx = await app.context(browser);
    const { page, net } = await openPage(ctx);
    current = page;
    await page.goto(app.listUrl(LIST), { waitUntil: "commit" });
    r.listCold = await rowsReady(page, app.rows, LIST, ROWS);
    ({ bytes: r.listColdBytes, requests: r.listColdRequests } = net());
    await page.waitForTimeout(Math.max(0, 10_000 - r.listCold));
    ({ bytes: r.listColdBytes10s, requests: r.listColdRequests10s } = net());
    // A run cut short may leave Plane's layout, grouping or filter (saved on the account) behind: the list must be whole.
    if ((await columns(page, app.rows, LIST)) !== 1) throw new Error(`${app.name}: the list opens as a board`);
    if (!(await keysOnPage(page, app.rows, LIST)).includes(issue.key)) throw new Error(`${app.name}: ${issue.key} is not on the list as it opens`);
    if ((await keysOnPage(page, app.rows, LIST)).every((k) => issue.labelled.includes(k))) throw new Error(`${app.name}: the list opens filtered`);

    await step("issue from the list");
    // A click on the title, as a person does: in the planner a click elsewhere on the row only selects it.
    const title = page.locator(app.rows, { hasText: issue.key }).first().getByText(issue.fragments[0]!, { exact: true });
    r.listToIssue = await interaction(page, () => title.click(), () => textReady(page, issue.fragments));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);

    await step("switch");
    r.switchProject = await interaction(page, await app.switchTo(page, OTHER), () => rowsReady(page, app.rows, OTHER, Math.min(ROWS, 10)));
    await page.waitForTimeout(500);
    r.switchBack = await interaction(page, await app.switchTo(page, LIST), () => rowsReady(page, app.rows, LIST, ROWS));
    await page.waitForTimeout(500);

    await step("search");
    await page.keyboard.press("Meta+k");
    await page.waitForSelector("[role=dialog] input");
    // The palette may list recent issues before any typing; then the search would be timed as instant.
    if (await page.evaluate((k) => [...document.querySelectorAll("[role=dialog]")].some((d) => d.textContent?.includes(k)), FOUND)) throw new Error(`${app.name}: ${FOUND} is in the palette before the search`);
    r.search = await interaction(
      page,
      () => page.keyboard.insertText(SEARCH),
      async () => (await page.waitForFunction((k) => [...document.querySelectorAll("[role=dialog]")].some((d) => d.textContent?.includes(k)) && performance.now(), FOUND, raf)).jsonValue() as Promise<number>,
    );
    // Plane's first Escape only clears the field; the palette closes on the next one.
    for (let i = 0; i < 3 && (await page.locator("[role=dialog] input").first().isVisible()); i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(500);

    await step("filter");
    r.filter = await interaction(page, await app.filter(page), () => filteredReady(page, app.rows, LIST, issue.labelled, 10));
    await page.waitForTimeout(500);
    await app.undoFilter(page);
    await page.waitForFunction(
      ({ sel, key, keys }) => [...document.querySelectorAll(sel)].some((e) => { const k = e.textContent?.match(new RegExp(`${key}-\\d+`))?.[0]; return k && !keys.includes(k); }),
      { sel: app.rows, key: LIST, keys: issue.labelled },
      { polling: 100, timeout: 30_000 },
    );
    await rowsReady(page, app.rows, LIST, ROWS);
    await page.waitForTimeout(500);

    await step("board");
    setTimeout(() => void step("board, 5 s in"), 5000);
    r.board = await interaction(page, () => app.board(page), () => boardReady(page, app.rows, LIST, 10));
    await page.waitForTimeout(500);
    await app.list(page);
    await rowsReady(page, app.rows, LIST, ROWS);
    await page.waitForFunction(({ sel, key }) => new Set([...document.querySelectorAll(sel)].filter((e) => e.textContent?.includes(`${key}-`)).map((e) => Math.round(e.getBoundingClientRect().x))).size === 1, { sel: app.rows, key: LIST }, { polling: 100, timeout: 30_000 });
    await page.waitForTimeout(500);

    await step("create");
    ({ shown: r.createShown, saved: r.createSaved } = await app.create(page, `${PREFIX} ${app.name} ${n} ${Date.now()}`));
    // Let the Service Worker (planner) and the HTTP cache settle before the warm start.
    await page.waitForTimeout(2000);
    await page.close();

    await step("warm list");
    // Warm: the tab reopened in the same browser.
    const warm = await openPage(ctx);
    await warm.page.goto(app.listUrl(LIST), { waitUntil: "commit" });
    r.listWarm = await rowsReady(warm.page, app.rows, LIST, ROWS);
    ({ bytes: r.listWarmBytes, requests: r.listWarmRequests } = warm.net());
    await warm.page.close();
    await ctx.close();

    await step("issue by link");
    // The issue by its link: cold in a new browser, then warm in the same one.
    const b2 = await chromium.launch();
    try {
      const c2 = await app.context(b2);
      const cold = await openPage(c2);
      await cold.page.goto(app.issueUrl(issue.key), { waitUntil: "commit" });
      r.issueCold = await textReady(cold.page, issue.fragments);
      r.issueColdBytes = cold.net().bytes;
      await cold.page.waitForTimeout(3000);
      await cold.page.close();
      const again = await openPage(c2);
      await again.page.goto(app.issueUrl(issue.key), { waitUntil: "commit" });
      r.issueWarm = await textReady(again.page, issue.fragments);
      await again.page.waitForTimeout(1500);
      await step("state change");
      ({ shown: r.stateShown, saved: r.stateSaved } = await app.setState(again.page, issue.state, STATE));
      await again.page.waitForTimeout(500);
      await app.setState(again.page, STATE, issue.state);
      await again.page.waitForTimeout(500);
      await step("comment");
      await again.page.goto(app.issueUrl(COMMENT_ISSUE), { waitUntil: "commit" });
      await textReady(again.page, [issue.commentTitle]);
      await again.page.waitForTimeout(1500);
      ({ shown: r.commentShown, saved: r.commentSaved } = await app.comment(again.page, `${PREFIX} ${app.name} ${n} ${Date.now()}`));
      await again.page.waitForTimeout(500);
    } finally {
      await b2.close();
    }
  } finally {
    await browser.close();
  }
  return r;
}

interface Slow {
  listCold: number;
  issueCold: number;
}

/** The cold list and the cold issue by link on a slow network and CPU, each in a browser of its own. */
async function slowRun(app: App, issue: Fixture): Promise<Slow> {
  const once = async (url: string, ready: (p: Page) => Promise<number>) => {
    const b = await chromium.launch();
    try {
      const { page } = await openPage(await app.context(b), true);
      await page.goto(url, { waitUntil: "commit", timeout: 120_000 });
      return await ready(page);
    } finally {
      await b.close();
    }
  };
  return {
    listCold: await once(app.listUrl(LIST), (p) => rowsReady(p, app.rows, LIST, ROWS)),
    issueCold: await once(app.issueUrl(issue.key), (p) => textReady(p, issue.fragments)),
  };
}

interface Fixture {
  key: string;
  state: string;
  fragments: string[];
  /** Keys of PERF_LIST that carry PERF_LABEL: what the filter leaves. */
  labelled: string[];
  commentTitle: string;
}

/** What every app must show, read from a planner: the issue's title and the start of its first comment, the filter's keys. */
async function fixture(app: App, tokenFile: string, ws: string): Promise<Fixture> {
  const headers = { authorization: `Bearer ${file(tokenFile)}` };
  const get = async (path: string) => (await fetch(`${app.origin}/api/v1/workspaces/${ws}${path}`, { headers })).json();
  const i = (await get(`/issues/${ISSUE}`)) as { title: string; state: string };
  const comments = (await get(`/issues/${ISSUE}/comments`)) as { comments?: { body: string }[] };
  const first = comments.comments?.find((c) => c.body.trim());
  const words = (s: string) => s.replace(/[`*_[\]()#>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 28).replace(/\s\S*$/, "");
  const labelled = ((await get(`/issues?project=${LIST}&q=${encodeURIComponent(`label:${LABEL}`)}&limit=500`)) as { issues: { key: string }[] }).issues.map((x) => x.key);
  const commentTitle = ((await get(`/issues/${COMMENT_ISSUE}`)) as { title: string }).title;
  return { key: ISSUE, state: i.state, fragments: [i.title, ...(first ? [words(first.body)] : [])], labelled, commentTitle };
}

async function rest(app: App): Promise<Record<string, number>> {
  const time = async (f: () => Promise<Response>) => {
    const t0 = performance.now();
    const res = await f();
    const body = await res.arrayBuffer();
    if (!res.ok) throw new Error(`${app.name} REST ${res.status} ${new TextDecoder().decode(body).slice(0, 200)}`);
    return { ms: performance.now() - t0, bytes: body.byteLength, body };
  };
  // One request first: the connection (TCP, TLS) is set up once, as an agent with a kept-alive client has it. Its
  // time is reported apart (firstMs): an agent that calls curl per request pays it every time.
  const first = await time(() => app.rest.get(ISSUE));
  // Two more before timing: the first requests after a connection opens were 0.5 s slower on the planner's stand.
  for (let i = 0; i < 2; i++) await time(() => app.rest.list(LIST));
  const title = app.rest.title(JSON.parse(new TextDecoder().decode(first.body)));
  const get: number[] = [];
  const list: number[] = [];
  const rename: number[] = [];
  let getBytes = 0;
  let listBytes = 0;
  for (let i = 0; i < REST_RUNS; i++) {
    const g = await time(() => app.rest.get(ISSUE));
    get.push(g.ms);
    getBytes = g.bytes;
    const l = await time(() => app.rest.list(LIST));
    list.push(l.ms);
    listBytes = l.bytes;
  }
  for (let i = 0; i < Math.ceil(REST_RUNS / 2); i++) {
    rename.push((await time(() => app.rest.rename(ISSUE, `${title} · perf`))).ms);
    rename.push((await time(() => app.rest.rename(ISSUE, title))).ms);
  }
  return { firstMs: first.ms, getMs: med(get), getBytes, listMs: med(list), listBytes, renameMs: med(rename) };
}

/** The median of the values there are: a missed confirmation is NaN, and a metric with none is NaN. */
const med = (all: number[]) => {
  const xs = all.filter((x) => !Number.isNaN(x));
  return xs.length ? quantile(xs, 0.5) : Number.NaN;
};

// RSVA_APPS: "name origin tokenFile" entries separated by ";".
const rsvaSpecs = need("RSVA_APPS")
  .split(";")
  .map((s) => s.trim().split(/\s+/) as [string, string, string]);
const apps = [await plane(), ...rsvaSpecs.map(([n, o, t]) => rsva(n, o, t))].filter((a) => !ONLY || ONLY.includes(a.name));
const [, refOrigin, refToken] = rsvaSpecs.at(-1)!;
const fx = await fixture(rsva("ref", refOrigin, refToken), refToken, process.env.RSVA_WS ?? "plane-copy");
console.log(`Issue ${fx.key} (${fx.state}): ready when the page shows ${JSON.stringify(fx.fragments)}; ${fx.labelled.length} ${LIST} issues carry ${LABEL}`);

const runs: Record<string, Run[]> = Object.fromEntries(apps.map((a) => [a.name, []]));
const slow: Record<string, Slow[]> = Object.fromEntries(apps.map((a) => [a.name, []]));
try {
  for (let i = 0; i < RUNS; i++) {
    // Rotate who goes first.
    for (const app of [...apps.slice(i % apps.length), ...apps.slice(0, i % apps.length)]) {
      const r = await run(app, fx, i + 1);
      runs[app.name]!.push(r);
      console.log(`run ${i + 1} ${app.name}: list cold ${r.listCold.toFixed(0)} ms, warm ${r.listWarm.toFixed(0)} ms, issue cold ${r.issueCold.toFixed(0)} ms, board ${r.board.toFixed(0)} ms`);
    }
  }
  for (let i = 0; i < SLOW_RUNS; i++) {
    for (const app of [...apps.slice(i % apps.length), ...apps.slice(0, i % apps.length)]) {
      const s = await slowRun(app, fx);
      slow[app.name]!.push(s);
      console.log(`slow ${i + 1} ${app.name}: list cold ${s.listCold.toFixed(0)} ms, issue cold ${s.issueCold.toFixed(0)} ms`);
    }
  }
} finally {
  for (const app of apps) console.log(`${app.name}: removed ${await app.cleanup(PREFIX)} items made by the runs`);
}
const restResults: Record<string, Record<string, number>> = {};
for (const app of apps) restResults[app.name] = await rest(app);

const names = apps.map((a) => a.name);
const keys = Object.keys(runs[names[0]!]![0]!) as (keyof Run)[];
const summary = Object.fromEntries(keys.map((k) => [k, Object.fromEntries(names.map((n) => [n, med(runs[n]!.map((r) => r[k]))]))]));
const slowSummary = SLOW_RUNS
  ? Object.fromEntries((["listCold", "issueCold"] as const).map((k) => [k, Object.fromEntries(names.map((n) => [n, med(slow[n]!.map((r) => r[k]))]))]))
  : {};
const rows = [
  ...keys.map((k) => [k, ...names.map((n) => summary[k]![n]!)]),
  ...Object.keys(slowSummary).map((k) => [`slow.${k}`, ...names.map((n) => slowSummary[k]![n]!)]),
  ...Object.keys(restResults[names[0]!]!).map((k) => [`rest.${k}`, ...names.map((n) => restResults[n]![k]!)]),
];
const unit = (k: string) => (/Bytes|bytes/.test(k) ? "B" : /Requests|requests/.test(k) ? "n" : "ms");
console.log(`\nMedian of ${RUNS} runs (slow pass: ${SLOW_RUNS}, REST: ${REST_RUNS}); list ${LIST}, switch to ${OTHER}, issue ${ISSUE}, search "${SEARCH}" → ${FOUND}, filter label ${LABEL}\n`);
printTable(["metric", ...names], (rows as [string, ...number[]][]).map(([k, ...vs]) => [k, ...vs.map((v) => fmt(v, unit(k)))]));
const out = process.env.PERF_OUT ?? join(ROOT, "perf/out/vs-plane.json");
mkdirSync(join(out, ".."), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      date: new Date().toISOString(),
      apps: apps.map((a) => ({ name: a.name, origin: a.origin })),
      target: { LIST, OTHER, ISSUE, COMMENT_ISSUE, SEARCH, FOUND, STATE, LABEL, ROWS, RUNS, SLOW_RUNS, REST_RUNS, SLOW },
      fixture: { ...fx, labelled: fx.labelled.length },
      summary,
      slow: slowSummary,
      rest: restResults,
      runs,
      slowRuns: slow,
    },
    null,
    2,
  ) + "\n",
);
