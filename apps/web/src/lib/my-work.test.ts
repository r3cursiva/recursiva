import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue, Label, User, WorkflowState } from "@rsva/schema/models";
import type { InboxRow } from "@rsva/sync";
import { actionsFor, applyAction, before, canTriage, collect, dueText, forTriage, inScope, reviewAsk, sortGroup, waitsOnReview, type WorkSource } from "./my-work.ts";

const NOW = Date.parse("2026-10-29T09:00:00Z");
const ME = "me";
const AGENT = "agent";
const IRINA = "irina";
const P = "p1";
const st = (id: string, group: WorkflowState["group"], position: number): WorkflowState =>
  ({ id, projectId: P, name: id, group, color: "#999", position, isDefault: false }) as WorkflowState;
const STATES = [st("Backlog", "backlog", 0), st("Todo", "unstarted", 1), st("Progress", "started", 2), st("Review", "started", 3), st("Approved", "started", 4), st("Done", "completed", 5), st("Canceled", "cancelled", 6)];
const PROPOSED: Label = { id: "l-proposed", projectId: null, parentId: null, name: "proposed", color: "#000", position: 0 } as Label;

let n = 0;
function issue(over: Partial<Issue>): Issue {
  n++;
  return {
    id: `i${n}`, projectId: P, number: n, title: `Issue ${n}`, stateId: "Todo", priority: 0, assigneeIds: [], delegateId: null, labelIds: [],
    parentId: null, blockedByIds: [], relatedIds: [], duplicateOfId: null, startDate: null, dueDate: null, sortOrder: `a${n}`, createdById: IRINA, createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-28T09:00:00Z", completedAt: null, archivedAt: null, deletedAt: null, ...over,
  } as Issue;
}

function source(issues: Issue[], o: { role?: User["role"]; inbox?: InboxRow[] } = {}): WorkSource {
  const users = new Map<string, User>([
    [ME, { id: ME, name: "Robin", kind: "human" } as User],
    [AGENT, { id: AGENT, name: "site-dev", kind: "agent" } as User],
  ]);
  return {
    me: users.get(ME)!,
    role: o.role ?? "owner",
    issues: new Map(issues.map((i) => [i.id, i])),
    states: new Map(STATES.map((s) => [s.id, s])),
    statesOf: () => STATES,
    projects: new Map(),
    labels: new Map([[PROPOSED.id, PROPOSED]]),
    users,
    issueKey: (i: Issue) => `PLNR-${i.number}`,
    subIssuesOf: () => [],
    inbox: { rows: o.inbox ?? [] },
  } as unknown as WorkSource;
}

const ALL = { others: true };
const groups = (s: WorkSource, others = true) => Object.fromEntries(collect("atlas", s, NOW, { others }).map((x) => [x.issue.title, x.ask ? `${x.group}:${x.ask}` : x.group]));

test("each issue lands in the first group that fits, or in none", () => {
  const list = [
    issue({ title: "my review", stateId: "Review", createdById: ME, delegateId: AGENT, assigneeIds: [ME] }),
    issue({ title: "proposal", stateId: "Backlog", labelIds: [PROPOSED.id], createdById: AGENT }),
    issue({ title: "reply", stateId: "Progress", assigneeIds: [IRINA] }),
    issue({ title: "doing", stateId: "Progress", assigneeIds: [ME] }),
    issue({ title: "approved, mine to ship", stateId: "Approved", assigneeIds: [ME] }),
    issue({ title: "delegated", stateId: "Progress", assigneeIds: [ME], delegateId: AGENT }),
    issue({ title: "delegated by me", stateId: "Todo", createdById: ME, delegateId: AGENT }),
    issue({ title: "next", stateId: "Todo", assigneeIds: [ME] }),
    issue({ title: "done this week", stateId: "Done", assigneeIds: [ME], completedAt: "2026-10-27T10:00:00Z" }),
    issue({ title: "done long ago", stateId: "Done", assigneeIds: [ME], completedAt: "2026-10-01T10:00:00Z" }),
    issue({ title: "canceled", stateId: "Canceled", assigneeIds: [ME] }),
    issue({ title: "backlog, mine", stateId: "Backlog", assigneeIds: [ME] }),
    issue({ title: "someone's review", stateId: "Review", createdById: IRINA, assigneeIds: [ME] }),
    issue({ title: "archived", stateId: "Todo", assigneeIds: [ME], archivedAt: "2026-10-28T00:00:00Z" }),
    issue({ title: "not mine", stateId: "Progress", assigneeIds: [IRINA] }),
  ];
  const reply = list[2]!;
  const at = "2026-10-29T04:00:00Z";
  const row = { issue: reply, events: [], latest: { id: 1, issueId: reply.id, kind: "reply", by: IRINA, at, commentId: "c1" }, kinds: new Set(["reply"]), unread: true, snoozedUntil: null } as unknown as InboxRow;
  assert.deepEqual(groups(source(list, { inbox: [row] })), {
    "my review": "wait:review",
    proposal: "wait:proposed",
    reply: "wait:reply",
    doing: "doing",
    "approved, mine to ship": "doing",
    delegated: "agents",
    "delegated by me": "agents",
    next: "next",
    "done this week": "done",
    "backlog, mine": "later",
    "someone's review": "doing",
  });
  const r = collect("atlas", source(list, { inbox: [row] }), NOW, ALL).find((x) => x.ask === "reply")!;
  assert.equal(r.from, IRINA);
  assert.equal(r.replyTo, "c1");
  assert.equal(r.since, at);
});

test("every open issue assigned to the viewer is in My work exactly once, whatever its state, flags and inbox (RSVA-612)", () => {
  const open = STATES.filter((s) => s.group !== "completed" && s.group !== "cancelled");
  const variants: Partial<Issue>[] = [];
  for (const s of open)
    for (const delegateId of [null, AGENT])
      for (const createdById of [IRINA, ME, AGENT])
        for (const labelIds of [[], [PROPOSED.id]]) variants.push({ stateId: s.id, delegateId, createdById, labelIds, assigneeIds: [ME] });
  const list = variants.map((v) => issue(v));
  const ask = (i: Issue, kind: string) => ({ issue: i, events: [], latest: { id: 1, issueId: i.id, kind, by: IRINA, at: "2026-10-29T04:00:00Z" }, kinds: new Set([kind]), unread: true, snoozedUntil: null }) as unknown as InboxRow;
  for (const role of ["owner", "member"] as const)
    for (const kind of [null, "assigned", "mention", "reply", "comment"]) {
      const items = collect("atlas", source(list, { role, inbox: kind ? list.map((i) => ask(i, kind)) : [] }), NOW);
      const seen = new Map<string, number>();
      for (const x of items) seen.set(x.issue.id, (seen.get(x.issue.id) ?? 0) + 1);
      for (const i of list) assert.equal(seen.get(i.id), 1, `${role} ${kind} ${i.stateId} delegate=${i.delegateId} by=${i.createdById} labels=${i.labelIds}`);
    }
});

test("an unread assignment is new in its own group, from who assigned it, first; read or snoozed it is not (RSVA-612)", () => {
  const backlog = issue({ title: "backlog", stateId: "Backlog", assigneeIds: [ME], priority: 4 });
  const todo = issue({ title: "todo", stateId: "Todo", assigneeIds: [ME], priority: 4 });
  const urgent = issue({ title: "urgent", stateId: "Todo", assigneeIds: [ME], priority: 1 });
  const at = "2026-10-29T06:00:00Z";
  const row = (i: Issue, o: Partial<InboxRow> = {}) => ({ issue: i, events: [], latest: { id: 3, issueId: i.id, kind: "assigned", by: IRINA, at }, kinds: new Set(["assigned"]), unread: true, snoozedUntil: null, ...o }) as unknown as InboxRow;
  const items = collect("atlas", source([backlog, todo, urgent], { inbox: [row(backlog), row(todo)] }), NOW);
  const by = (t: string) => items.find((x) => x.issue.title === t)!;
  assert.deepEqual([by("backlog").group, by("backlog").ask, by("backlog").fresh, by("backlog").from, by("backlog").since], ["wait", "decide", true, IRINA, at]);
  assert.deepEqual([by("todo").group, by("todo").fresh], ["next", true]);
  assert.equal(by("urgent").fresh, undefined);
  assert.deepEqual(sortGroup("next", items.filter((x) => x.group === "next"), NOW).map((x) => x.issue.title), ["todo", "urgent"]);
  for (const o of [{ unread: false }, { snoozedUntil: "2026-10-30T09:00:00Z" }])
    assert.equal(collect("atlas", source([todo], { inbox: [row(todo, o)] }), NOW)[0]!.fresh, undefined);
  assert.deepEqual(actionsFor(by("backlog"), STATES, ME, new Set()).map((a) => [a.key, a.patch]), [["S", { stateId: "Progress" }], ["T", { stateId: "Todo" }], ["L", undefined], ["U", { assigneeIds: [] }]]);
  // Read (kept for later): it is in Later, as before.
  assert.equal(collect("atlas", source([backlog], { inbox: [row(backlog, { unread: false })] }), NOW)[0]!.group, "later");
});

test("proposals and agents' reviews wait on owners and admins only; a read or snoozed reply waits on nobody", () => {
  const p = issue({ title: "proposal", stateId: "Backlog", labelIds: [PROPOSED.id] });
  const review = issue({ title: "agent's review", stateId: "Review", createdById: AGENT });
  assert.deepEqual(groups(source([p, review])), { proposal: "wait:proposed", "agent's review": "wait:review" });
  assert.deepEqual(groups(source([p, review], { role: "member" })), {});
  const r = issue({ title: "reply" });
  const row = (o: Partial<InboxRow>) => ({ issue: r, events: [], latest: { kind: "reply", by: IRINA, at: "2026-10-29T04:00:00Z" }, kinds: new Set(), unread: true, snoozedUntil: null, ...o }) as unknown as InboxRow;
  assert.deepEqual(groups(source([r], { inbox: [row({ unread: false })] })), {});
  assert.deepEqual(groups(source([r], { inbox: [row({ snoozedUntil: "2026-10-30T09:00:00Z" })] })), {});
});

test("an unread mention waits on the viewer and is answered like a reply; one in a description has no thread", () => {
  const m = issue({ title: "mention", stateId: "Progress", assigneeIds: [IRINA] });
  const row = { issue: m, events: [], latest: { id: 2, issueId: m.id, kind: "mention", by: IRINA, at: "2026-10-29T05:00:00Z" }, kinds: new Set(["mention"]), unread: true, snoozedUntil: null } as unknown as InboxRow;
  const [x] = collect("atlas", source([m], { inbox: [row] }), NOW, ALL);
  assert.equal(`${x!.group}:${x!.ask}`, "wait:mention");
  assert.deepEqual(collect("atlas", source([m], { inbox: [row] }), NOW), []);
  assert.equal(x!.replyTo, undefined);
  assert.deepEqual(actionsFor(x!, [], ME, new Set()).map((a) => a.id), ["reply"]);
});

test("groups sort by their own rule", () => {
  const items = (list: Issue[]) => collect("atlas", source(list), NOW);
  const titles = (g: Parameters<typeof sortGroup>[0], list: Issue[]) => sortGroup(g, items(list).filter((x) => x.group === g), NOW).map((x) => x.issue.title);
  assert.deepEqual(
    titles("doing", [
      issue({ title: "no due", stateId: "Progress", assigneeIds: [ME], priority: 1 }),
      issue({ title: "due later", stateId: "Progress", assigneeIds: [ME], dueDate: "2026-11-05" }),
      issue({ title: "overdue", stateId: "Progress", assigneeIds: [ME], dueDate: "2026-10-27" }),
    ]),
    ["overdue", "due later", "no due"],
  );
  assert.deepEqual(
    titles("agents", [
      issue({ title: "recent", stateId: "Progress", assigneeIds: [ME], delegateId: AGENT, updatedAt: "2026-10-29T08:00:00Z" }),
      issue({ title: "idle", stateId: "Progress", assigneeIds: [ME], delegateId: AGENT, updatedAt: "2026-10-25T08:00:00Z" }),
      issue({ title: "older", stateId: "Progress", assigneeIds: [ME], delegateId: AGENT, updatedAt: "2026-10-28T08:00:00Z" }),
    ]),
    ["idle", "recent", "older"],
  );
  assert.deepEqual(
    titles("next", [
      issue({ title: "none", stateId: "Todo", assigneeIds: [ME] }),
      issue({ title: "low", stateId: "Todo", assigneeIds: [ME], priority: 4 }),
      issue({ title: "urgent", stateId: "Todo", assigneeIds: [ME], priority: 1 }),
    ]),
    ["urgent", "low", "none"],
  );
});

test("the label makes a proposal only in Backlog: past it the issue is what its state says, with no Accept or Decline", () => {
  const label = { labelIds: [PROPOSED.id], assigneeIds: [ME] };
  const list = [
    issue({ title: "todo", stateId: "Todo", ...label }),
    issue({ title: "progress", stateId: "Progress", ...label }),
    issue({ title: "approved", stateId: "Approved", ...label, createdById: AGENT }),
  ];
  assert.deepEqual(groups(source(list)), { todo: "next", progress: "doing", approved: "doing" });
});

test("actions: a review opens (decided on the issue, RSVA-597), a proposal is accepted or declined, the next started; undo restores the fields", () => {
  const ids = new Set([PROPOSED.id]);
  const [review, proposal, next] = collect("atlas", source([
    issue({ stateId: "Review", createdById: ME }),
    issue({ stateId: "Backlog", labelIds: [PROPOSED.id, "l-ui"] }),
    issue({ stateId: "Todo", assigneeIds: [ME] }),
  ]), NOW, ALL);
  assert.deepEqual(actionsFor(review!, STATES, ME, ids).map((a) => [a.id, a.patch]), [["review", undefined]]);
  const accept = actionsFor(proposal!, STATES, ME, ids);
  assert.deepEqual(accept.map((a) => [a.key, a.patch]), [["A", { stateId: "Todo", labelIds: ["l-ui"], assigneeIds: [ME] }], ["D", { stateId: "Canceled" }]]);
  assert.deepEqual(before(proposal!.issue, accept[0]!.patch!), { stateId: "Backlog", labelIds: [PROPOSED.id, "l-ui"], assigneeIds: [] });
  assert.deepEqual(actionsFor(next!, STATES, ME, ids).map((a) => [a.key, a.patch]), [["S", { stateId: "Progress" }]]);
});

test("an action applies its patch, says what it did and undoes it", () => {
  const [proposal] = collect("atlas", source([issue({ stateId: "Backlog", labelIds: [PROPOSED.id] })]), NOW, ALL);
  const edits: [string, object][] = [];
  const e = { issueKey: (i: Issue) => `ATL-${i.number}`, states: new Map(STATES.map((s) => [s.id, s])), updateIssue: (id: string, p: object) => void edits.push([id, p]) };
  const [accept, decline] = actionsFor(proposal!, STATES, ME, new Set([PROPOSED.id]));
  const done = applyAction(e, proposal!, accept!);
  assert.equal(done.text, `ATL-${proposal!.issue.number} accepted, now in Todo`);
  assert.equal(applyAction(e, proposal!, decline!).text, `ATL-${proposal!.issue.number} declined`);
  done.undo();
  const id = proposal!.issue.id;
  assert.deepEqual(edits, [[id, { stateId: "Todo", labelIds: [], assigneeIds: [ME] }], [id, { stateId: "Canceled" }], [id, { stateId: "Backlog", labelIds: [PROPOSED.id], assigneeIds: [] }]]);
});

test("the issue's review bar asks the rule My work's rows follow, for one issue, and names who asks", () => {
  for (const role of ["owner", "member"] as const) {
    const s = source([
      issue({ stateId: "Review", createdById: ME, delegateId: AGENT }),
      issue({ stateId: "Review", createdById: AGENT }),
      issue({ stateId: "Review", createdById: IRINA }),
      issue({ stateId: "Progress", createdById: ME }),
    ], { role });
    const listed = new Set(collect("atlas", s, NOW, ALL).filter((x) => x.ask === "review").map((x) => x.issue.id));
    for (const i of s.issues.values()) assert.equal(waitsOnReview(s, i), listed.has(i.id), `${role} ${i.id}`);
  }
  const mine = issue({ stateId: "Review", createdById: ME, delegateId: AGENT });
  assert.deepEqual(reviewAsk(source([mine]), ME, mine), { from: AGENT, since: mine.updatedAt });
});

test("scopes and due dates", () => {
  const x = { ws: "atlas", issue: issue({ projectId: "p9" }) };
  assert.ok(inScope("all", x) && inScope("ws:atlas", x) && inScope("p:atlas/p9", x));
  assert.ok(!inScope("ws:beacon", x) && !inScope("p:beacon/p9", x) && !inScope("p:atlas/p1", x));
  const t = "2026-10-29";
  assert.deepEqual(dueText("2026-10-27", t), { text: "2d overdue", over: true, soon: false });
  assert.equal(dueText("2026-10-29", t)?.text, "Due today");
  assert.equal(dueText("2026-10-30", t)?.text, "Due tomorrow");
  assert.equal(dueText("2026-10-31", t)?.text, "Due Sat");
  assert.equal(dueText("2026-11-12", t)?.text, "Due Nov 12");
  assert.equal(dueText(null, t), null);
});

test("an archived project's issues are nobody's work: no review, no proposal, nothing in progress from it", () => {
  const rows = [
    issue({ stateId: "Review", createdById: ME, assigneeIds: [AGENT] }),
    issue({ stateId: "Backlog", labelIds: [PROPOSED.id] }),
    issue({ stateId: "Progress", assigneeIds: [ME] }),
  ];
  const s = source(rows);
  assert.equal(collect("w", s, NOW, ALL).length, 3);
  const archived = { ...s, projects: new Map([[P, { archivedAt: "2026-10-01T00:00:00Z" }]]) };
  assert.deepEqual(collect("w", archived, NOW, ALL), []);
});

test("My work is what is assigned to the viewer; the rest comes in only with `others` (owner 2026-11-11)", () => {
  const list = [
    issue({ title: "proposal", stateId: "Backlog", labelIds: [PROPOSED.id], createdById: AGENT }),
    issue({ title: "agent's review", stateId: "Review", createdById: AGENT }),
    issue({ title: "my own review", stateId: "Review", createdById: ME, delegateId: AGENT }),
    issue({ title: "delegated by me", stateId: "Todo", createdById: ME, delegateId: AGENT }),
    issue({ title: "done by my agent", stateId: "Done", createdById: ME, delegateId: AGENT, completedAt: "2026-10-27T10:00:00Z" }),
    issue({ title: "doing", stateId: "Progress", assigneeIds: [ME] }),
  ];
  assert.deepEqual(groups(source(list), false), { "my own review": "wait:review", doing: "doing" });
  assert.deepEqual(groups(source(list), true), {
    proposal: "wait:proposed",
    "agent's review": "wait:review",
    "my own review": "wait:review",
    "delegated by me": "agents",
    "done by my agent": "done",
    doing: "doing",
  });
  const mine = collect("atlas", source(list), NOW, ALL);
  assert.deepEqual(mine.filter((x) => forTriage(x, ME)).map((x) => x.issue.title), ["proposal", "agent's review"]);
});

test("who triages: the people the workspace named, else every owner and admin (owner 2026-11-11)", () => {
  const list = [issue({ title: "proposal", stateId: "Backlog", labelIds: [PROPOSED.id], createdById: AGENT }), issue({ title: "agent's review", stateId: "Review", createdById: AGENT })];
  const as = (role: User["role"], triagers?: string[]) => ({ ...source(list, { role }), ...(triagers ? { workspace: { triagers } } : {}) }) as WorkSource;
  const titles = (s: WorkSource) => collect("atlas", s, NOW, ALL).map((x) => x.issue.title).sort();
  assert.ok(canTriage(as("admin")) && !canTriage(as("member")));
  assert.deepEqual(titles(as("owner")), ["agent's review", "proposal"]);
  // Named: an admin left out has none of it, a member named has all of it.
  assert.ok(!canTriage(as("admin", ["somebody"])) && canTriage(as("member", [ME])));
  assert.deepEqual(titles(as("admin", ["somebody"])), []);
  assert.deepEqual(titles(as("member", [ME])), ["agent's review", "proposal"]);
  // The issue's review bar follows the same rule.
  assert.ok(waitsOnReview(as("owner"), list[1]!) && !waitsOnReview(as("owner", ["somebody"]), list[1]!));
});
