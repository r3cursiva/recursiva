// The demo workspace of the README and the Product Hunt gallery (RSVA-587): a made-up team "Lumen" with three projects,
// forty issues, a few comments and agent members, as an import bundle (packages/schema/src/bundle.ts). Names are
// invented and the addresses are example.com ones. What a bundle cannot carry (cycles, an agent's delegation) is added
// through the API by tools/perf/src/demo.ts. Dates are relative to `now`, so the cycle is always in progress.
import postgres from "postgres";
import type { BundleComment, BundleHeader, BundleIssue, BundleLabel, BundleLine, BundleLink, BundleProject, BundleState, BundleUser } from "@rsva/schema/bundle";

const DAY = 86_400_000;

export const DEMO_SLUG = "lumen";
/** Who the demo is seen as, and the two agents. */
export const DEMO_OWNER = "maya@example.com";
export const DEMO_AGENTS = { atlas: "atlas@example.com", relay: "relay@example.com" } as const;

const PEOPLE: [string, string, "human" | "agent"][] = [
  ["maya", "Maya Chen", "human"],
  ["jonas", "Jonas Weber", "human"],
  ["priya", "Priya Nair", "human"],
  ["tomas", "Tomás Silva", "human"],
  ["hana", "Hana Kimura", "human"],
  ["atlas", "Atlas", "agent"],
  ["relay", "Relay", "agent"],
];
const PROJECTS: [string, string, string][] = [
  ["WEB", "Web app", "The browser app: lists, boards, issue pages."],
  ["API", "Platform API", "The server, the public API and webhooks."],
  ["MOB", "Mobile app", "The phone app."],
];
const STATES: [string, BundleState["group"], string][] = [
  ["Backlog", "backlog", "#a3a3a3"],
  ["Todo", "unstarted", "#3f76ff"],
  ["In Progress", "started", "#f59e0b"],
  ["In Review", "started", "#8b5cf6"],
  ["Approved", "started", "#14b8a6"],
  ["Done", "completed", "#16a34a"],
  ["Cancelled", "cancelled", "#dc2626"],
];
const LABELS: [string, string][] = [["bug", "#ef4444"], ["feature", "#3b82f6"], ["improvement", "#14b8a6"], ["design", "#ec4899"], ["docs", "#6b7280"], ["security", "#f97316"]];

interface Extra {
  /** Parent issue number in the same project. */
  parent?: number;
  /** Due date, days from today. */
  due?: number;
  /** An agent made it (it shows under "Waiting on you" in review). */
  by?: string;
  description?: string;
  blockedBy?: string;
  pr?: [url: string, title: string];
}
type Row = [project: string, title: string, state: string, priority: BundleIssue["priority"], who: string, labels: string, extra?: Extra];

// Priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. Numbers follow the order of the rows within a project.
const ROWS: Row[] = [
  ["WEB", "Add CSV export to the issue list", "In Review", 2, "maya", "feature", {
    by: "atlas", due: 2, pr: ["https://github.com/lumen-app/web/pull/412", "Export the filtered list as CSV"],
    description: "Export what the list shows, after filters and sorting, as a CSV file.\n\n- One row per issue; the columns are the ones on screen\n- Labels joined with `;`\n- Large lists stream, so the tab does not freeze\n\nOut of scope: a scheduled export.",
  }],
  ["WEB", "Fix focus ring clipped in the sidebar", "Done", 3, "priya", "bug"],
  ["WEB", "Keyboard shortcut cheat sheet", "In Progress", 3, "maya", "feature", { due: 5 }],
  ["WEB", "Dark theme: contrast on muted text", "In Progress", 2, "priya", "design,bug", { due: 3 }],
  ["WEB", "Empty state for projects without issues", "Done", 3, "hana", "design"],
  ["WEB", "Onboarding checklist for new members", "Done", 2, "hana", "feature"],
  ["WEB", "Slow scroll on boards with 500+ cards", "In Progress", 1, "jonas", "bug", { due: 1, description: "Scrolling a column with hundreds of cards drops to 20 fps on a laptop.\n\nWindow the cards instead of rendering them all." }],
  ["WEB", "Drag a card between columns", "Done", 3, "tomas", "feature"],
  ["WEB", "Saved views: share by link", "Done", 3, "priya", "feature"],
  ["WEB", "Notifications settings page", "In Progress", 3, "tomas", "feature"],
  ["WEB", "Email digest toggle", "Todo", 3, "tomas", "feature", { parent: 10 }],
  ["WEB", "Per-project mute", "Todo", 3, "tomas", "feature", { parent: 10 }],
  ["WEB", "Quiet hours", "Backlog", 4, "", "feature", { parent: 10 }],
  ["WEB", "Localise date formats", "Backlog", 4, "", "improvement"],
  ["WEB", "Replace the logo SVG", "Cancelled", 4, "hana", "design"],
  ["WEB", "Update the screenshots on the docs site", "In Review", 4, "maya", "docs", { by: "relay" }],
  ["API", "Rate-limit the sign-in endpoint", "In Review", 1, "maya", "security,bug", {
    by: "atlas", due: 1, pr: ["https://github.com/lumen-app/platform/pull/298", "Limit sign-in attempts per address and per account"],
    description: "Sign-in codes can be requested and guessed without limit.\n\n- 5 attempts per code, then the code is void\n- 10 code requests per hour per address\n- Same answer for known and unknown addresses",
  }],
  ["API", "Webhook retries with backoff", "In Progress", 2, "maya", "feature", { due: 4 }],
  ["API", "Paginate /issues with cursors", "Done", 2, "tomas", "improvement"],
  ["API", "Return 404 instead of 500 for unknown project keys", "Done", 3, "maya", "bug", { by: "relay" }],
  ["API", "Idempotency keys for POST /issues", "Todo", 2, "tomas", "feature"],
  ["API", "Audit log export", "Backlog", 3, "", "feature"],
  ["API", "Document the error codes", "In Review", 3, "maya", "docs", { by: "relay" }],
  ["API", "Upgrade Postgres on staging", "Todo", 2, "jonas", "improvement", { due: 4 }],
  ["API", "Token scopes per resource", "In Progress", 2, "tomas", "feature"],
  ["API", "Scope picker in the token dialog", "Todo", 3, "priya", "feature", { parent: 9 }],
  ["API", "Migrate existing tokens to scopes", "Todo", 2, "tomas", "security", { parent: 9, blockedBy: "API-9" }],
  ["API", "Flaky test: socket reconnect", "Done", 3, "jonas", "bug"],
  ["API", "p99 latency alert is too noisy", "Todo", 3, "jonas", "improvement"],
  ["API", "Deprecate the v0 endpoints", "Backlog", 4, "", "chore"],
  ["MOB", "Push notifications for mentions", "In Progress", 2, "hana", "feature", { due: 6 }],
  ["MOB", "Pull to refresh in the inbox", "Done", 3, "hana", "improvement"],
  ["MOB", "Crash when opening an issue offline", "Todo", 1, "jonas", "bug", { due: 3 }],
  ["MOB", "Haptics on swipe actions", "Backlog", 4, "", "improvement"],
  ["MOB", "Biometric unlock", "Backlog", 3, "", "feature"],
  ["MOB", "Share sheet: create an issue from a link", "In Review", 3, "maya", "feature", { by: "atlas", pr: ["https://github.com/lumen-app/mobile/pull/77", "Share extension for links"] }],
  ["MOB", "Tab bar badge stays after reading", "Done", 3, "priya", "bug"],
  ["MOB", "Larger tap targets on filters", "Todo", 3, "priya", "design"],
  ["MOB", "My work widget", "Backlog", 4, "", "feature"],
  ["MOB", "App icon variants", "Cancelled", 4, "hana", "design"],
];

/** Comments: [issue key, author, text, days ago].  */
const COMMENTS: [string, string, string, number][] = [
  ["WEB-1", "atlas", "Opened the pull request. The export streams in chunks of 500 rows, so a list of 20,000 issues does not freeze the tab. Tests cover filters, sorting and labels; CI is green. Waiting for your review.", 0.3],
  ["WEB-1", "priya", "Can the file name carry the project key and the date? `web-issues-2026-11-10.csv` would be easier to find later.", 0.2],
  ["WEB-1", "atlas", "Done: the name is now `<project>-issues-<date>.csv`. I did not touch the column order.", 0.15],
  ["WEB-16", "relay", "Replaced the five outdated screenshots and added the Cycles page. Dark and light variants are both in the PR.", 0.8],
  ["API-7", "relay", "Listed all 23 error codes with an example response each. Two codes had no test; I added them.", 0.9],
  ["WEB-7", "jonas", "Profiled it: most of the time goes to laying out cards that are off screen. Windowing the column should cut it to a few milliseconds.", 1.5],
  ["WEB-7", "maya", "Let's ship this before the release. Ping me when there is a build to try.", 1.2],
  ["WEB-4", "priya", "Muted text on the board is 3.9:1 against the card in the dark theme. Raising it to 4.6:1 passes AA.", 2.4],
  ["MOB-3", "jonas", "Reproduced on a build without a network: the issue page reads a comment count that is not cached yet.", 2],
  ["API-9", "tomas", "Plan: scopes per resource, read or write, as on the token dialog. Existing tokens keep full access until their owner narrows them.", 3],
  ["API-9", "maya", "Good. No silent narrowing, and show a notice in Settings for tokens that were never scoped.", 2.8],
];

const iso = (ms: number) => new Date(ms).toISOString();
const dateOf = (ms: number) => iso(ms).slice(0, 10);

export function demo(now: number = Date.now()): (BundleHeader | BundleLine)[] {
  const ago = (days: number) => iso(now - days * DAY);
  const users: BundleUser[] = PEOPLE.map(([ext, name, kind]) => ({ m: "User", ext: `u-${ext}`, email: `${ext}@example.com`, name, kind }));
  const projects: BundleProject[] = [];
  const states: BundleState[] = [];
  PROJECTS.forEach(([key, name], n) => {
    projects.push({ m: "Project", ext: `p-${key}`, key, name, createdAt: ago(120 - n * 10) });
    STATES.forEach(([s, group, color], i) => states.push({ m: "State", ext: `${key}-${s}`, project: { ext: `p-${key}` }, name: s, group, color, position: (i + 1) * 1000, isDefault: i === 0 }));
  });
  const labels: BundleLabel[] = LABELS.map(([name, color], i) => ({ m: "Label", ext: `l-${name}`, project: null, name, color, position: i }));

  const counters: Record<string, number> = {};
  const issues: BundleIssue[] = [];
  const links: BundleLink[] = [];
  ROWS.forEach(([key, title, state, priority, who, labelNames, x = {}], idx) => {
    const number = (counters[key] = (counters[key] ?? 0) + 1);
    const ext = `${key}-${number}`;
    const done = state === "Done" || state === "Cancelled";
    // A cycle's finished issues are imported open and finished through the API, so the cycle's burn-up has a history.
    const finishedAt = FINISHED[ext];
    const created = 14 + ((idx * 5) % 30);
    const closed = 1 + (idx % 8);
    const issue: BundleIssue = {
      m: "Issue",
      ext,
      project: { ext: `p-${key}` },
      number,
      title,
      position: idx * 10,
      state: { ext: `${key}-${finishedAt === undefined ? state : "In Progress"}` },
      priority,
      assignees: who ? [{ ext: `u-${who}` }] : [],
      labels: labelNames.split(",").map((l) => ({ ext: `l-${l}` })),
      dueDate: x.due === undefined ? null : dateOf(now + x.due * DAY),
      createdBy: { ext: `u-${x.by ?? (who || "maya")}` },
      createdAt: ago(created),
      updatedAt: ago(done ? closed : (idx % 4) * 0.5 + 0.1),
      completedAt: done && finishedAt === undefined ? ago(closed) : null,
    };
    if (x.parent) issue.parent = { ext: `${key}-${x.parent}` };
    if (x.blockedBy) issue.blockedBy = [{ ext: x.blockedBy }];
    if (x.description) issue.description = x.description;
    issues.push(issue);
    if (x.pr) links.push({ m: "Link", ext: `link-${ext}`, issue: { ext }, url: x.pr[0], title: x.pr[1], createdBy: { ext: `u-${x.by ?? "maya"}` }, createdAt: ago(0.3) });
  });

  const comments: BundleComment[] = COMMENTS.map(([issue, author, body, days], n) => ({
    m: "Comment",
    ext: `c-${n + 1}`,
    issue: { ext: issue },
    author: { ext: `u-${author}` },
    body,
    createdAt: ago(days),
  }));

  const header: BundleHeader = { m: "Bundle", version: 1, source: "demo", workspace: { slug: DEMO_SLUG, name: "Lumen" }, owner: { ext: "u-maya" } };
  return [header, ...users, ...projects, ...states, ...labels, ...issues, ...links, ...comments];
}

/** Cycles for tools/perf/src/demo.ts: [project, name, start day, end day, issue numbers]. Days are relative to today. */
export const DEMO_CYCLES: [project: string, name: string, start: number, end: number, issues: number[]][] = [
  ["WEB", "Cycle 12", -6, 7, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]],
  ["WEB", "Cycle 13", 8, 21, [13, 14]],
  ["API", "Cycle 12", -6, 7, [1, 2, 3, 4, 7, 8, 9, 12]],
  ["MOB", "Cycle 8", -6, 7, [1, 2, 3, 6, 7, 8]],
];
/** Issues an agent works on for the owner (delegate), and the agent. */
/** Done issues of the running cycles and how many days ago each was finished (the key is "WEB-2"). */
export const DEMO_FINISHED: [issue: string, daysAgo: number][] = [
  ["WEB-2", 5], ["WEB-5", 4], ["WEB-6", 3], ["WEB-8", 2], ["WEB-9", 1],
  ["API-3", 5], ["API-4", 3], ["API-12", 1],
  ["MOB-2", 4], ["MOB-7", 2],
];
const FINISHED: Record<string, number> = Object.fromEntries(DEMO_FINISHED);

/**
 * The cycles were filled and the issues finished through the API just now, so the log says everything happened today. The
 * burn-up reads the log (apps/server/src/sync/cycles.ts): this puts the cycle assignments and the delegations at the cycle's start and each
 * finish on its day. The only SQL of the demo; the server is stopped while it runs.
 */
export async function backdateDemo(databaseUrl: string): Promise<void> {
  const db = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const at = (daysAgo: number, hour: number) => {
      const d = new Date(Date.now() - daysAgo * DAY);
      d.setUTCHours(hour, 0, 0, 0);
      return d;
    };
    const cycleStart = at(6, 9);
    await db`update sync_action set created_at = ${cycleStart}
      where model = 'Issue' and (data->>'cycleId' in (select id::text from cycle where start_date < current_date) or data ? 'delegateId')`;
    for (const [key, daysAgo] of DEMO_FINISHED) {
      const [project, number] = key.split("-") as [string, string];
      const when = at(daysAgo, 11 + (Number(number) % 5));
      const target = db`(select i.id from issue i join project p on p.id = i.project_id where p.key = ${project} and i.number = ${Number(number)})`;
      await db`update sync_action set created_at = ${when} where model = 'Issue' and model_id = ${target} and data ? 'stateId'`;
      await db`update issue set completed_at = ${when} where id = ${target}`;
    }
  } finally {
    await db.end();
  }
}

export const DEMO_DELEGATES: [issue: string, agent: keyof typeof DEMO_AGENTS][] = [
  ["WEB-1", "atlas"], ["WEB-16", "relay"], ["API-1", "atlas"], ["API-7", "relay"], ["MOB-6", "atlas"], ["WEB-3", "relay"], ["API-2", "atlas"],
];
