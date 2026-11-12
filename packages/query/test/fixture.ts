// A small workspace for the query tests, and a generator of large ones for the benchmark.
import { blankIssueFields, type Issue, type Label, type Project, type User, type WorkflowState } from "@rsva/schema/models";
import { DEFAULT_DISPLAY, type DisplayOptions, type QueryContext } from "../src/index.ts";

const P = "00000000-0000-4000-8000-000000000001";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const state = (n: number, name: string, group: string, position: number): WorkflowState => ({
  id: uuid(100 + n),
  projectId: P,
  name,
  group,
  color: "#888888",
  position,
  isDefault: n === 0,
  onlyPeople: name === "Todo",
});

export const S = {
  backlog: state(0, "Backlog", "backlog", 1),
  todo: state(1, "Todo", "unstarted", 2),
  progress: state(2, "In Progress", "started", 3),
  review: state(3, "In Review", "started", 4),
  done: state(4, "Done", "completed", 5),
  cancelled: state(5, "Cancelled", "cancelled", 6),
};

const label = (n: number, name: string, position: number, parentId: string | null = null): Label => ({
  id: uuid(200 + n),
  projectId: P,
  parentId,
  name,
  color: "#ff0000",
  position,
  onlyPeople: false,
});

export const L = {
  bug: label(0, "bug", 2),
  security: label(1, "security", 1),
  needsOwner: label(2, "needs owner", 3),
};

const user = (n: number, name: string, email: string, kind = "human"): User => ({ id: uuid(300 + n), name, email, kind, picture: null, avatar: null, role: "member" });

export const U = {
  alex: user(0, "Alex", "a@example.com"),
  bot: user(1, "bot", "bot@example.com", "agent"),
  zoe: user(2, "Zoe Quinn", "zoe@example.com"),
};

let seq = 0;
/** An issue with sensible defaults; `n` is its number, also used in the id. */
export function issue(n: number, over: Partial<Issue> = {}): Issue {
  seq++;
  return {
    id: uuid(10_000 + n),
    projectId: P,
    number: n,
    title: `Issue ${n}`,
    stateId: S.todo.id,
    ...blankIssueFields(),
    sortOrder: `a${String(n).padStart(4, "0")}`,
    createdById: U.alex.id,
    createdAt: `2026-10-${String(1 + (n % 27)).padStart(2, "0")} 10:00:00.000+00`,
    updatedAt: `2026-10-${String(1 + (n % 27)).padStart(2, "0")} 12:00:00.000+00`,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    formerKeys: [],
    ...over,
  };
}

/** Projects for a view across projects (PLNR-74): only the fields the query reads. */
export function projectMap(list: { id: string; key: string; name: string; formerKeys?: string[] }[]): ReadonlyMap<string, Project> {
  return new Map(list.map((p) => [p.id, { formerKeys: [], ...p } as Project]));
}

export function ctx(over: Partial<QueryContext> = {}): QueryContext {
  return {
    states: new Map(Object.values(S).map((s) => [s.id, s])),
    labels: new Map(Object.values(L).map((l) => [l.id, l])),
    users: new Map(Object.values(U).map((u) => [u.id, u])),
    me: U.alex.id,
    issueKey: (i) => `PLNR-${i.number}`,
    today: "2026-10-27",
    ...over,
  };
}

export function display(over: Partial<DisplayOptions> = {}): DisplayOptions {
  return { ...DEFAULT_DISPLAY, properties: [...DEFAULT_DISPLAY.properties], showEmptyGroups: false, ...over };
}

/** A deterministic pseudo-random generator, so the benchmark data is the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const WORDS = ["fix", "deploy", "caddy", "backup", "plane", "sync", "label", "filter", "dark", "mode", "server", "mail", "dns", "pi", "tailscale", "upgrade", "node", "postgres", "audit", "report"];

/** `n` issues spread over the fixture's states, labels and users like a real project (sparse dates, few labels). */
export function bigProject(n: number, seed = 1): Issue[] {
  const r = rng(seed);
  const states = Object.values(S);
  const labels = Object.values(L);
  const users = Object.values(U);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const out: Issue[] = [];
  for (let k = 1; k <= n; k++) {
    const day = (d: number) => `2026-${String(1 + Math.floor(d / 28)).padStart(2, "0")}-${String(1 + (d % 28)).padStart(2, "0")}`;
    out.push(
      issue(k, {
        id: `${uuid(k)}-${k}`,
        title: `${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)} #${k}`,
        stateId: pick(states).id,
        priority: Math.floor(r() * 5),
        assigneeIds: r() < 0.6 ? [pick(users).id] : r() < 0.5 ? [users[0]!.id, users[1]!.id] : [],
        labelIds: r() < 0.5 ? [] : r() < 0.7 ? [pick(labels).id] : [labels[0]!.id, labels[1]!.id],
        parentId: r() < 0.15 ? uuid(10_000 + Math.max(1, k - 3)) : null,
        dueDate: r() < 0.3 ? day(Math.floor(r() * 330)) : null,
        startDate: r() < 0.2 ? day(Math.floor(r() * 330)) : null,
        sortOrder: Math.floor(r() * 1e9).toString(36),
        createdAt: `${day(Math.floor(r() * 300))} 10:00:00.000+00`,
        updatedAt: `${day(Math.floor(r() * 300))} 11:00:00.000+00`,
      }),
    );
  }
  return out;
}
