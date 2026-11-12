import assert from "node:assert/strict";
import { test } from "node:test";
import { FIRST_FONT, firstFontPreload, serviceWorker } from "./shell.ts";

/** Runs the generated worker against a stub `self` and reports which fetches it answers itself. */
function worker() {
  const listeners = new Map<string, (e: unknown) => void>();
  const self = { addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn) };
  const caches = { match: async () => new Response("shell") };
  new Function("self", "caches", "location", serviceWorker("v1", ["/assets/index.js"]))(self, caches, { origin: "https://plan.test" });
  return (path: string, mode = "navigate") => {
    let answered = false;
    listeners.get("fetch")!({ request: { method: "GET", url: `https://plan.test${path}`, mode }, respondWith: () => (answered = true) });
    return answered;
  };
}

test("the worker serves the shell for app routes only; the server's own paths go to the network", () => {
  const answers = worker();
  for (const path of ["/", "/atlas/projects/PLNR/issues", "/join/abc", "/atlas/files"]) assert.equal(answers(path), true, path);
  // An image opened in a new tab, a sign-in link, the API: never the app.
  for (const path of ["/files/atlas/0f3a?name=x.png", "/auth/link", "/api/v1/me", "/sync/bootstrap", "/healthz"]) assert.equal(answers(path), false, path);
  assert.equal(answers("/assets/index.js", "cors"), true);
});

test("only the Latin Onest file is the first font: the other subsets stay on demand", () => {
  assert.ok(FIRST_FONT.test("onest-latin-wght-normal-Dun_Rd-l.woff2"));
  for (const f of ["onest-latin-ext-wght-normal-QAhDxQuo.woff2", "onest-cyrillic-wght-normal-DayYxulF.woff2", "jetbrains-mono-latin-400-normal-V6pRDFza.woff2"]) {
    assert.ok(!FIRST_FONT.test(f), f);
  }
});

test("the first font is preloaded only on a load the worker controls: a first visit spends no bandwidth on it", () => {
  const run = (controller: object | null) => {
    const added: Record<string, string>[] = [];
    const document = { createElement: () => ({}), head: { append: (el: Record<string, string>) => added.push(el) } };
    new Function("navigator", "document", firstFontPreload("/assets/onest-latin-wght-normal-x.woff2"))({ serviceWorker: { controller } }, document);
    return added;
  };
  assert.deepEqual(run(null), []);
  assert.deepEqual(run({}), [{ rel: "preload", as: "font", type: "font/woff2", crossOrigin: "anonymous", href: "/assets/onest-latin-wght-normal-x.woff2" }]);
});
