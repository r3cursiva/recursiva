import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DISPLAY, type QueryContext } from "@rsva/query";
import type { SavedView } from "@rsva/protocol";
import { boardable, displayOf, draftState, ProjectView, WS_SCOPE, type ListSource } from "./list-state.ts";

const ctx = { states: new Map(), labels: new Map(), users: new Map(), me: null, issueKey: () => "" } as QueryContext;

/** A workspace whose saved views the test changes and deletes, as the sync store would. */
function workspace(...list: Pick<SavedView, "id" | "query" | "display">[]) {
  const views = new Map(list.map((v) => [v.id, v as SavedView]));
  const source: ListSource = { view: (id) => views.get(id) ?? null, context: () => ctx };
  return { views, all: () => new ProjectView("p1", "p1", null, source), view: (id: string) => new ProjectView(`v:${id}`, WS_SCOPE, id, source) };
}

const urgent = { id: "urgent", query: "priority:urgent", display: { groupBy: "priority", properties: ["key"] } };

test("All issues: Clear drops the filter only, Reset the display only, and the layout survives both", () => {
  const list = workspace().all();
  list.setFilter({ priority: [1] });
  list.setDisplay({ groupBy: "assignee" });
  list.setLayout("board");
  assert.equal(list.edited, true);

  list.revert();
  assert.deepEqual(list.filter, {});
  assert.equal(list.display.groupBy, "assignee");
  assert.equal(list.layout, "board");
  assert.equal(list.edited, true, "a display other than the default is still an edit");

  list.setFilter({ text: "bug" });
  list.resetDisplay();
  assert.deepEqual(list.display, DEFAULT_DISPLAY);
  assert.deepEqual(list.filter, { text: "bug" });
  list.revert();
  assert.equal(list.edited, false);
  assert.equal(list.layout, "board");
});

test("the query line carries the order (PLNR-401): order: sets Display's, its absence the default, a half-typed one keeps it", () => {
  const list = workspace().all();
  assert.deepEqual(list.setQuery("priority:high order:due bug"), []);
  assert.deepEqual(list.filter, { priority: [2], text: "bug" });
  assert.equal(list.display.orderBy, "dueDate");
  assert.equal(list.query, "priority:high order:due bug");
  list.setQuery("priority:high order:pri");
  assert.equal(list.display.orderBy, "dueDate", "still being typed: the order stays");
  list.setQuery("priority:high");
  assert.equal(list.display.orderBy, DEFAULT_DISPLAY.orderBy);
  assert.equal(list.query, "priority:high", "the default order is not written");
  list.setDisplay({ orderBy: "createdAt" });
  assert.equal(list.query, "priority:high order:created", "Display's order shows in the line");
});

test("the query line reads the short forms (RSVA-368): a sign is its key, a quoted one is text, the line shows the long keys", () => {
  const list = workspace().all();
  assert.deepEqual(list.setQuery("!high @me fix"), []);
  assert.deepEqual(list.filter, { priority: [2], assignee: ["me"], text: "fix" });
  assert.equal(list.query, "priority:high assignee:me fix");
  list.setQuery('"!high" fix');
  assert.deepEqual(list.filter, { text: '"!high" fix' });
  list.setFilter({ text: "+1 fix" });
  assert.equal(list.fields.query, '"+1" fix', "saved so that it reads back as text");
});

test("a saved view whose query names an order takes it into its display", () => {
  const list = workspace({ id: "v", query: "label:none sort:priority", display: {} }).view("v");
  list.load(list.saved);
  assert.equal(list.display.orderBy, "priority");
  assert.deepEqual(list.filter, { label: ["none"] });
  assert.equal(list.edited, false, "as saved: not an edit");
  list.setDisplay({ orderBy: "manual" });
  list.resetDisplay();
  assert.equal(list.display.orderBy, "priority", "Reset brings back the query's order");
});

test("All issues: the layout alone is no edit", () => {
  const list = workspace().all();
  list.setLayout("board");
  assert.equal(list.edited, false);
  assert.equal(list.filtered, false);
});

test("a saved view: loaded as saved it is not edited, even if its query text was written otherwise", () => {
  const ws = workspace({ id: "v", query: "PRIORITY:high  bug", display: {} });
  const list = ws.view("v");
  list.load(list.saved);
  assert.deepEqual(list.filter, { priority: [2], text: "bug" });
  assert.equal(list.edited, false);
  assert.equal(list.displayEdited, false);
});

test("a saved view: Revert brings back its filter and display, not the viewer's layout", () => {
  const list = workspace(urgent).view("urgent");
  list.load(list.saved);
  list.setFilter({ text: "crash" });
  list.setDisplay({ groupBy: "label" });
  list.setLayout("board");
  assert.equal(list.edited, true);

  list.revert();
  assert.deepEqual(list.filter, { priority: [1] });
  assert.equal(list.display.groupBy, "priority");
  assert.deepEqual(list.display.properties, ["key"]);
  assert.equal(list.layout, "board");
  assert.equal(list.edited, false);
});

test("a saved view: Reset takes its saved display and keeps the edited filter", () => {
  const list = workspace(urgent).view("urgent");
  list.load(list.saved);
  list.setFilter({ text: "crash" });
  list.setDisplay({ groupBy: "label", showEmptyGroups: false });
  assert.equal(list.displayEdited, true);

  list.resetDisplay();
  assert.deepEqual(list.display, displayOf(urgent.display));
  assert.equal(list.displayEdited, false);
  assert.deepEqual(list.filter, { text: "crash" });
  assert.equal(list.edited, true);
});

test("Save stores the filter as query text and a copy of the display; once saved the list is not edited", () => {
  const ws = workspace(urgent);
  const list = ws.view("urgent");
  list.load(list.saved);
  list.setFilter({ priority: [1, 2], text: "crash" });
  const fields = list.fields;
  assert.equal(fields.query, "priority:urgent,high crash");
  assert.notEqual(fields.display, list.display, "the saved display is no live reference");
  assert.deepEqual(fields.display, list.display);

  ws.views.set("urgent", { ...urgent, ...fields } as SavedView);
  assert.equal(list.edited, false);
});

test("a deleted view: no longer edited, and Revert falls back to every issue by default", () => {
  const ws = workspace(urgent);
  const list = ws.view("urgent");
  list.load(list.saved);
  list.setFilter({ text: "crash" });
  ws.views.delete("urgent");
  assert.equal(list.saved, null);
  assert.equal(list.edited, false);
  list.revert();
  assert.deepEqual(list.filter, {});
  assert.deepEqual(list.display, DEFAULT_DISPLAY);
});

test("a new view's draft copies the list as on screen, with the panel's extra query first", () => {
  const list = workspace().all();
  list.setFilter({ text: "crash" });
  list.setDisplay({ groupBy: "assignee" });
  list.setLayout("board");
  const draft = draftState(list, "priority:high");
  assert.equal(draft.key, "draft:p1");
  assert.equal(draft.scope, WS_SCOPE);
  assert.equal(draft.viewId, null);
  assert.deepEqual(draft.filter, { priority: [2], text: "crash" });
  assert.equal(draft.display.groupBy, "assignee");
  assert.equal(draft.layout, "board");
  // The draft is a copy: the list behind the panel does not change with it.
  draft.setFilter({});
  assert.deepEqual(list.filter, { text: "crash" });
});

test("restore takes what storage kept and leaves out what is not valid", () => {
  const list = workspace().all();
  list.restore({ layout: "board", display: { groupBy: "assignee", orderBy: "nonsense", properties: ["key", "nope"] }, filter: { text: "crash" } });
  assert.equal(list.layout, "board");
  assert.equal(list.display.groupBy, "assignee");
  assert.equal(list.display.orderBy, DEFAULT_DISPLAY.orderBy);
  assert.deepEqual(list.display.properties, ["key"]);
  assert.deepEqual(list.filter, { text: "crash" });

  list.restore({ layout: "table", filter: ["text"] });
  assert.equal(list.layout, "board", "an unknown layout keeps the current one");
  assert.deepEqual(list.filter, { text: "crash" }, "a filter that is no object is ignored");
  assert.deepEqual(list.display, DEFAULT_DISPLAY);

  list.restore("garbage");
  list.restore(null);
  assert.equal(list.layout, "board");
});

test("displayOf: valid fields over the defaults; null sub-grouping is valid", () => {
  assert.deepEqual(displayOf(undefined), DEFAULT_DISPLAY);
  assert.notEqual(displayOf(undefined).properties, DEFAULT_DISPLAY.properties, "the defaults are not shared");
  const d = displayOf({ groupBy: 3, subGroupBy: null, showSubIssues: false, showEmptyGroups: "no", properties: "key" });
  assert.deepEqual(d, { ...DEFAULT_DISPLAY, subGroupBy: null, showSubIssues: false });
  assert.equal(displayOf({ subGroupBy: "label" }).subGroupBy, "label");
});

test("boardable: in a project, or a view whose Project filter names one project", () => {
  const ws = workspace(urgent);
  const view = ws.view("urgent");
  assert.equal(boardable(ws.all(), { id: "p1" }), true);
  assert.equal(boardable(view, null), false);
  view.setFilter({ project: ["p1"] });
  assert.equal(boardable(view, null), true);
  view.setFilter({ project: ["p1", "p2"] });
  assert.equal(boardable(view, null), false);
});
