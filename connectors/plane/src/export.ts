// Plane → planner import bundle (NDJSON, packages/schema/src/bundle.ts).
//
//   PLANE_API_KEY=… PLANE_BASE_URL=https://plane.example.com PLANE_WORKSPACE=atlas node connectors/plane/src/export.ts > atlas.ndjson
//   PLANE_PROJECTS=PLNR …   only these projects (identifiers, comma-separated); members come along all the same
//
// Reads only through Plane's public API v1: workspace members, projects, states, labels, issues with descriptions,
// comments with our fork's replies (`parent`). Per-project requests run in parallel: at 280 ms to the server a
// sequential walk would take tens of seconds.
//
// Comments are listed per issue (API v1 has no workspace-wide list), one request per issue. The API key is limited to
// 60 requests a minute by default, so for ~450 issues the export takes about 8 minutes; requests follow the
// X-RateLimit-Remaining / X-RateLimit-Reset headers instead of hammering into 429s.
// Not exported yet (prototype): archived issues, reactions (no API v1 endpoint), relations, attachments, links.
import {
  toNdjson,
  type BundleComment,
  type BundleHeader,
  type BundleIssue,
  type BundleLabel,
  type BundleLine,
  type BundleProject,
  type BundleState,
  type BundleUser,
} from "@rsva/schema/bundle";
import { displayName, PRIORITY, planeMarkdown, STATE_GROUPS, userKind } from "./plane.ts";

const key = process.env.PLANE_API_KEY;
if (!key) throw new Error("PLANE_API_KEY is required");
const base = process.env.PLANE_BASE_URL?.replace(/\/$/, "");
const slug = process.env.PLANE_WORKSPACE;
if (!base || !slug) throw new Error("PLANE_BASE_URL and PLANE_WORKSPACE are required");
const ownerEmail = process.env.PLANE_OWNER_EMAIL;
const only = new Set((process.env.PLANE_PROJECTS ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
const api = `${base}/api/v1/workspaces/${slug}`;

interface Page<T> {
  results: T[];
  next_cursor: string;
  next_page_results: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What the last response said about the rate window: requests left and when the window resets (epoch ms). */
const rate = { remaining: Infinity, resetAt: 0 };
const CONCURRENCY = 4;
let inFlight = 0;
const waiting: (() => void)[] = [];

async function get<T>(path: string): Promise<T> {
  while (inFlight >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  try {
    for (let attempt = 0; ; attempt++) {
      // Leave room for the requests already in flight; wait out the window instead of collecting 429s.
      if (rate.remaining <= CONCURRENCY && rate.resetAt > Date.now()) await sleep(rate.resetAt - Date.now() + 500);
      const res = await fetch(api + path, { headers: { "X-API-Key": key! } });
      const left = Number(res.headers.get("x-ratelimit-remaining"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      if (res.headers.has("x-ratelimit-remaining") && Number.isFinite(left)) {
        rate.remaining = left;
        rate.resetAt = reset * 1000;
      }
      if (res.status === 429 && attempt < 8) {
        await sleep(Math.max(1000 * 2 ** Math.min(attempt, 4), rate.resetAt - Date.now() + 500));
        continue;
      }
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as T;
    }
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

async function all<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor = "";
  for (;;) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await get<Page<T> | T[]>(`${path}${sep}per_page=100${cursor ? `&cursor=${cursor}` : ""}`);
    if (Array.isArray(page)) return page;
    out.push(...page.results);
    if (!page.next_page_results) return out;
    cursor = page.next_cursor;
  }
}

interface PlaneMember { id: string; email: string; display_name: string; first_name: string; last_name: string; role: number }
interface PlaneProject { id: string; identifier: string; name: string; created_at: string; archived_at: string | null }
interface PlaneState { id: string; name: string; group: string; color: string; sequence: number; default: boolean }
interface PlaneLabel { id: string; name: string; color: string; parent: string | null; sort_order: number }
interface PlaneIssue {
  id: string; sequence_id: number; name: string; state: string; priority: string;
  assignees: string[]; labels: string[]; parent: string | null; start_date: string | null; target_date: string | null;
  created_by: string | null; created_at: string; updated_at: string; completed_at: string | null; archived_at: string | null;
  sort_order: number; description_html: string | null;
}
interface PlaneComment {
  id: string; issue: string; parent: string | null; actor: string | null; created_by: string | null;
  comment_html: string; created_at: string; edited_at: string | null; deleted_at: string | null;
}

const ref = (id: string | null | undefined) => (id ? { ext: id } : null);
const out: BundleLine[] = [];
const started = performance.now();

const members = await all<PlaneMember>("/members/");
const names = new Map<string, string>();
for (const m of members) {
  const name = displayName({ email: m.email, displayName: m.display_name, firstName: m.first_name, lastName: m.last_name });
  names.set(m.id, name);
  out.push({ m: "User", ext: m.id, email: m.email, name, kind: userKind(m.email) } satisfies BundleUser);
}
const markdown = (html: string | null | undefined) => planeMarkdown(html, { userName: (id) => names.get(id) });
const owner = members.find((m) => (ownerEmail ? m.email === ownerEmail : m.role === 20 && !m.email.startsWith("bot@"))) ?? members[0]!;

const projects = (await all<PlaneProject>("/projects/")).filter((p) => !only.size || only.has(p.identifier));
if (only.size && projects.length !== only.size) throw new Error(`no project ${[...only].filter((k) => !projects.some((p) => p.identifier === k)).join(", ")} in ${slug}`);
const perProject = await Promise.all(
  projects.map(async (p) => {
    const [states, labels, issues] = await Promise.all([
      all<PlaneState>(`/projects/${p.id}/states/`),
      all<PlaneLabel>(`/projects/${p.id}/labels/`),
      all<PlaneIssue>(`/projects/${p.id}/work-items/`),
    ]);
    return { p, states, labels, issues };
  }),
);

// Comments of every exported issue; the requests share the rate-limited queue above.
const commentsOf = new Map<string, PlaneComment[]>();
await Promise.all(
  perProject.flatMap(({ p, issues }) =>
    issues.map(async (i) => commentsOf.set(i.id, await all<PlaneComment>(`/projects/${p.id}/work-items/${i.id}/comments/`))),
  ),
);

let issueCount = 0;
let commentCount = 0;
let replyCount = 0;
for (const { p, states, labels, issues } of perProject) {
  out.push({ m: "Project", ext: p.id, key: p.identifier, name: p.name, createdAt: p.created_at, archivedAt: p.archived_at } satisfies BundleProject);
  for (const s of states) {
    if (!STATE_GROUPS.has(s.group)) continue; // triage is Plane's internal intake state
    out.push({
      m: "State", ext: s.id, project: { ext: p.id }, name: s.name, group: s.group as BundleState["group"],
      color: s.color, position: s.sequence, isDefault: s.default,
    } satisfies BundleState);
  }
  for (const l of labels) {
    out.push({ m: "Label", ext: l.id, project: { ext: p.id }, parent: ref(l.parent), name: l.name, color: l.color, position: l.sort_order } satisfies BundleLabel);
  }
  for (const i of issues) {
    issueCount++;
    out.push({
      m: "Issue", ext: i.id, project: { ext: p.id }, number: i.sequence_id, title: i.name, position: i.sort_order,
      state: { ext: i.state }, priority: PRIORITY[i.priority] ?? 0,
      assignees: i.assignees.map((ext) => ({ ext })), labels: i.labels.map((ext) => ({ ext })), parent: ref(i.parent),
      startDate: i.start_date, dueDate: i.target_date, createdBy: ref(i.created_by),
      createdAt: i.created_at, updatedAt: i.updated_at, completedAt: i.completed_at, archivedAt: i.archived_at,
      description: markdown(i.description_html),
    } satisfies BundleIssue);
  }
}

const memberIds = new Set(members.map((m) => m.id));
for (const [issueId, comments] of commentsOf) {
  const live = comments.filter((c) => !c.deleted_at);
  const ids = new Set(live.map((c) => c.id));
  // Oldest first, so a parent precedes its replies in the bundle (the import does not depend on it).
  for (const c of live.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const author = c.actor ?? c.created_by;
    const parent = c.parent && ids.has(c.parent) ? c.parent : null;
    commentCount++;
    if (parent) replyCount++;
    out.push({
      m: "Comment", ext: c.id, issue: { ext: issueId }, parent: ref(parent),
      author: author && memberIds.has(author) ? { ext: author } : null,
      body: markdown(c.comment_html), createdAt: c.created_at, editedAt: c.edited_at,
    } satisfies BundleComment);
  }
}

const header: BundleHeader = { m: "Bundle", version: 1, source: "plane", workspace: { slug, name: slug }, owner: { ext: owner.id } };
process.stdout.write(toNdjson([header, ...out]));
console.error(
  `Plane → bundle: ${members.length} members, ${projects.length} projects, ${issueCount} issues, ${commentCount} comments (${replyCount} replies) in ${((performance.now() - started) / 1000).toFixed(1)} s`,
);
