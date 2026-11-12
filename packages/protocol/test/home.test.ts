import assert from "node:assert/strict";
import { test } from "node:test";
import { HOME_PRESETS, HOME_TEMPLATES, HOME_WIDGETS_MAX, homeWidgets, isDefaultHome, newWidget, pickHome, presetWidget, templateWidgets, widgetTitle } from "../src/home.ts";

test("a stored home is read back into widgets: unknown kinds and values dropped, the rest filled in", () => {
  const got = homeWidgets({
    widgets: [
      { id: "a", kind: "list", query: "group:started", width: 8, rows: 10 },
      { id: "b", kind: "brief" },
      { id: "a", kind: "count", width: 5, rows: 7, by: "label", title: 42 },
      "nonsense",
      null,
    ],
  });
  assert.deepEqual(got, [
    { id: "a", kind: "list", title: "", query: "group:started", width: 8, rows: 10, by: "state" },
    { id: "a_", kind: "count", title: "", query: "", width: 3, rows: 5, by: "state" },
  ]);
  assert.deepEqual(homeWidgets(undefined), []);
  assert.deepEqual(homeWidgets({ widgets: "x" }), []);
});

test("a home holds at most HOME_WIDGETS_MAX widgets", () => {
  const many = Array.from({ length: HOME_WIDGETS_MAX + 5 }, (_, i) => newWidget(`w${i}`, "count"));
  assert.equal(homeWidgets({ widgets: many }).length, HOME_WIDGETS_MAX);
});

test("templates: widgets with unique ids and a title for each", () => {
  for (const t of HOME_TEMPLATES) {
    const ws = templateWidgets(t);
    assert.ok(ws.length > 0);
    assert.equal(new Set(ws.map((w) => w.id)).size, ws.length);
    assert.deepEqual(homeWidgets({ widgets: ws }), ws, "a template survives the round trip");
    for (const w of ws) assert.ok(widgetTitle(w));
  }
  assert.equal(widgetTitle(newWidget("c", "chart", { by: "priority" })), "By priority");
  assert.equal(widgetTitle(newWidget("c", "chart")), "By status");
});

test("ready queries: distinct, each a titled widget of its kind that survives the round trip (RSVA-523)", () => {
  assert.equal(new Set(HOME_PRESETS.map((p) => p.id)).size, HOME_PRESETS.length);
  assert.equal(new Set(HOME_PRESETS.map((p) => p.query)).size, HOME_PRESETS.length);
  for (const p of HOME_PRESETS) {
    const w = presetWidget("x", p);
    assert.deepEqual([w.kind, w.title, w.query], [p.kind, p.name, p.query]);
    assert.deepEqual(homeWidgets({ widgets: [w] }), [w]);
  }
});

test("the default home (RSVA-577): a home with no project in its query; a project shows its own before the default, and a private home is not read", () => {
  const home = (id: string, query: string, shared = true) => ({ id, layout: "home", query, shared });
  assert.ok(isDefaultHome(home("d", " ")));
  assert.ok(!isDefaultHome(home("p", "project:RSVA")));
  assert.ok(!isDefaultHome({ ...home("v", ""), layout: "list" }));
  const here = home("here", "project:RSVA");
  const all = home("all", "");
  const seen = (project: (typeof here)[], defaults: (typeof here)[]) => {
    const got = pickHome({ project, all: defaults });
    return got && [got.view.id, got.scope];
  };
  assert.deepEqual(seen([here], [all]), ["here", "project"]);
  assert.deepEqual(seen([home("mine", "project:RSVA", false)], [all]), ["all", "all"]);
  assert.equal(seen([], [home("mine", "", false)]), undefined);
});
