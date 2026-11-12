import assert from "node:assert/strict";
import { test } from "node:test";
import type { Cycle, Issue, Project, WorkflowState } from "@rsva/schema/models";
import type { WorkItem } from "./my-work.ts";
import {
  blankPulse,
  entryId,
  foldProposals,
  isBundle,
  parkedTotal,
  pulses,
  sortPulses,
  type PulseSource,
} from "./my-work-projects.ts";

const NOW = Date.parse("2026-11-09T09:00:00Z");
const TODAY = "2026-11-09";
let n = 0;
const issue = (over: Partial<Issue> = {}): Issue =>
  ({
    id: `i${++n}`,
    projectId: "a",
    stateId: "todo",
    priority: 0,
    dueDate: null,
    labelIds: [],
    cycleId: null,
    updatedAt: "2026-11-01T00:00:00Z",
    archivedAt: null,
    deletedAt: null,
    ...over,
  }) as Issue;
/** A row of My work, a proposal unless `ask` says otherwise (null: none). */
const item = (
  over: Omit<Partial<WorkItem>, "issue" | "ask"> & {
    issue?: Partial<Issue>;
    ask?: WorkItem["ask"] | null;
  } = {},
): WorkItem => {
  const { issue: i, ask = "proposed", ...rest } = over;
  return {
    ws: "w",
    group: "wait",
    from: null,
    since: "2026-11-01T00:00:00Z",
    ...(ask ? { ask } : {}),
    ...rest,
    issue: issue(i),
  };
};

test("proposals fold per project, the biggest pile first, after the rows that stay rows", () => {
  const review = item({ ask: "review" });
  const urgent = item({ issue: { projectId: "a", priority: 1 } });
  const a = [
    item({ issue: { projectId: "a" } }),
    item({ issue: { projectId: "a" }, since: "2026-10-20T00:00:00Z" }),
  ];
  const b = [
    item({ issue: { projectId: "b" } }),
    item({ issue: { projectId: "b" } }),
    item({ issue: { projectId: "b" } }),
  ];
  const lone = item({ issue: { projectId: "c" } });
  const out = foldProposals([review, urgent, ...a, ...b, lone], new Set());
  assert.deepEqual(
    out.map((e) => (isBundle(e) ? `${e.id}:${e.items.length}` : e)),
    [review, urgent, lone, "b:w/b:3", "b:w/a:2"],
  );
  const bundle = out.find((e) => isBundle(e) && e.projectId === "a");
  assert.ok(bundle && isBundle(bundle));
  assert.equal(bundle.oldest, "2026-10-20T00:00:00Z");
});

test("an open pile is followed by its proposals; the same project in two workspaces is two piles", () => {
  const a = [
    item({ issue: { projectId: "a" } }),
    item({ issue: { projectId: "a" } }),
  ];
  const other = [
    item({ ws: "v", issue: { projectId: "a" } }),
    item({ ws: "v", issue: { projectId: "a" } }),
  ];
  const out = foldProposals([...a, ...other], new Set(["b:w/a"]));
  assert.deepEqual(out.map(entryId), [
    "b:w/a",
    `w/${a[0]!.issue.id}`,
    `w/${a[1]!.issue.id}`,
    "b:v/a",
  ]);
});

const st = (id: string, group: WorkflowState["group"]) =>
  ({ id, group, projectId: "a", position: 0 }) as WorkflowState;
const STATES = [
  st("backlog", "backlog"),
  st("todo", "unstarted"),
  st("doing", "started"),
  st("review", "started"),
  st("done", "completed"),
];
const project = (id: string) =>
  ({ id, key: id.toUpperCase(), name: id }) as Project;

function source(issues: Issue[], cycles: Cycle[] = []): PulseSource {
  return {
    projectList: () => [project("a"), project("b"), project("c")],
    issues: new Map(issues.map((i) => [i.id, i])),
    states: new Map(STATES.map((s) => [s.id, s])),
    labels: [{ id: "prop", name: "proposed" }],
    statesOf: () => STATES,
    cyclesOf: (p) => cycles.filter((c) => c.projectId === p),
    issuesInCycle: (id) => issues.filter((i) => i.cycleId === id),
  };
}

test("a project's row counts the viewer's work, its own late and open issues, the running cycle and the last change", () => {
  const cycle = {
    id: "c1",
    projectId: "a",
    startDate: "2026-11-02",
    endDate: "2026-11-15",
    completedAt: null,
  } as Cycle;
  const issues = [
    issue({
      dueDate: "2026-11-01",
      cycleId: "c1",
      updatedAt: "2026-11-08T00:00:00Z",
    }),
    issue({ stateId: "done", dueDate: "2026-11-01", cycleId: "c1" }),
    issue({
      deletedAt: "2026-11-09T00:00:00Z",
      updatedAt: "2026-11-09T05:00:00Z",
    }),
    issue({ projectId: "b" }),
  ];
  const items = [
    item({ ask: "review" }),
    item({ ask: "proposed" }),
    item({ group: "doing", ask: null }),
    item({ group: "agents", ask: null, since: "2026-11-01T00:00:00Z" }),
    item({ group: "agents", ask: null, since: "2026-11-09T08:00:00Z" }),
  ];
  const [a, b, c] = pulses("w", source(issues, [cycle]), items, TODAY, NOW);
  assert.deepEqual(
    {
      ...a,
      project: a!.project.id,
      cycle: a!.cycle && {
        id: a!.cycle.cycle.id,
        total: a!.cycle.counts.total,
        done: a!.cycle.counts.completed,
      },
    },
    {
      ws: "w",
      project: "a",
      wait: 1,
      triage: 1,
      doing: 1,
      agents: 2,
      idle: 1,
      overdue: 1,
      review: 0,
      parked: { proposed: 0, still: 0, todo: 1, backlog: 0 },
      open: 1,
      cycle: { id: "c1", total: 2, done: 1 },
      changed: "2026-11-08T00:00:00Z",
      quiet: false,
    },
  );
  assert.equal(b!.open, 1);
  assert.equal(b!.quiet, false, "no rule given: nothing is quiet");
  const quiet = pulses("w", source(issues, [cycle]), items, TODAY, NOW, (p) => p.project.id === "b");
  assert.deepEqual(quiet.map((p) => p.quiet), [false, true, false], "the rule given decides");
  assert.equal(c!.changed, null);
});

test("the projects' order puts what waits on the viewer first, quiet projects last, the latest change first among equals", () => {
  const base = (id: string) => blankPulse("w", project(id));
  const quietNew = { ...base("q1"), changed: "2026-11-08", quiet: true };
  const quietOld = { ...base("q2"), changed: "2026-10-01", quiet: true };
  const triage = { ...base("t"), triage: 50 };
  const late = { ...base("l"), overdue: 2 };
  const waits = { ...base("w"), wait: 1 };
  assert.deepEqual(
    sortPulses([quietOld, triage, quietNew, late, waits]).map(
      (p) => p.project.id,
    ),
    ["w", "l", "t", "q1", "q2"],
  );
});

test("open issues nobody works on are parked, each once; a review that does not wait on the viewer is in review", () => {
  const mine = issue({ stateId: "review" });
  const issues = [
    issue({ stateId: "backlog", labelIds: ["prop"] }),
    issue({ stateId: "backlog" }),
    issue({ stateId: "backlog", updatedAt: "2026-09-01T00:00:00Z" }),
    issue({ stateId: "todo", updatedAt: "2026-11-08T00:00:00Z" }),
    // Fourteen days to the hour: still.
    issue({ stateId: "todo", updatedAt: "2026-10-26T09:00:00Z" }),
    issue({ stateId: "doing" }),
    issue({ stateId: "review" }),
    mine,
    issue({ stateId: "done" }),
  ];
  const waiting: WorkItem = { ...item({ ask: "review" }), issue: mine };
  const [a] = pulses("w", source(issues), [waiting], TODAY, NOW);
  assert.deepEqual(a!.parked, { proposed: 1, still: 1, todo: 1, backlog: 2 });
  assert.equal(parkedTotal(a!.parked), 5);
  assert.equal(a!.review, 1);
  assert.equal(a!.wait, 1);
  assert.equal(a!.open, 8);
});
