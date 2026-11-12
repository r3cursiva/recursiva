import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const watchdog = fileURLToPath(new URL("./watchdog.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "test-watchdog-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** The real runner with the flags of the packages' scripts, as a run of its own on a test file written here. */
function run(name: string, source: string): Promise<{ status: number | null; out: string; seconds: number }> {
  const file = join(dir, `${name}.test.ts`);
  writeFileSync(file, `import { test } from "node:test";\n${source}`);
  const { NODE_TEST_CONTEXT: _child, ...env } = process.env;
  const started = Date.now();
  const args = ["--test", "--test-force-exit", "--test-timeout=60000", `--import=${watchdog}`, file];
  const child = spawn(process.execPath, args, { env: { ...env, TEST_STALL_S: "2" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, out, seconds: (Date.now() - started) / 1000 })));
}

describe("the watchdog", { concurrency: true }, () => {
  it("names a blocked event loop with its line, and the run ends", async () => {
    const r = await run("blocked", `test("fine", () => {});\ntest("spins", () => {\n  while (true);\n});\n`);
    assert.equal(r.status, 1);
    assert.match(r.out, /is stuck in the test "spins", no new test for 2 s/);
    assert.match(r.out, /blocked\.test\.ts:4/);
  });

  it("names promises that never yield to a timer", async () => {
    const r = await run("microtasks", `test("awaits", async () => {\n  for (;;) await null;\n});\n`);
    assert.equal(r.status, 1);
    assert.match(r.out, /is stuck in the test "awaits"/);
  });

  it("names a file that never reaches its first test", async () => {
    const r = await run("import", `setInterval(() => {}, 1000);\nawait new Promise(() => {});\ntest("never", () => {});\n`);
    assert.equal(r.status, 1);
    assert.match(r.out, /import\.test\.ts is stuck before its first test/);
  });

  it("lets a file of slow tests live as long as new ones start", async () => {
    const slow = (n: number) => `test("slow ${n}", () => new Promise((r) => setTimeout(r, 600)));\n`;
    const r = await run("slow", [1, 2, 3, 4, 5].map(slow).join(""));
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /test watchdog/);
    assert.ok(r.seconds > 2, "longer than the limit");
  });

  it("counts a subtest as a new test", async () => {
    const inner = "for (let i = 0; i < 5; i++) await t.test(`inner ${i}`, () => new Promise((r) => setTimeout(r, 600)));";
    const r = await run("nested", `test("outer", async (t) => {\n  ${inner}\n});\n`);
    assert.equal(r.status, 0, r.out);
  });
});
