import assert from "node:assert/strict";
import { test } from "node:test";
import { FIRST_FONT, firstFontPreload, serviceWorker } from "./shell.ts";

/** The generated worker run against a stub `self`: its listeners, and what it asked of the registration and the windows. */
function run(windows: { url: string; postMessage: (m: unknown) => void; focus: () => Promise<unknown> }[] = []) {
  const listeners = new Map<string, (e: unknown) => void>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
    clients: { matchAll: async () => windows, openWindow: async (p: string) => void opened.push(p) },
  };
  const caches = { match: async () => new Response("shell") };
  new Function("self", "caches", "location", serviceWorker("v1", ["/assets/index.js"]))(self, caches, { origin: "https://plan.test" });
  return { listeners, shown, opened };
}

/** Which fetches the worker answers itself. */
function worker() {
  const { listeners } = run();
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

/** Dispatches an event that waits (waitUntil) and resolves once what it waits for has. */
async function dispatch(listeners: Map<string, (e: unknown) => void>, type: string, e: Record<string, unknown>) {
  let wait: Promise<unknown> = Promise.resolve();
  listeners.get(type)!({ ...e, waitUntil: (p: Promise<unknown>) => (wait = p) });
  await wait;
}

test("a push is shown with its title, text and issue; one about the same issue replaces it", async () => {
  const { listeners, shown } = run();
  const data = { title: "Ann mentioned you on ENG-12", body: "Rotate the edge nodes", url: "https://plan.test/atlas/browse/ENG-12", tag: "0193" };
  await dispatch(listeners, "push", { data: { json: () => data } });
  assert.deepEqual(shown, [{ title: data.title, options: { body: data.body, icon: "/icon-192.png", data: { url: data.url }, tag: "0193", renotify: true } }]);
});

test("a click on a push moves an open window to its issue, or opens one", async () => {
  const notification = { data: { url: "https://plan.test/atlas/browse/ENG-12" }, close: () => {} };
  const fresh = run();
  await dispatch(fresh.listeners, "notificationclick", { notification });
  assert.deepEqual(fresh.opened, ["/atlas/browse/ENG-12"]);
  const messages: unknown[] = [];
  let focused = false;
  const open = run([{ url: "https://plan.test/atlas/inbox", postMessage: (m) => messages.push(m), focus: async () => (focused = true) }]);
  await dispatch(open.listeners, "notificationclick", { notification });
  assert.deepEqual(messages, [{ type: "rsva:open", path: "/atlas/browse/ENG-12" }]);
  assert.ok(focused);
  assert.deepEqual(open.opened, []);
});
