import assert from "node:assert/strict";
import { test } from "node:test";
import { feedHolds, feedReaches, foldEdits, joinActs, layOut, type Edit, type FeedItem } from "@rsva/display/activity-rows";

const NOW = Date.parse("2026-11-01T18:00:00");
const at = (t: string) => new Date(`2026-11-${t}`).toISOString();
const move = (t: string, by = "a"): FeedItem => ({ at: at(t), by, move: {} });
const note = (t: string, by = "a"): FeedItem => ({ at: at(t), by });
const shape = (rows: ReturnType<typeof layOut>) => rows.map((r) => (r.kind === "day" ? r.label : r.kind === "new" ? `new ${r.count}` : r.kind === "fold" ? `fold ${r.items.length}` : "item"));

test("a notification's comment: found in a thread or a reply, given up once the pages reach its time", () => {
  const thread = (id: string, createdAt: string, replies: string[] = []) => ({ comment: { id, createdAt }, replies: replies.map((id) => ({ id })) });
  const feed = { threads: [thread("c2", at("02T10:00:00"), ["r1"]), thread("c1", at("01T10:00:00"))], history: [{ at: at("01T12:00:00") }] };
  assert.equal(feedHolds(feed, "c1"), true);
  assert.equal(feedHolds(feed, "r1"), true);
  assert.equal(feedHolds(feed, "gone"), false);
  assert.equal(feedReaches(feed, at("01T11:00:00")), true, "the oldest thread is earlier");
  assert.equal(feedReaches(feed, at("01T09:00:00")), false, "older than anything loaded: keep paging");
  assert.equal(feedReaches({ threads: [], history: [] }, at("01T09:00:00")), false);
});

test("a day mark before the first item of each day", () => {
  assert.deepEqual(shape(layOut([note("01T09:00:00"), note("01T10:00:00")], NOW, null, "me")), ["Today", "item", "item"]);
  assert.deepEqual(shape(layOut([note("01T09:00:00")].slice(0, 0), NOW, null, "me")), []);
  assert.deepEqual(shape(layOut([{ ...note("01T09:00:00"), at: new Date(NOW - 86_400_000).toISOString() }, note("01T09:00:00")], NOW, null, "me")), ["Yesterday", "item", "Today", "item"]);
});

test("the new mark counts what others did since the visit, and stands before the first of it", () => {
  const items = [note("01T09:00:00"), note("01T10:00:00", "me"), note("01T11:00:00")];
  assert.deepEqual(shape(layOut(items, NOW, at("01T09:30:00"), "me")), ["Today", "item", "new 1", "item", "item"]);
  assert.deepEqual(shape(layOut(items.slice(0, 2), NOW, at("01T09:30:00"), "me")), ["Today", "item", "item"], "only the viewer's own: no mark");
});

test("state changes fold from three in a run, by one person, minutes apart", () => {
  const run = [move("01T16:58:00"), move("01T16:59:00"), move("01T17:02:00")];
  assert.deepEqual(shape(layOut(run, NOW, null, "me")), ["Today", "fold 3"]);
  assert.deepEqual(shape(layOut(run.slice(0, 2), NOW, null, "me")), ["Today", "item", "item"]);
  assert.deepEqual(shape(layOut([move("01T10:00:00"), move("01T10:05:00", "b"), move("01T10:06:00")], NOW, null, "me")), ["Today", "item", "item", "item"], "two people");
  assert.deepEqual(shape(layOut([move("01T09:00:00"), move("01T11:00:00"), move("01T13:00:00")], NOW, null, "me")), ["Today", "item", "item", "item"], "hours apart is real progress");
  assert.deepEqual(shape(layOut([move("01T10:00:00"), move("01T10:01:00"), note("01T10:02:00"), move("01T10:03:00")], NOW, null, "me")), ["Today", "item", "item", "item", "item"], "a comment breaks the run");
});

test("one act: neighbours within a minute by one person", () => {
  type T = FeedItem & { n: string[]; plain: boolean };
  const it = (t: string, n: string, by = "a", plain = true): T => ({ at: at(t), by, n: [n], plain });
  const join = (xs: T[]) => joinActs(xs, (x) => x.plain, (run) => ({ ...run[0]!, n: run.flatMap((r) => r.n) })).map((x) => x.n.join("+"));
  assert.deepEqual(join([it("01T10:00:00", "p"), it("01T10:00:00", "c"), it("01T10:00:30", "d")]), ["p+c+d"]);
  assert.deepEqual(join([it("01T10:00:00", "p"), it("01T10:02:00", "c")]), ["p", "c"], "two acts");
  assert.deepEqual(join([it("01T10:00:00", "p"), it("01T10:00:10", "c", "b")]), ["p", "c"], "two people");
  assert.deepEqual(join([it("01T10:00:00", "p"), it("01T10:00:10", "s", "a", false), it("01T10:00:20", "c")]), ["p", "s", "c"], "a state change stands alone");
});

type Change = FeedItem & { edit?: Edit };
const edit = (t: string, from: unknown, to: unknown, field = "priority", by = "a"): Change => ({ at: at(t), by, edit: { field, from, to } });
const clock = (t: string) => new Date(`2026-11-${t}`).toISOString().slice(11, 19);
const fold = (items: Change[]) =>
  foldEdits(items, (first, e) => ({ ...first, edit: e })).map((x) => (x.edit ? `${x.edit.field} ${String(x.edit.from)}>${String(x.edit.to)} ${x.at.slice(11, 19)}` : "note"));

test("a run of one field reads from its first value to its last, at the time of the last change", () => {
  assert.deepEqual(fold([edit("01T10:00:00", 1, 2), edit("01T10:00:20", 2, 3), edit("01T10:00:40", 3, 4)]), [`priority 1>4 ${clock("01T10:00:40")}`]);
  assert.deepEqual(fold([edit("01T10:00:00", 1, 2)]), [`priority 1>2 ${clock("01T10:00:00")}`], "one change stands as it is");
});

test("a run that ends where it started shows nothing", () => {
  assert.deepEqual(fold([edit("01T10:00:00", 1, 2), edit("01T10:00:20", 2, 1)]), []);
  assert.deepEqual(fold([edit("01T10:00:00", null, "2026-11-03", "dueDate"), edit("01T10:00:20", "2026-11-03", undefined, "dueDate")]), [], "no value is no value");
  assert.deepEqual(fold([edit("01T10:00:00", 1, 2), edit("01T10:00:20", 2, 1), edit("01T10:00:40", 1, 3)]), [`priority 1>3 ${clock("01T10:00:40")}`], "it went on");
});

test("the minute is measured between neighbours, so a slow run stays whole", () => {
  assert.deepEqual(fold([edit("01T10:00:00", 1, 2), edit("01T10:00:50", 2, 3), edit("01T10:01:40", 3, 4)]), [`priority 1>4 ${clock("01T10:01:40")}`]);
  assert.equal(fold([edit("01T10:00:00", 1, 2), edit("01T10:01:00", 2, 3)]).length, 2, "a full minute is a second decision");
});

test("another field, another person or anything else between them ends the run", () => {
  assert.equal(fold([edit("01T10:00:00", 1, 2), edit("01T10:00:10", "a", "b", "title"), edit("01T10:00:20", 2, 3)]).length, 3);
  assert.equal(fold([edit("01T10:00:00", 1, 2), edit("01T10:00:10", 2, 3, "priority", "b")]).length, 2);
  assert.equal(fold([edit("01T10:00:00", 1, 2), note("01T10:00:10"), edit("01T10:00:20", 2, 1)]).length, 3);
  assert.deepEqual(fold([note("01T10:00:00"), note("01T10:00:10")]), ["note", "note"]);
});
