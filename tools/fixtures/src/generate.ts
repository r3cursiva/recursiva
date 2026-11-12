// Synthetic import bundles (packages/schema/src/bundle.ts) for tests, perf checks and CI. No real data: names, titles
// and descriptions are made up, and only the shape follows our Plane workspace (measured 2026-10-27, docs/research).
// Same preset and seed → byte-identical bundle.
import type { BundleHeader, BundleIssue, BundleLabel, BundleLine, BundleProject, BundleState, BundleUser } from "@rsva/schema/bundle";
import { seeded } from "@rsva/schema/util";

export interface Preset {
  projects: number;
  issues: number;
  /** Humans besides the owner; one agent member is always added. */
  humans: number;
}

export const PRESETS = {
  /** The shape of our workspace: 10 projects, 427 issues, the owner and one agent. */
  sample: { projects: 10, issues: 427, humans: 0 },
  /** Import and snapshot scale check: the plan's budget is 10,000 issues imported in ≤ 60 s. */
  "10k": { projects: 20, issues: 10_000, humans: 6 },
  /** The sync lab's workspace (tools/sync-lab): two people, an agent and little else. */
  lab: { projects: 2, issues: 12, humans: 1 },
} satisfies Record<string, Preset>;

export type PresetName = keyof typeof PRESETS;

export interface GenerateOptions {
  seed?: number;
  slug?: string;
  name?: string;
  /** externalSource of every object; a different source imports as different objects. */
  source?: string;
}

// Distributions from the real workspace (label count and priority per 415 issues with labels counted).
const LABELS_PER_ISSUE: [number, number][] = [[0, 46], [1, 198], [2, 164], [3, 7]];
const PRIORITIES: [BundleIssue["priority"], number][] = [[2, 134], [0, 133], [4, 89], [3, 53], [1, 6]];
// Plane's state groups with our extra review states; the weights are a plausible mix, mostly done.
const STATES: { name: string; group: BundleState["group"]; color: string; weight: number }[] = [
  { name: "Backlog", group: "backlog", color: "#a3a3a3", weight: 22 },
  { name: "Todo", group: "unstarted", color: "#3f76ff", weight: 10 },
  { name: "In Progress", group: "started", color: "#f59e0b", weight: 8 },
  { name: "In Review", group: "started", color: "#8b5cf6", weight: 5 },
  { name: "Approved", group: "started", color: "#14b8a6", weight: 3 },
  { name: "Done", group: "completed", color: "#16a34a", weight: 45 },
  { name: "Cancelled", group: "cancelled", color: "#dc2626", weight: 7 },
];
const LABELS: [string, string][] = [["bug", "#ef4444"], ["feature", "#3b82f6"], ["security", "#f97316"], ["chore", "#6b7280"]];
const PROJECT_NAMES = [
  "Core", "Web", "Api", "Ops", "Docs", "Mobile", "Data", "Auth", "Billing", "Search",
  "Infra", "Design", "Growth", "Support", "Sync", "Editor", "Import", "Agents", "Reports", "Admin",
];
const VERBS = ["Fix", "Add", "Remove", "Refactor", "Speed up", "Document", "Migrate", "Validate", "Cache", "Split", "Rename", "Test", "Investigate", "Clean up", "Support"];
const OBJECTS = [
  "retry queue", "snapshot cache", "login form", "issue list", "label picker", "state machine", "webhook handler", "backup job",
  "search index", "release notes", "TLS renewal", "rate limiter", "export script", "settings page", "error page", "audit log",
  "sync socket", "deploy script", "image upload", "date picker", "keyboard shortcuts", "dark theme", "email digest", "CSV import",
];
const QUALIFIERS = ["on slow networks", "after reconnect", "for archived projects", "in Safari", "under load", "for agents", "on mobile", "when offline", "for large workspaces", "", "", ""];
const WORDS = (
  "the a we it this that server client queue cache issue state label project user agent sync log change snapshot request " +
  "response error timeout retry token page list view row column filter sort order number date time value field form button " +
  "should must can will does not when after before because so then only also still again first next last new old slow fast " +
  "small large empty broken missing extra stale fresh local remote open closed check update remove add keep move send read write"
).split(" ");

export function generate(preset: PresetName | Preset, opts: GenerateOptions = {}): (BundleHeader | BundleLine)[] {
  const p = typeof preset === "string" ? PRESETS[preset] : preset;
  const rand = seeded(opts.seed ?? 1);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const source = opts.source ?? "fixture";
  const slug = opts.slug ?? "fixture";
  // A fixed clock: the bundle must not depend on when it was generated.
  const now = Date.parse("2026-10-01T09:00:00Z");
  const day = 86_400_000;

  const users: BundleUser[] = [
    { m: "User", ext: "u-owner", email: `owner@${slug}.test`, name: "Owner", kind: "human" },
    { m: "User", ext: "u-agent", email: `bot@${slug}.test`, name: "Agent", kind: "agent" },
  ];
  for (let i = 1; i <= p.humans; i++) users.push({ m: "User", ext: `u-${i}`, email: `user${i}@${slug}.test`, name: `User ${i}`, kind: "human" });

  const projects: BundleProject[] = [];
  const states: BundleState[] = [];
  const labels: BundleLabel[] = [];
  for (let n = 0; n < p.projects; n++) {
    const name = PROJECT_NAMES[n % PROJECT_NAMES.length]! + (n >= PROJECT_NAMES.length ? ` ${Math.floor(n / PROJECT_NAMES.length) + 1}` : "");
    const ext = `p-${n + 1}`;
    projects.push({ m: "Project", ext, key: name.replace(/\W/g, "").toUpperCase().slice(0, 6), name, createdAt: iso(now - (400 - n * 10) * day) });
    STATES.forEach((s, i) => states.push({ m: "State", ext: `${ext}-s${i + 1}`, project: { ext }, name: s.name, group: s.group, color: s.color, position: (i + 1) * 1000, isDefault: i === 0 }));
    LABELS.forEach(([l, color], i) => labels.push({ m: "Label", ext: `${ext}-l${i + 1}`, project: { ext }, name: l, color, position: i }));
  }

  // Issues per project are uneven, as in a real workspace: a few big projects and a long tail.
  const weights = projects.map((_, i) => 1 / (i + 1.5));
  const projectOf = shuffle(rand, allocate(p.issues, weights.map((w, i) => [i, w] as [number, number])));
  const labelCounts = shuffle(rand, allocate(p.issues, LABELS_PER_ISSUE));
  const priorities = shuffle(rand, allocate(p.issues, PRIORITIES));
  const stateOf = shuffle(rand, allocate(p.issues, STATES.map((s, i) => [i, s.weight] as [number, number])));
  const assignees: BundleIssue["assignees"][] = users.map((u) => [{ ext: u.ext }]);

  const issues: BundleIssue[] = [];
  const counters = projects.map(() => 0);
  const byProject: BundleIssue[][] = projects.map(() => []);
  for (let n = 0; n < p.issues; n++) {
    const pi = projectOf[n]!;
    const pext = projects[pi]!.ext;
    const number = ++counters[pi]!;
    const si = stateOf[n]!;
    const s = STATES[si]!;
    const created = now - Math.floor(rand() * 360 * day);
    const closed = s.group === "completed" || s.group === "cancelled";
    const roll = rand();
    const lc = labelCounts[n]!;
    const issue: BundleIssue = {
      m: "Issue",
      ext: `${pext}-i${number}`,
      project: { ext: pext },
      number,
      title: `${pick(VERBS)} ${pick(OBJECTS)} ${pick(QUALIFIERS)}`.trim(),
      position: Math.round(rand() * 1_000_000),
      state: { ext: `${pext}-s${si + 1}` },
      priority: priorities[n]!,
      // Mostly the owner, a quarter for the agent, some unassigned.
      assignees: roll < 0.6 ? assignees[0]! : roll < 0.85 ? assignees[1 + (p.humans ? Math.floor(rand() * (p.humans + 1)) : 0)]! : [],
      labels: shuffle(rand, LABELS.map((_, i) => ({ ext: `${pext}-l${i + 1}` }))).slice(0, lc),
      startDate: rand() < 0.1 ? iso(created + 2 * day).slice(0, 10) : null,
      dueDate: rand() < 0.2 ? iso(created + 14 * day).slice(0, 10) : null,
      createdBy: { ext: rand() < 0.7 ? "u-owner" : "u-agent" },
      createdAt: iso(created),
      updatedAt: iso(created + Math.floor(rand() * 20 * day)),
      completedAt: closed ? iso(created + Math.floor((1 + rand() * 30) * day)) : null,
      descriptionHtml: description(rand, pick),
    };
    // Sub-issues: about one in twelve has a parent created earlier in the same project.
    const siblings = byProject[pi]!;
    if (siblings.length > 0 && rand() < 0.08) issue.parent = { ext: pick(siblings).ext };
    siblings.push(issue);
    issues.push(issue);
  }

  const header: BundleHeader = { m: "Bundle", version: 1, source, workspace: { slug, name: opts.name ?? `Fixture ${slug}` }, owner: { ext: "u-owner" } };
  return [header, ...users, ...projects, ...states, ...labels, ...issues];
}

/**
 * Description as simple HTML. Target lengths are log-normal and capped at 3.5k; the text ends past the target, so the
 * parameters are tuned to land the result at a median of ~246 characters and a maximum of ~3.5k, as in our workspace.
 */
function description(rand: () => number, pick: <T>(xs: readonly T[]) => T): string {
  const normal = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const target = Math.min(3500, Math.round(205 * Math.exp(1.05 * normal)));
  const sentence = (n: number) => {
    const w = Array.from({ length: n }, () => pick(WORDS)).join(" ");
    return w[0]!.toUpperCase() + w.slice(1) + ".";
  };
  let html = "";
  while (html.length < target) {
    if (html && rand() < 0.15) {
      html += `<ul>${Array.from({ length: 2 + Math.floor(rand() * 3) }, () => `<li><p>${sentence(3 + Math.floor(rand() * 5))}</p></li>`).join("")}</ul>`;
      continue;
    }
    // Sentence by sentence, so the text stops close to the target instead of a whole paragraph past it.
    let p = sentence(4 + Math.floor(rand() * 10));
    while (html.length + p.length + 7 < target && rand() < 0.65) p += " " + sentence(4 + Math.floor(rand() * 10));
    html += `<p>${p}</p>`;
  }
  return html;
}

/** Exactly n values with counts proportional to the weights (largest remainder), in order. */
function allocate<T>(n: number, weights: [T, number][]): T[] {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  const exact = weights.map(([v, w]) => ({ v, q: (n * w) / total }));
  const counts = exact.map((e) => Math.floor(e.q));
  let rest = n - counts.reduce((s, c) => s + c, 0);
  const byRemainder = exact.map((e, i) => ({ i, r: e.q - Math.floor(e.q) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of byRemainder) {
    if (rest-- <= 0) break;
    counts[i]!++;
  }
  return exact.flatMap((e, i) => Array<T>(counts[i]!).fill(e.v));
}

function shuffle<T>(rand: () => number, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
