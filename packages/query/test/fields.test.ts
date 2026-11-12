// A new issue's fields from one line (PLNR-359, PLNR-438): what Telegram's /new and the TUI's `c` both read.
import assert from "node:assert/strict";
import { test } from "node:test";
import { errorSentence, issueFields, parseQuery } from "../src/index.ts";
import { ctx, L, projectMap, S, U } from "./fixture.ts";

const P = "00000000-0000-4000-8000-000000000001";
const c = ctx({ projects: projectMap([{ id: P, key: "PLNR", name: "Planner" }]) });
const read = (text: string, guard = {}) => {
  const { filter, errors } = parseQuery(text, c);
  return errors.length ? { error: errorSentence(text, errors[0]!) } : issueFields(filter, c, P, guard);
};

test("the short forms and the long keys set fields; the free text is the title", () => {
  assert.deepEqual(read('#plnr Fix the "sign-in" page @me @zoe !high +bug state:"In Progress" due:2026-11-20'), {
    set: { stateId: S.progress.id, priority: 2, assigneeIds: [U.alex.id, U.zoe.id], labelIds: [L.bug.id], dueDate: "2026-11-20" },
    title: "Fix the sign-in page",
  });
  assert.deepEqual(read("Nothing named"), { set: {}, title: "Nothing named" });
  assert.deepEqual(read("Unassigned @none"), { set: { assigneeIds: [] }, title: "Unassigned" });
  assert.deepEqual(read("Someday due:none start:none"), { set: { dueDate: null, startDate: null }, title: "Someday" });
});

test("what sets no field, two values for one, a range for a day and a typo are errors that name the token", () => {
  assert.deepEqual(read("Typo group:started"), { error: '"group:" narrows a list; it sets no field.' });
  assert.deepEqual(read("Typo !high !low"), { error: "One priority only." });
  assert.deepEqual(read("Typo due:this-week"), { error: '"due:" takes one day: today, tomorrow or 2026-11-20.' });
  assert.match((read("Typo !urgnt") as { error: string }).error, /Did you mean !urgent\?/);
  assert.match((read("Typo priority:urgnt") as { error: string }).error, /Did you mean priority:urgent\?/);
});

test("a guard refuses what its caller does not set: Telegram's states and labels only people set", () => {
  const guard = { state: (s: { onlyPeople: boolean; name: string }) => (s.onlyPeople ? `${s.name} is not for bots.` : null) };
  assert.deepEqual(read("Ready state:Todo", guard), { error: "Todo is not for bots." });
  // Without one, the line sets it: the TUI goes as the person.
  assert.deepEqual(read("Ready state:Todo"), { set: { stateId: S.todo.id }, title: "Ready" });
});
