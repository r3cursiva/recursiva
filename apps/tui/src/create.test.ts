// A new issue from one line (PLNR-438): the draft the line makes, and the card that shows it before Enter.
import assert from "node:assert/strict";
import { test } from "node:test";
import { issue, L, S, U } from "../../../packages/query/test/fixture.ts";
import { draftCard, draftOf, type Creating, type CreateSource } from "./create.ts";

const P = "00000000-0000-4000-8000-000000000001";

/** Another project's label of the same name, first in the map: a line of PLNR must not find it. */
const OTHER_BUG = { ...L.bug, id: "00000000-0000-4000-8000-000000000999", projectId: "00000000-0000-4000-8000-000000000002" };

function source(issues: ReturnType<typeof issue>[]): CreateSource {
  const states = Object.values(S);
  return {
    me: U.alex,
    issues: new Map(issues.map((i) => [i.id, i])),
    states: new Map(states.map((s) => [s.id, s])),
    labels: new Map([OTHER_BUG, ...Object.values(L)].map((l) => [l.id, l])),
    users: new Map(Object.values(U).map((u) => [u.id, u])),
    cycles: new Map(),
    projects: new Map([[P, { id: P, key: "PLNR", name: "Planner" } as never]]),
    issueKey: (i: { number: number }) => `PLNR-${i.number}`,
    issueByKey: (key: string) => issues.find((i) => `PLNR-${i.number}` === key),
    isBlocked: () => false,
    isBlocking: () => false,
    hasLink: () => false,
    statesOf: () => states,
    githubOf: () => [],
    relationsOf: () => ({ blockedBy: [], blocks: [], related: [], duplicateOf: null, duplicates: [] }),
    attachmentsOf: () => [],
    description: () => undefined,
  } as unknown as CreateSource;
}

const line = (text: string, over: Partial<Creating> = {}): Creating => ({ text, projectId: P, parentId: null, description: "", completion: 0, ...over });

test("the line's fields and title go on the draft; without a state it gets the project's default, without #KEY the issue's project", () => {
  const s = source([]);
  assert.deepEqual(draftOf(s, line("Fix the sign-in page !high +bug @zoe")), {
    projectId: P,
    set: { priority: 2, labelIds: [L.bug.id], assigneeIds: [U.zoe.id], stateId: S.backlog.id },
    title: "Fix the sign-in page",
    error: null,
  });
  assert.equal(draftOf(s, line("Ready state:Todo")).set.stateId, S.todo.id, "the person sets a state only people set");
  assert.deepEqual(draftOf(s, line("Fix +bug")).set.labelIds, [L.bug.id], "the project's own label, not another's of the same name");
  assert.deepEqual(draftOf(s, line("Anything", { projectId: null })).error, "Which project? Name it with #, as #plnr.");
});

test("a sub-issue is under its parent; a typo is the draft's error and keeps the rest", () => {
  const parent = issue(12, { title: "Parent" });
  const s = source([parent]);
  assert.equal(draftOf(s, line("Child", { parentId: parent.id })).set.parentId, parent.id);
  assert.equal(draftOf(s, line("Child parent:PLNR-12")).set.parentId, parent.id, "parent: in the line finds it in the copy");
  const typo = draftOf(s, line("Fix it !urgnt"));
  assert.match(typo.error!, /Did you mean !urgent\?/);
  assert.equal(typo.title, "Fix it");
});

test("the card is the issue as it will be created, with open issues that look like it and the description from the editor", () => {
  const twin = issue(7, { title: "Fix the sign-in page", stateId: S.todo.id });
  const s = source([twin]);
  const c = line("Fix the sign in page !high", { description: "Steps first." });
  const shown = draftCard(s, c, draftOf(s, c), Date.parse("2026-11-07T10:00:00Z"))!;
  assert.equal(shown.card.key, "New PLNR issue");
  assert.equal(shown.card.title, "Fix the sign in page");
  assert.equal(shown.card.state.name, "Backlog");
  assert.equal(shown.card.priority, 2);
  assert.equal(shown.card.description, "Steps first.\n\nOpen issues that look like it:\n\n- PLNR-7 Fix the sign-in page");
  // Before a title: how to write the line.
  const empty = line("");
  assert.match(draftCard(s, empty, draftOf(s, empty), 0)!.card.description, /^Type a title\. #project @person/);
});
