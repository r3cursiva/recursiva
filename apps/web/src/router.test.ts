import assert from "node:assert/strict";
import { test } from "node:test";

// router.ts starts the app's router on import: give it the browser globals it reads.
const pushed: string[] = [];
const fakeHistory = {
  state: null as unknown,
  replaceState: () => {},
  pushState(state: unknown, _: string, path: string) {
    fakeHistory.state = state;
    pushed.push(path);
  },
};
Object.assign(globalThis, { location: { pathname: "/", search: "" }, history: fakeHistory, addEventListener: () => {} });
const { parseRoute, routePath, router } = await import("./router.ts");

test("routes: segments are decoded, a malformed escape matches no route instead of throwing", () => {
  assert.deepEqual(parseRoute("/atlas/browse/plnr-7"), { name: "browse", ws: "atlas", projectKey: "PLNR", issueKey: "PLNR-7" });
  assert.deepEqual(parseRoute("/join/a%2Fb"), { name: "join", ws: null, secret: "a/b" });
  // The workspace "%E0" does not exist: the app shows its "not found" screen.
  assert.deepEqual(parseRoute("/%E0"), { name: "home", ws: "%E0" });
  assert.deepEqual(parseRoute("/atlas/browse/%E0"), { name: "home", ws: "atlas" });
});

test("routes: a query or a hash does not change the route", () => {
  assert.deepEqual(parseRoute("/atlas/settings/members?invite"), { name: "workspaceMembers", ws: "atlas" });
  assert.deepEqual(parseRoute("/atlas/projects/plnr/issues#top"), { name: "issues", ws: "atlas", projectKey: "PLNR" });
});

test("routes: the settings' pages for tokens and for the person's own security", () => {
  assert.deepEqual(parseRoute("/atlas/settings/tokens"), { name: "workspaceTokens", ws: "atlas" });
  assert.equal(routePath({ name: "workspaceTokens", ws: "atlas" }), "/atlas/settings/tokens");
  assert.deepEqual(parseRoute("/atlas/settings/tokens/x"), { name: "home", ws: "atlas" });
});

test("routes: the person's own pages name no workspace; with one in front they open beside it (PLNR-225)", () => {
  for (const [path, name] of [
    ["/settings/profile", "accountProfile"],
    ["/settings/preferences", "accountPreferences"],
    ["/settings/appearance", "accountAppearance"],
    ["/settings/notifications", "accountNotifications"],
    ["/settings/notifications/email", "accountEmail"],
    ["/settings/notifications/telegram", "accountTelegram"],
    ["/settings/security", "accountSecurity"],
  ] as const) {
    assert.deepEqual(parseRoute(path), { name, ws: null });
    assert.equal(routePath(parseRoute(path)), path);
    // The address with a workspace still opens the page, and its path drops the workspace.
    assert.deepEqual(parseRoute(`/atlas${path}`), { name, ws: "atlas" });
    assert.equal(routePath(parseRoute(`/atlas${path}`)), path);
  }
  assert.deepEqual(parseRoute("/settings"), { name: "accountProfile", ws: null });
  assert.deepEqual(parseRoute("/settings/members"), { name: "home", ws: "settings" });
  assert.deepEqual(parseRoute("/settings/security/x"), { name: "home", ws: "settings" });
  assert.deepEqual(parseRoute("/atlas/settings/notifications/sms"), { name: "home", ws: "atlas" });
});

test("routes: a project's cycles and one cycle by number (PLNR-63); a number that is no number matches no route", () => {
  assert.deepEqual(parseRoute("/atlas/projects/plnr/cycles"), { name: "cycles", ws: "atlas", projectKey: "PLNR" });
  assert.deepEqual(parseRoute("/atlas/projects/plnr/cycles/12"), { name: "cycle", ws: "atlas", projectKey: "PLNR", cycle: 12 });
  assert.deepEqual(parseRoute("/atlas/projects/plnr/cycles/0"), { name: "home", ws: "atlas" });
  assert.equal(routePath({ name: "cycle", ws: "atlas", projectKey: "PLNR", cycle: 12 }), "/atlas/projects/PLNR/cycles/12");
  // The project's history is at /history again (RSVA-498); /timeline, its address from 2026-10-30, opens nothing of it.
  assert.deepEqual(parseRoute("/atlas/projects/plnr/history"), { name: "history", ws: "atlas", projectKey: "PLNR" });
  assert.notEqual(parseRoute("/atlas/projects/plnr/timeline").name, "history");
  assert.equal(routePath({ name: "history", ws: "atlas", projectKey: "PLNR" }), "/atlas/projects/PLNR/history");
});

test("routes: all projects and the archived ones; a project named ARCHIVED still opens with a page after its key", () => {
  assert.deepEqual(parseRoute("/atlas/projects"), { name: "projects", ws: "atlas", archived: false });
  assert.deepEqual(parseRoute("/atlas/projects/archived"), { name: "projects", ws: "atlas", archived: true });
  assert.deepEqual(parseRoute("/atlas/projects/archived/issues"), { name: "issues", ws: "atlas", projectKey: "ARCHIVED" });
});

test("routes: a project's key alone opens its home (RSVA-508)", () => {
  assert.deepEqual(parseRoute("/atlas/projects/plnr"), { name: "projectHome", ws: "atlas", projectKey: "PLNR" });
  assert.deepEqual(parseRoute("/atlas/projects/ARCHIVED"), { name: "projectHome", ws: "atlas", projectKey: "ARCHIVED" });
  assert.equal(routePath({ name: "projectHome", ws: "atlas", projectKey: "PLNR" }), "/atlas/projects/PLNR");
});

test("a route's path is built from its parts and never leaves the site", () => {
  for (const path of ["/atlas/projects/INFRA", "/atlas/projects/INFRA/issues", "/atlas/projects/INFRA/archive", "/atlas/projects/INFRA/history", "/atlas/projects", "/atlas/projects/archived", "/atlas/projects/INFRA/issues/INFRA-12", "/atlas/browse/INFRA-12", "/atlas/settings/members", "/atlas/inbox", "/atlas/my-work", "/new", "/join/abc", "/atlas/", "/"])
    assert.equal(routePath(parseRoute(path)), path);
  for (const path of ["//3405803781/x", "//0x7f000001/", "///evil.example/projects/A/issues", "/%2F%2Fevil.example/", "/%5C%5Cevil.example/inbox", "/\\evil.example/", "/%E0"]) {
    const built = routePath(parseRoute(path));
    assert.equal(new URL(built, "https://plan.example").host, "plan.example", `${path} → ${built}`);
  }
});

test("an animated move shows its path when it applies; a second click meanwhile adds no entry; a newer change wins", () => {
  const waiting: (() => void)[] = [];
  router.animate = (_from, _to, apply) => void waiting.push(apply);
  try {
    router.replace("/atlas/projects/INFRA/issues");
    router.push("/atlas/projects/INFRA/issues/INFRA-1");
    router.push("/atlas/projects/INFRA/issues/INFRA-1");
    assert.deepEqual(pushed, ["/atlas/projects/INFRA/issues/INFRA-1"]);
    assert.equal(router.path, "/atlas/projects/INFRA/issues");
    waiting.shift()!();
    assert.equal(router.path, "/atlas/projects/INFRA/issues/INFRA-1");

    router.push("/atlas/projects/INFRA/issues");
    router.replace("/atlas/projects/INFRA/issues/INFRA-2");
    waiting.shift()!();
    assert.equal(router.path, "/atlas/projects/INFRA/issues/INFRA-2");
  } finally {
    router.animate = null;
  }
});

test("routes: the views index and a workspace view (PLNR-74)", () => {
  assert.deepEqual(parseRoute("/atlas/views"), { name: "views", ws: "atlas" });
  const id = "0193a6f0-0000-7000-8000-000000000001";
  assert.deepEqual(parseRoute(`/atlas/views/${id}`), { name: "view", ws: "atlas", viewId: id });
  assert.equal(routePath({ name: "view", ws: "atlas", viewId: id }), `/atlas/views/${id}`);
  assert.deepEqual(parseRoute(`/atlas/views/${id}/more`), { name: "home", ws: "atlas" });
});
