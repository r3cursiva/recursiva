// The stage 1 criteria on the owner's network profile (Mac → Moscow): 280 ms latency, 120 KB/s down.
// Starts the server on the built shell and an existing workspace, opens it in throttled Chromium and measures:
// - cold start (empty cache): shell, data (snapshot `ready`), list painted, socket up; bytes and requests;
// - warm start (tab reopened: Service Worker shell, IndexedDB data);
// - project switch (click in the sidebar → new list painted), budget 50 ms;
// - issue from the list (click → its first comment on screen, from the activity kept in IndexedDB), budget 100 ms;
// - issue page on a warm start (a link opened again → its first comment on screen), budget 300 ms;
// - agent edit: PATCH through the REST API → the change visible in the open window, budget 1 s.
//
// Chromium's throttling adds latency to responses but not to connection setup. In reality DNS, TCP and TLS add about
// three round trips before the first byte, so for cold start we also compute "measured + 3 × latency" and check that
// estimate against the budget.
//
// The workspace: without PERF_WS, the synthetic fixture (tools/fixtures, preset sample) imported into a database of the
// run's own, rsva_perf_test, dropped at the end (PLNR-393): the shared dev database is migrated by whichever worktree ran
// last, and the Perf workflow measures a fresh import too. PERF_WS=<slug> measures that workspace in DATABASE_URL as it
// is (the workflow sets it to its own fresh import). The projects and the issue are picked from the snapshot. The page
// opens signed in as the workspace's owner and the agent edits with its token: both are made by the server's CLI
// (apps/server/src/cli/auth.ts) against the same database.
//
// PERF_URL measures a deployed server instead (the stage 1 exit check from the owner's Mac to the stand):
// `PERF_URL=https://app.rsva.dev PERF_WS=<slug> PERF_TOKEN=rsva_… pnpm perf:net`. No local server and no throttling: the
// real network, connection setup included, so "+ 3 RTT" adds nothing. The page and the fetches act as the token's member
// (the server takes a token on every route and the socket); nothing is compared with the local baseline. The agent edit
// renames a real issue and back, so it runs only with PERF_EDIT=1; the switch needs a second project with issues.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fixtureDatabase } from "@rsva/fixtures/database";
import { localServer, signInCookies, type LocalServer } from "@rsva/fixtures/server";
import { parseNdjson } from "@rsva/schema/bundle";
import { quantile } from "@rsva/test-kit";
import { chromium, type BrowserContext, type Page } from "playwright";
import { calibrate, slowdown } from "./cpu.ts";
import { profiledPage } from "./page.ts";
import { acceptFromCi, check, ROOT, runCount, type Metric } from "./report.ts";
import { checkStartupCss } from "./startup-css.ts";

const LATENCY_MS = 280;
const DOWN_BPS = 120 * 1024;
const UP_BPS = 60 * 1024;
const RUNS = runCount("PERF_RUNS", 5);
const PORT = Number(process.env.PERF_PORT ?? 3899);
// The synthetic workspace CI also uses (tools/fixtures sample). The byte baseline is CI's all the same: report.ts.
// PERF_WS=<slug> of a real workspace measures real data.
const WS = process.env.PERF_WS ?? "sample";
/** CPU slowdown factor (Chromium throttling): 2 approximates a CI runner or a slower laptop, 4 a phone. */
const CPU = Number(process.env.PERF_CPU ?? 1);
const REMOTE = process.env.PERF_URL?.replace(/\/+$/, "");
const ORIGIN = REMOTE ?? `http://127.0.0.1:${PORT}`;
const EDIT = !REMOTE || process.env.PERF_EDIT === "1";
const cli = (...args: string[]) =>
  execFileSync(process.execPath, [join(ROOT, "apps/server/src/cli/auth.ts"), ...args, "--ws", WS], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
if (REMOTE && !process.env.PERF_TOKEN) throw new Error("PERF_URL needs PERF_TOKEN, an API token of the workspace");
if (REMOTE && process.argv.includes("--update")) throw new Error("a remote measurement does not update the baseline");
if (process.argv.includes("--update") && !process.env.CI) {
  acceptFromCi("net");
  process.exit(0);
}
// Runs from several worktrees take turns on it (and on PORT).
const ownDb = REMOTE || process.env.PERF_WS ? null : await fixtureDatabase("rsva_perf_test", "sample", WS);
// The server and the auth CLI below inherit it.
if (ownDb) process.env.DATABASE_URL = ownDb.url;
/** The owner's session (cookie value on http) and a write token of the agent member; remotely, only the given token. */
const SESSION = REMOTE ? "" : cli("session");
const TOKEN = process.env.PERF_TOKEN ?? cli("token", "--name", "perf");
const asOwner: Record<string, string> = REMOTE ? { authorization: `Bearer ${TOKEN}` } : { cookie: `rsva_sid=${SESSION}` };

interface Start {
  shell: number;
  data: number;
  screen: number;
  hello: number;
  bytes: number;
  requests: number;
  /** Bytes of the background fetch of activity to keep; 0 on a warm start. */
  fill: number;
}

interface IssueOpen {
  ms: number;
  requests: number;
}

/** The workspace owner's session on the local server, as the browser would hold it. */
const localCookies = signInCookies(ORIGIN, SESSION);

let server: LocalServer | null = null;
try {
  // The production build and flags (apps/server `start`), so memory and startup are what a deploy gets.
  if (!REMOTE)
    server = await localServer({
      entry: join(ROOT, "apps/server/dist/main.js"),
      nodeFlags: ["--max-semi-space-size=16"],
      port: PORT,
      env: { LOG_LEVEL: "warn", RSVA_MAIL: "log" },
    });
  const target = await pickTargets();
  const snapshotBytes = await primeSnapshotCache(target.key);
  const browser = await chromium.launch();
  const cpu = await calibrate(browser);
  const cold: Start[] = [];
  const warm: Start[] = [];
  const nav: number[] = [];
  const issueOpen: IssueOpen[] = [];
  const issuePage: IssueOpen[] = [];
  const edit: number[] = [];
  // Cold and warm starts first, edits after: an edit moves the log number, and the next cold start would always miss
  // the server's snapshot cache (brotli 5 instead of 11). The first cold run is the miss, the rest are hits.
  // A browser per cold run: contexts of one Chromium share a font cache, so every other "cold" start used to get the
  // font (29.7 KB) from memory and the bytes alternated between runs.
  const contexts: BrowserContext[] = [];
  const browsers = [browser];
  for (let i = 0; i < RUNS; i++) {
    const b = i === 0 ? browser : await chromium.launch();
    if (i > 0) browsers.push(b);
    const ctx = await b.newContext(REMOTE ? { extraHTTPHeaders: asOwner } : {});
    // Headless Chromium parks the pointer at (0, 0), over the sidebar: as the workspace button appears it gets a
    // pointerover, and hovering it fetches what its menu shows. Those requests are a hover's, not the start's, and
    // whether they finished before the count depended on the runner. Moving the pointer away before the page draws is
    // a race, so boundary events at (0, 0) are dropped before the app sees them; the clicks of the switch test come from
    // real moves elsewhere.
    await ctx.addInitScript(() => {
      for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter"])
        addEventListener(t, (e) => void ((e as MouseEvent).clientX === 0 && (e as MouseEvent).clientY === 0 && e.stopImmediatePropagation()), true);
    });
    await ctx.addCookies(REMOTE ? signInCookies(ORIGIN) : localCookies);
    contexts.push(ctx);
    cold.push((await open(ctx, target.url, true)).start);
  }
  for (const ctx of contexts) {
    const w = await open(ctx, target.url, false);
    warm.push(w.start);
    if (target.otherKey) nav.push(await switchProject(w.page, target.otherKey, target.key, target.openedKey));
    if (EDIT) edit.push(await agentEdit(w.page, target.issueKey, target.issueTitle));
    // After the edit: closing the pane animates, and the edit would be timed through that.
    issueOpen.push(await openIssue(w.page, target.openedKey, target.issueText));
    issuePage.push(await openIssuePage(ctx, target.openedKey, target.issueText));
    await ctx.close();
  }
  // Locally only: a deployed page is the same build, and this needs no network profile.
  if (!REMOTE) {
    await checkStartupCss(browser, target.url, localCookies);
  }
  for (const b of browsers) await b.close();
  // Resident memory of the server process (ps reports KiB): /healthz no longer tells it to anyone who asks (PLNR-32).
  const rss = server ? Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", String(server.pid)], { encoding: "utf8" }).trim()) / 1024) : 0;

  const med = (xs: number[]) => quantile(xs, 0.5);
  // CPU-bound timings (switch, warm start, opening an issue, which needs no network) are normalized to the owner's Mac, where the budgets were set: a slower
  // machine (a CI runner is 2–3× slower) is divided by its measured slowdown. Network-bound timings stay raw. With
  // PERF_CPU throttling the point is to see the slow device, so nothing is normalized.
  const factor = CPU > 1 ? 1 : slowdown(cpu);
  const norm = (ms: number) => ms / factor;
  const m = (runs: Start[], k: keyof Start) => med(runs.map((r) => r[k]));
  const setup = REMOTE ? 0 : 3 * LATENCY_MS;
  const all: (Metric | false)[] = [
    { key: "net.cold.shell", label: "cold: shell", value: m(cold, "shell"), unit: "ms", ratchet: false },
    { key: "net.cold.data", label: "cold: data ready", value: m(cold, "data"), unit: "ms", ratchet: false },
    { key: "net.cold.screen", label: "cold: list painted", value: m(cold, "screen"), unit: "ms", ratchet: false },
    { key: "net.cold.screen.est", label: "cold: list painted + 3 RTT", value: m(cold, "screen") + setup, unit: "ms", ratchet: false },
    { key: "net.cold.hello", label: "cold: socket up", value: m(cold, "hello"), unit: "ms", ratchet: false },
    // Informational: Chromium serves the font from a cache shared even across launches in some runs, so the total
    // alternates by ~29 KB. What it is made of is gated exactly elsewhere: startup JS/CSS and fonts by perf:bundle, the
    // workspace snapshot just below.
    { key: "net.cold.bytes", label: "cold: bytes over network (info)", value: m(cold, "bytes"), unit: "B", ratchet: false },
    { key: "net.snapshot.br", label: "workspace snapshot, brotli", value: snapshotBytes, unit: "B", ratchet: true },
    { key: "net.cold.requests", label: "cold: requests", value: m(cold, "requests"), unit: "n", ratchet: true },
    { key: "net.warm.screen", label: "warm: list painted (norm.)", value: norm(m(warm, "screen")), unit: "ms", ratchet: false },
    { key: "net.warm.bytes", label: "warm: bytes over network", value: m(warm, "bytes"), unit: "B", ratchet: true },
    { key: "net.fill.bytes", label: "kept activity, first fill (in the background)", value: m(cold, "fill"), unit: "B", ratchet: true },
    issueOpen.length > 0 && { key: "net.issue", label: "issue from the list (norm.)", value: norm(med(issueOpen.map((o) => o.ms))), unit: "ms", ratchet: false },
    issueOpen.length > 0 && { key: "net.issue.requests", label: "issue from the list: requests", value: med(issueOpen.map((o) => o.requests)), unit: "n", ratchet: true },
    issuePage.length > 0 && { key: "net.issue.page", label: "issue page, warm (norm.)", value: norm(med(issuePage.map((o) => o.ms))), unit: "ms", ratchet: false },
    issuePage.length > 0 && { key: "net.issue.page.requests", label: "issue page, warm: requests", value: med(issuePage.map((o) => o.requests)), unit: "n", ratchet: true },
    nav.length > 0 && { key: "net.nav", label: "project switch (norm.)", value: norm(med(nav)), unit: "ms", ratchet: false },
    edit.length > 0 && { key: "net.agent.edit", label: "agent edit visible", value: med(edit), unit: "ms", ratchet: false },
    !!server && { key: "server.rss", label: "server: memory", value: rss, unit: "MB", ratchet: false },
  ];
  // Remotely nothing is ratcheted: the baseline is the local server on the fixture, a stand has other data and network.
  const metrics = all.filter((x): x is Metric => !!x).map((x) => (REMOTE ? { ...x, ratchet: false } : x));
  console.log(
    (REMOTE
      ? `Remote ${ORIGIN}: real network, CPU ×${CPU}; median of ${RUNS} runs.\n`
      : `Profile: ${LATENCY_MS} ms, ${DOWN_BPS / 1024} KB/s down, ${UP_BPS / 1024} KB/s up, CPU ×${CPU}; median of ${RUNS} runs.\n`) +
      `Workspace ${WS}: list ${target.key} (${target.issues} issues), switch to ${target.otherKey ?? "— (one project)"}, ` +
      `edit ${EDIT ? target.issueKey : "— (PERF_EDIT=1 to run it)"}.\n` +
      `CPU benchmark ${cpu.ms.toFixed(0)} ms vs ${cpu.reference} ms on the reference Mac: (norm.) timings divided by ${factor.toFixed(2)}; ` +
      `raw switch ${nav.length ? `${med(nav).toFixed(0)} ms` : "—"}, raw warm ${m(warm, "screen").toFixed(0)} ms.\n`,
  );
  check(REMOTE ? "net-remote" : "net", metrics, { origin: ORIGIN, profile: { LATENCY_MS, DOWN_BPS, UP_BPS, RUNS, CPU }, cpu: { ...cpu, factor }, target, cold, warm, nav, issueOpen, issuePage, edit });
} finally {
  await server?.kill();
  await ownDb?.drop();
}

/** The biggest project is the one we open; the second biggest is the switch target; its first issue gets edited. */
async function pickTargets() {
  const text = await (await fetch(`${ORIGIN}/sync/bootstrap?ws=${WS}`, { headers: asOwner })).text();
  const lines = parseNdjson<{ t: string; m?: string; c?: string[]; r?: unknown[][] }>(text);
  const rows = (m: string) =>
    lines.filter((l) => l.t === "b" && l.m === m).flatMap((l) => l.r!.map((r) => Object.fromEntries(l.c!.map((c, i) => [c, r[i]])) as Record<string, any>));
  const projects = rows("Project");
  const issues = rows("Issue");
  const count = new Map<string, number>();
  for (const i of issues) count.set(i.projectId, (count.get(i.projectId) ?? 0) + 1);
  const [first, second] = [...projects].sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0));
  if (!first || (!second && !REMOTE)) throw new Error(`workspace ${WS} needs at least two projects with issues`);
  const [issue, ...others] = issues.filter((i) => i.projectId === first.id);
  // Not the issue the edits hit: every run adds to its log, and a long enough log loads on open, not ahead.
  const said = await firstComment(first.key as string, others.map((i) => i.number as number));
  return {
    url: `${ORIGIN}/${WS}/projects/${first.key}/issues`,
    key: first.key as string,
    otherKey: second && (count.get(second.id) ?? 0) > 0 ? (second.key as string) : undefined,
    issues: count.get(first.id) ?? 0,
    issueKey: `${first.key}-${issue!.number}`,
    issueTitle: issue!.title as string,
    openedKey: said.key,
    issueText: said.text,
  };
}

/**
 * The first of these issues with a comment, and a run of plain words from it, to tell the comment is on screen. The
 * fixture has no comments: locally the first issue gets one, once, and a remote workspace is not written to.
 */
async function firstComment(project: string, numbers: number[]): Promise<{ key: string; text: string }> {
  const headers = { authorization: `Bearer ${TOKEN}` };
  const url = (n: number) => `${ORIGIN}/api/v1/workspaces/${WS}/issues/${project}-${n}/comments`;
  for (const n of numbers) {
    const { comments } = (await (await fetch(url(n), { headers })).json()) as { comments?: { body: string }[] };
    const text = /[\p{L}\p{N}][\p{L}\p{N} ]{11,}/u.exec(comments?.[0]?.body ?? "")?.[0].slice(0, 24);
    if (text) return { key: `${project}-${n}`, text };
  }
  if (REMOTE || !numbers.length) throw new Error(`no issue of ${project} has a comment to wait for`);
  const text = "The first comment a perf run waits for";
  const r = await fetch(url(numbers[0]!), { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ body: text }) });
  if (!r.ok) throw new Error(`adding the comment to wait for failed: HTTP ${r.status}`);
  return { key: `${project}-${numbers[0]}`, text: text.slice(0, 24) };
}

/**
 * The server answers the first request at a log number with brotli 5 and recompresses with brotli 11 in the
 * background. Whether later cold runs got the smaller body depended on how fast the machine finished that job (a CI
 * runner needs more than the 200 ms a size comparison waited), so bytes differed between a Mac and CI. Measure the
 * steady state: wait until the server reports the brotli 11 body (x-snapshot-quality), up to 30 s.
 */
async function primeSnapshotCache(projectKey: string): Promise<number> {
  const url = `${ORIGIN}/sync/bootstrap?ws=${WS}&project=${projectKey}`;
  for (let i = 0; i < 150; i++) {
    // Node's fetch decompresses the body; Content-Length is the compressed size the browser downloads.
    const res = await fetch(url, { headers: { ...asOwner, "accept-encoding": "br" } });
    const size = Number(res.headers.get("content-length"));
    await res.arrayBuffer();
    if (res.headers.get("x-snapshot-quality") === "11") return size;
    await sleep(200);
  }
  throw new Error("the snapshot cache never reached brotli 11");
}

/** A new page on the owner's network profile (remotely, the real network), its Network domain on for the counts. */
function throttled(ctx: BrowserContext) {
  return profiledPage(ctx, { watch: true, cpu: CPU, ...(REMOTE ? {} : { network: { latency: LATENCY_MS, downloadThroughput: DOWN_BPS, uploadThroughput: UP_BPS } }) });
}

async function open(ctx: BrowserContext, url: string, isCold: boolean): Promise<{ start: Start; page: Page }> {
  const { page, cdp } = await throttled(ctx);
  // WebSocket frames are not in Resource Timing.
  let wsBytes = 0;
  cdp.on("Network.webSocketFrameReceived", (e) => (wsBytes += e.response.payloadData.length));

  await page.goto(url, { waitUntil: "commit" });
  const start: Start = {
    shell: await mark(page, "rsva:shell"),
    data: await mark(page, "rsva:data"),
    screen: await mark(page, "rsva:screen"),
    hello: await mark(page, "rsva:hello"),
    bytes: 0,
    requests: 0,
    fill: 0,
  };
  let closedTotals: Promise<{ bytes: number; requests: number }> = Promise.resolve({ bytes: 0, requests: 0 });
  if (isCold) {
    // Wait for the Service Worker install before closing, so the next (warm) run has it. Its precache downloads (the
    // lazy chunk) happen in the worker after the list has painted and are not counted here: the metric is what the page
    // needs for its first screen.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.waitForLoadState("networkidle");
    closedTotals = page.evaluate(totals);
    await closedTotals;
    // The fill comes after the first screen and apart from it (packages/sync fillFeeds), like the precache above; the
    // warm run needs it on disk.
    await mark(page, "rsva:feeds");
    start.fill = await page.evaluate(() => (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).find((e) => e.name.includes("/sync/feeds"))?.transferSize ?? 0);
    await page.close();
  }
  // Bytes and requests from the browser's own Resource Timing (transferSize: headers + encoded body). The CDP events
  // used before reported 0 for preloaded resources (the font, the lazy chunk) in some runs and nothing for a streamed
  // fetch, so the total jumped by ~30 KB between runs and machines.
  const net = await (isCold ? closedTotals : page.evaluate(totals));
  start.bytes = wsBytes + net.bytes;
  start.requests = net.requests;
  return { start, page };
}

/** Runs in the page: the navigation plus every resource it fetched, as the network delivered them. */
function totals(): { bytes: number; requests: number } {
  const entries = ([...performance.getEntriesByType("navigation"), ...performance.getEntriesByType("resource")] as PerformanceResourceTiming[]).filter((e) => !e.name.includes("/sync/feeds"));
  return { bytes: entries.reduce((n, e) => n + e.transferSize, 0), requests: entries.length };
}

/**
 * Clicks the other project in the sidebar and back, each opening the project's home; returns the app's own measure of the
 * slower switch. Then goes on to the project's issues through the header's tab, where the measures after it start.
 */
async function switchProject(page: Page, otherKey: string, key: string, rowKey: string): Promise<number> {
  const durations: number[] = [];
  for (const k of [otherKey, key]) {
    await page.evaluate(() => performance.clearMeasures("rsva:nav"));
    await page.click(`nav[aria-label="Sidebar"] a[href$="/projects/${k}"]`);
    const h = await page.waitForFunction(() => performance.getEntriesByName("rsva:nav")[0]?.duration, null, { timeout: 10_000, polling: 16 });
    durations.push((await h.jsonValue()) as number);
  }
  await page.locator(`header a[href$="/projects/${key}/issues"]:visible`).first().click();
  await page.waitForSelector(`a[href$="/browse/${rowKey}"]`, { state: "attached", timeout: 10_000 });
  return Math.max(...durations);
}

/** Clicks the issue's row and waits, frame by frame, for its first comment; then closes it. Timed in the page: no CDP in the way. */
async function openIssue(page: Page, key: string, text: string): Promise<IssueOpen> {
  const ms = await page.evaluate(
    async ([key, text]) => {
      performance.clearResourceTimings();
      const row = document.querySelector<HTMLElement>(`a[href$="/browse/${key}"]`)!;
      const t0 = performance.now();
      row.click();
      for (;;) {
        await new Promise(requestAnimationFrame);
        if (document.body.textContent!.includes(text!)) return performance.now() - t0;
      }
    },
    [key, text],
  );
  const requests = await historyRequests(page);
  await page.keyboard.press("Escape");
  return { ms, requests };
}

function historyRequests(page: Page): Promise<number> {
  return page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.includes("/sync/history/")).length);
}

/** Opens the issue's link in a new tab of a warm browser; the page's own clock, from navigation to its first comment. */
async function openIssuePage(ctx: BrowserContext, key: string, text: string): Promise<IssueOpen> {
  const { page } = await throttled(ctx);
  await page.goto(`${ORIGIN}/${WS}/browse/${key}`, { waitUntil: "commit" });
  const h = await page.waitForFunction((t) => document.body.textContent!.includes(t) && performance.now(), text, { timeout: 10_000, polling: "raf" });
  const ms = (await h.jsonValue()) as number;
  const requests = await historyRequests(page);
  await page.close();
  return { ms, requests };
}

/** An agent renames the issue through the REST API; we time until the open window shows the new title. */
async function agentEdit(page: Page, issueKey: string, title: string): Promise<number> {
  const marker = `${title} · perf ${Date.now()}`;
  const patch = (t: string) =>
    fetch(`${ORIGIN}/api/v1/workspaces/${WS}/issues/${issueKey}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ title: t }),
    });
  const t0 = Date.now();
  const res = await patch(marker);
  if (!res.ok) throw new Error(`agent edit failed: ${res.status} ${await res.text()}`);
  await page.waitForFunction((m) => document.body.textContent!.includes(m), marker, { timeout: 10_000, polling: "raf" });
  const ms = Date.now() - t0;
  await patch(title);
  await page.waitForFunction((m) => !document.body.textContent!.includes(m), marker, { timeout: 10_000, polling: "raf" });
  return ms;
}

async function mark(page: Page, name: string): Promise<number> {
  const handle = await page.waitForFunction((n) => performance.getEntriesByName(n)[0]?.startTime, name, { timeout: 30_000, polling: 16 });
  return (await handle.jsonValue()) as number;
}
