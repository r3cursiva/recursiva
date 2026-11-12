// The editor on its own (pnpm perf:editor): the real component from packages/editor, toolbar included, bundled with
// esbuild into a one-page harness and measured in Chromium.
// - mount: time from render to a laid-out DOM on the 50 KB fixture (and the 3.5 KB one, the largest real description),
//   median of 12 fresh pages;
// - keys: input → next frame for 100 keystrokes in the middle of the 50 KB document at CPU ×4 (a phone), p50 and p95;
//   median of 5 rounds, each with its own CPU calibration. A shared CI runner has slow spells of a few seconds: one round
//   there gave p95 7–20 ms on the same machine, the median of 8 rounds 8–11 ms (PLNR-72).
// The bench these numbers continue: docs/research/editors-2026-10-27.md.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { quantile } from "@rsva/test-kit";
import { chromium, type Browser } from "playwright";
import { calibrate, slowdown } from "./cpu.ts";
import { profiledPage } from "./page.ts";
import { check, ROOT, runCount, type Metric } from "./report.ts";

const RUNS = runCount("PERF_RUNS", 12);
const KEY_ROUNDS = 5;
const dir = mkdtempSync(join(tmpdir(), "rsva-editor-"));
await build({
  entryPoints: [join(ROOT, "packages/editor/perf/harness.tsx")],
  outdir: dir,
  bundle: true,
  minify: true,
  format: "esm",
  jsx: "automatic",
  loader: { ".html": "text" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
writeFileSync(
  join(dir, "index.html"),
  `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="harness.css"><body style="font-family:system-ui;margin:0">` +
    `<div id="editor" style="max-width:46rem;margin:24px auto"></div><script type="module" src="harness.js"></script>`,
);
const server = createServer((req, res) => {
  const file = (req.url ?? "/").split("?")[0] === "/" ? "index.html" : (req.url ?? "").split("?")[0]!.slice(1);
  try {
    const body = readFileSync(join(dir, file));
    res.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/`;


async function mount(browser: Browser, doc: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const page = await browser.newPage();
    await page.goto(`${url}?doc=${doc}`);
    await page.waitForFunction(() => document.title === "ready", null, { timeout: 30_000 });
    out.push(await page.evaluate(() => (window as unknown as { bench: { mountMs: number } }).bench.mountMs));
    await page.close();
  }
  return out;
}

async function keys(browser: Browser, cpu: number, n: number): Promise<number[]> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${url}?doc=doc-50k`);
  await page.waitForFunction(() => document.title === "ready");
  await profiledPage(ctx, { page, cpu });
  // The caret in a long paragraph near the middle of the document.
  await page.evaluate(() => {
    const ps = [...document.querySelectorAll<HTMLElement>(".ProseMirror p")].filter((p) => (p.textContent ?? "").length > 40);
    const p = ps[Math.floor(ps.length / 2)]!;
    p.scrollIntoView({ block: "center" });
    const r = document.createRange();
    r.setStart(p.firstChild!, 10);
    r.collapse(true);
    (p.closest(".ProseMirror") as HTMLElement).focus();
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
    const lat: number[] = [];
    (window as unknown as { lat: number[] }).lat = lat;
    document.addEventListener(
      "keydown",
      (e) => {
        const t0 = e.timeStamp;
        requestAnimationFrame(() => {
          const c = new MessageChannel();
          c.port1.onmessage = () => lat.push(performance.now() - t0);
          c.port2.postMessage(0);
        });
      },
      true,
    );
  });
  const text = "lorem ipsum dolor sit amet ";
  for (let i = 0; i < n; i++) {
    await page.keyboard.type(text[i % text.length]!);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
  const lat = await page.evaluate(() => (window as unknown as { lat: number[] }).lat);
  const landed = await page.evaluate(() => document.querySelector(".ProseMirror")!.textContent!.includes("lorem ipsum dolor"));
  if (!landed) throw new Error("the typed text did not reach the document");
  await ctx.close();
  return lat;
}

try {
  const browser = await chromium.launch();
  // Mount times are divided by this machine's slowdown against the owner's Mac (cpu.ts). Keystrokes instead run on an
  // emulated device 4x slower than that Mac: the throttling rate is 4 / slowdown, so a CI runner (~2x slower) gets ~2x.
  // Keystroke→frame waits for the next frame (16.7 ms), so dividing it by a factor afterwards would be wrong.
  const cpuRef = await calibrate(browser);
  const factor = slowdown(cpuRef);
  const small = await mount(browser, "desc-3k5");
  const large = await mount(browser, "doc-50k");
  // Each round calibrates again right before typing, so the throttling follows the runner's speed at that moment.
  const rounds: { cpu: number; rate: number; x4: number[] }[] = [];
  for (let i = 0; i < KEY_ROUNDS; i++) {
    const c = await calibrate(browser);
    const rate = Math.max(1, 4 / slowdown(c));
    rounds.push({ cpu: c.ms, rate, x4: await keys(browser, rate, 100) });
  }
  await browser.close();
  const size = readFileSync(join(dir, "harness.js")).length;
  console.log(`Harness bundle: ${(size / 1024).toFixed(0)} KiB minified (editor, toolbar, React). Median of ${RUNS} mounts; ` +
      `${KEY_ROUNDS} rounds of 100 keystrokes on a device 4× slower than the reference Mac, median of the rounds.\n`);
  const metrics: Metric[] = [
    { key: "editor.mount.3k5", label: "mount, 3.5 KB description (norm.)", value: quantile(small, 0.5) / factor, unit: "ms", ratchet: false },
    { key: "editor.mount.50k", label: "mount, 50 KB document (norm.)", value: quantile(large, 0.5) / factor, unit: "ms", ratchet: false },
    { key: "editor.keys.p50.x4", label: "keystroke → frame p50, 4× slower than ref.", value: quantile(rounds.map((r) => quantile(r.x4, 0.5)), 0.5), unit: "ms", ratchet: false },
    { key: "editor.keys.p95.x4", label: "keystroke → frame p95, 4× slower than ref.", value: quantile(rounds.map((r) => quantile(r.x4, 0.95)), 0.5), unit: "ms", ratchet: false },
  ];
  console.log(
    `CPU benchmark ${cpuRef.ms.toFixed(0)} ms vs ${cpuRef.reference} ms on the reference Mac: mounts divided by ${factor.toFixed(2)}, ` +
      `keystrokes at throttling ×${rounds.map((r) => r.rate.toFixed(2)).join(", ×")} (= 4× slower than the reference).\n`,
  );
  console.log(`keystroke p95 by round: ${rounds.map((r) => quantile(r.x4, 0.95).toFixed(1)).join(", ")} ms\n`);
  check("editor", metrics, { small, large, rounds, cpu: { ...cpuRef, factor } });
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
