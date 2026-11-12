// The one store the screens read: a facade over the sync engine (packages/sync) of the workspace in the URL.
//
// Switching workspaces swaps the engine under the facade instead of reloading the page. The swap runs inside the
// router's action, before anything renders the new URL; App then remounts the screens under the workspace's key, so
// every observer subscribes to the new engine. Caches that outlive a render (keepAlive computeds) are kept per engine
// with perEngine(): switching back to a live engine finds them warm, and an evicted engine takes them along.
//
// Considered (2026-10-28, perf:net, project switch): a full page load repeats the shell's boot and drops every open
// engine; an observable box under the facade needs no remount but tracks every store read, and made switching between
// projects 3 ms slower (38 vs 35 ms) for an action taken a few times a day.
import { RESERVED_SLUGS, WORKSPACE_SLUG } from "@rsva/schema/models";
import { createSyncStore, copySlug, queued, type SyncEngine, type SyncStore } from "@rsva/sync";
import { observable, observe, runInAction, when } from "mobx";
import { account } from "./account.ts";
import { readLocal, writeLocal } from "./lib/local-storage.ts";
import { flashRows } from "./lib/row-flash.ts";
import { checkForNewVersion, holdReload, reloadForNewVersion } from "./lib/new-version.ts";
import { signedIn } from "./lib/signed-in.ts";
import { isAccountRoute, routeProject, router } from "./router.ts";

/** No workspace known: the address names none and this device has no list yet. App.tsx asks the server's list then. */
export const NO_WS = "";

/**
 * What "/" and the pages outside a workspace (/new) open: the first workspace of the list saved last time
 * (workspaces.ts keeps it), else NO_WS. No named default: nobody's workspace is everybody's start.
 */
const FALLBACK_WS = ((): string => {
  const list = readLocal("rsva:workspaces");
  const first: unknown = Array.isArray(list) ? (list[0] as { slug?: unknown } | undefined)?.slug : undefined;
  return typeof first === "string" ? first : NO_WS;
})();

const LAST_WS_KEY = "rsva:last-workspace";

/** Only an address a workspace could have: "/settings/x" or a malformed one is no workspace to come back to. */
const mayBeWorkspace = (ws: string): boolean => WORKSPACE_SLUG.test(ws) && !RESERVED_SLUGS.has(ws);

/**
 * The workspace the person's own settings pages keep beside them (/settings/…, no workspace in the address, PLNR-225):
 * the last one an address named, saved so a reload stays in it. Updated before the engine follows a new path (below).
 */
let lastWs = ((): string => {
  const saved = readLocal(LAST_WS_KEY);
  return typeof saved === "string" && mayBeWorkspace(saved) ? saved : FALLBACK_WS;
})();

function rememberWs(): void {
  const ws = router.route.ws;
  if (!ws || ws === lastWs || !mayBeWorkspace(ws)) return;
  lastWs = ws;
  writeLocal(LAST_WS_KEY, ws);
}
rememberWs();

/** Slug of the workspace on screen. */
export const currentWs = (): string => router.route.ws ?? (isAccountRoute(router.route) ? lastWs : FALLBACK_WS);

/**
 * Engines kept open, the current one last. The previous workspace stays loaded and live, so switching back is instant;
 * older ones are saved to IndexedDB and closed, and come back from there.
 */
const KEEP = 2;
const engines = new Map<string, SyncEngine>();

/** Workspaces whose engines stay open past KEEP, with how many holders each: My work reads every workspace (PLNR-41). */
const held = new Map<string, number>();

/** Moves when an engine opens or closes: what reads `openEngines` follows the set, not only each engine. */
const opened = observable.box(0);
const bump = () => runInAction(() => opened.set(opened.get() + 1));

/**
 * The engines open now, the one on screen among them (RSVA-613). A workspace whose engine is closed counts nothing in
 * the inbox's count until it opens again; the inbox screen holds them all.
 */
function openEngines(): SyncEngine[] {
  opened.get();
  return [...engines.values()];
}

/** The inbox's unread rows in every open workspace: the count beside Inbox in the sidebar and the tab bar. */
export const inboxUnread = (): number => openEngines().reduce((n, e) => n + e.inbox.unread, 0);

function open(slug: string): SyncEngine {
  // A cold snapshot sends the open project's issues first.
  const key = slug === router.route.ws ? routeProject(router.route) : null;
  const e = createSyncStore({
    workspace: slug,
    ...(key ? { project: key } : {}),
    onAccount: (s) => account.fromSnapshot(s),
    onReconnect: checkForNewVersion,
    onOthersChange: flashRows,
    reload: reloadForNewVersion,
  });
  // Signed out, the engine stays idle: the sign-in screen shows and a successful sign-in reloads the page. An invite
  // link opens no workspace: joining ends in a page load of the joined one. Nor does NO_WS: App.tsx moves to a real one.
  if (slug !== NO_WS && signedIn() && router.route.name !== "join") void e.start();
  // After the caller has put it in `engines`: a reaction runs only once the current action ends.
  queueMicrotask(bump);
  return e;
}

/**
 * What the person wrote is still in it: changes the server has not confirmed (issue edits, saved views, inbox marks), or
 * a refusal nobody has read.
 */
const unsaved = (e: SyncEngine): boolean => e.pendingCount > 0 || e.unconfirmedOutbox || e.lastRejection !== null;

// A reload for a new version waits for those too: the queue on disk would carry a change over, but not one still being
// written there; views and marks reach the disk only with the snapshot, a moment later, and not at all if that write
// fails (PLNR-261); a refusal on screen would go unread.
holdReload(() => [...engines.values()].some(unsaved));

/** Closes the oldest engines beyond KEEP, except held ones and `keep` (the one on screen). */
function evict(keep: string): void {
  let excess = engines.size - KEEP;
  for (const [s, old] of engines) {
    if (excess <= 0) break;
    // Its unsent changes need it to go on: closed, they would wait until someone happened to open that workspace. Nor
    // one with a refusal nobody has read.
    if (s === keep || held.has(s) || unsaved(old)) continue;
    engines.delete(s);
    bump();
    excess--;
    void old.persist().finally(() => old.dispose());
  }
}

function engineFor(slug: string): SyncEngine {
  const e = engines.get(slug) ?? open(slug);
  engines.delete(slug);
  engines.set(slug, e);
  evict(slug);
  return e;
}

/**
 * The engines of these workspaces, opened where needed and kept open until `release`: a warm one starts from IndexedDB
 * with no request, a cold one streams its snapshot. Held engines keep their place in the eviction order.
 */
export function holdEngines(slugs: readonly string[]): { engines: Map<string, SyncEngine>; release: () => void } {
  const out = new Map<string, SyncEngine>();
  for (const slug of slugs) {
    let e = engines.get(slug);
    if (!e) engines.set(slug, (e = open(slug)));
    held.set(slug, (held.get(slug) ?? 0) + 1);
    out.set(slug, e);
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const slug of slugs) {
      const n = held.get(slug)! - 1;
      if (n) held.set(slug, n);
      else held.delete(slug);
    }
    evict(current.slug);
  };
  return { engines: out, release };
}

let current = engineFor(currentWs());
// Synchronous: runs inside the router's action, so no render sees the new path with the old engine.
observe(router, "path", () => {
  rememberWs();
  const slug = currentWs();
  if (current.slug !== slug) current = engineFor(slug);
});

/**
 * Every member forwards to the current engine. A class, not a Proxy: list rows read the store in loops, and a Proxy's
 * trap with a bound-method lookup costs on every read. Measured as fast as the engine itself (project switch 36 ms,
 * the engine without a facade 34-38 ms). `implements` keeps it complete when the interface grows.
 */
class Facade implements SyncStore {
  get status() { return current.status; }
  get error() { return current.error; }
  get errorCode() { return current.errorCode; }
  get connection() { return current.connection; }
  get lastSyncId() { return current.lastSyncId; }
  get link() { return current.link; }
  get pendingCount() { return current.pendingCount; }
  get saveState() { return current.saveState; }
  get unsafe() { return current.unsafe; }
  get workspace() { return current.workspace; }
  get me() { return current.me; }
  get role() { return current.role; }
  get users() { return current.users; }
  get projects() { return current.projects; }
  get states() { return current.states; }
  get labels() { return current.labels; }
  get cycles() { return current.cycles; }
  get issues() { return current.issues; }
  get inbox() { return current.inbox; }
  get views() { return current.views; }
  // Any open engine's: one sending a queue in the background has nobody else to tell.
  get lastRejection() {
    for (const e of [current, ...engines.values()]) if (e.lastRejection) return e.lastRejection;
    return null;
  }
  measureLink: SyncStore["measureLink"] = () => current.measureLink();
  projectList: SyncStore["projectList"] = () => current.projectList();
  projectByKey: SyncStore["projectByKey"] = (key) => current.projectByKey(key);
  statesOf: SyncStore["statesOf"] = (projectId) => current.statesOf(projectId);
  labelsOf: SyncStore["labelsOf"] = (projectId) => current.labelsOf(projectId);
  cyclesOf: SyncStore["cyclesOf"] = (projectId) => current.cyclesOf(projectId);
  issuesInCycle: SyncStore["issuesInCycle"] = (cycleId) => current.issuesInCycle(cycleId);
  issuesOf: SyncStore["issuesOf"] = (projectId, shelf) => current.issuesOf(projectId, shelf);
  activeCount: SyncStore["activeCount"] = (projectId) => current.activeCount(projectId);
  hasUrgent: SyncStore["hasUrgent"] = (projectId) => current.hasUrgent(projectId);
  lastChange: SyncStore["lastChange"] = (projectId) => current.lastChange(projectId);
  hasOverdue: SyncStore["hasOverdue"] = (projectId, today) => current.hasOverdue(projectId, today);
  subIssuesOf: SyncStore["subIssuesOf"] = (issueId, all) => current.subIssuesOf(issueId, all);
  relationsOf: SyncStore["relationsOf"] = (issueId) => current.relationsOf(issueId);
  isBlocked: SyncStore["isBlocked"] = (issue) => current.isBlocked(issue);
  isBlocking: SyncStore["isBlocking"] = (issue) => current.isBlocking(issue);
  hasLink: SyncStore["hasLink"] = (issue) => current.hasLink(issue);
  attachmentsOf: SyncStore["attachmentsOf"] = (issueId) => current.attachmentsOf(issueId);
  githubOf: SyncStore["githubOf"] = (issueId) => current.githubOf(issueId);
  addRelation: SyncStore["addRelation"] = (issueId, type, otherId) => current.addRelation(issueId, type, otherId);
  removeRelation: SyncStore["removeRelation"] = (issueId, otherId) => current.removeRelation(issueId, otherId);
  addLink: SyncStore["addLink"] = (issueId, url, title) => current.addLink(issueId, url, title);
  updateLink: SyncStore["updateLink"] = (id, patch) => current.updateLink(id, patch);
  removeLink: SyncStore["removeLink"] = (id) => current.removeLink(id);
  addFile: SyncStore["addFile"] = (issueId, file, name) => current.addFile(issueId, file, name);
  mayDelete: SyncStore["mayDelete"] = (issue) => current.mayDelete(issue);
  issueByKey: SyncStore["issueByKey"] = (key) => current.issueByKey(key);
  issueKey: SyncStore["issueKey"] = (issue) => current.issueKey(issue);
  isPending: SyncStore["isPending"] = (id, model) => current.isPending(id, model);
  updateIssue: SyncStore["updateIssue"] = (id, patch) => current.updateIssue(id, patch);
  updateIssues: SyncStore["updateIssues"] = (patches) => current.updateIssues(patches);
  purgeIssue: SyncStore["purgeIssue"] = (id) => current.purgeIssue(id);
  moveIssues: SyncStore["moveIssues"] = (ids, projectId) => current.moveIssues(ids, projectId);
  createIssue: SyncStore["createIssue"] = (projectId, set, doc) => current.createIssue(projectId, set, doc);
  description: SyncStore["description"] = (issueId) => current.description(issueId);
  updateDescription: SyncStore["updateDescription"] = (issueId, doc, seen) => current.updateDescription(issueId, doc, seen);
  feed: SyncStore["feed"] = (issueId) => current.feed(issueId);
  projectHistory: SyncStore["projectHistory"] = (projectId, level) => current.projectHistory(projectId, level);
  addComment: SyncStore["addComment"] = (issueId, body, parentId) => current.addComment(issueId, body, parentId);
  editComment: SyncStore["editComment"] = (id, body) => current.editComment(id, body);
  deleteComment: SyncStore["deleteComment"] = (id) => current.deleteComment(id);
  toggleReaction: SyncStore["toggleReaction"] = (issueId, commentId, emoji) => current.toggleReaction(issueId, commentId, emoji);
  clearRejection: SyncStore["clearRejection"] = () => {
    for (const e of [current, ...engines.values()]) e.clearRejection();
  };
  archivedProjects: SyncStore["archivedProjects"] = () => current.archivedProjects();
  updateWorkspace: SyncStore["updateWorkspace"] = (patch) => current.updateWorkspace(patch);
  setMemberRole: SyncStore["setMemberRole"] = (userId, role) => current.setMemberRole(userId, role);
  removeMember: SyncStore["removeMember"] = (userId) => current.removeMember(userId);
  moveProject: SyncStore["moveProject"] = (id, index) => current.moveProject(id, index);
  createProject: SyncStore["createProject"] = (set) => current.createProject(set);
  updateProject: SyncStore["updateProject"] = (id, patch) => current.updateProject(id, patch);
  createState: SyncStore["createState"] = (projectId, name, group) => current.createState(projectId, name, group);
  updateState: SyncStore["updateState"] = (id, patch) => current.updateState(id, patch);
  deleteState: SyncStore["deleteState"] = (id, moveTo) => current.deleteState(id, moveTo);
  createLabel: SyncStore["createLabel"] = (projectId, name, color) => current.createLabel(projectId, name, color);
  updateLabel: SyncStore["updateLabel"] = (id, patch) => current.updateLabel(id, patch);
  deleteLabel: SyncStore["deleteLabel"] = (id) => current.deleteLabel(id);
  createCycle: SyncStore["createCycle"] = (projectId, set) => current.createCycle(projectId, set);
  updateCycle: SyncStore["updateCycle"] = (id, patch) => current.updateCycle(id, patch);
  completeCycle: SyncStore["completeCycle"] = (id, moveTo, keep) => current.completeCycle(id, moveTo, keep);
  deleteCycle: SyncStore["deleteCycle"] = (id) => current.deleteCycle(id);
}

export const store: SyncStore = new Facade();

/** The engine on screen now: what is saved on leaving a workspace must not go to the next one. */
export const currentEngine = (): SyncEngine => current;

/** Changes unsent on this device, in every workspace: what signing out would delete. */
export async function unsentChanges(): Promise<number> {
  const dbs = await indexedDB.databases?.().catch(() => []);
  const closed = new Set((dbs ?? []).map((d) => copySlug(d.name)).filter((slug) => slug !== null && !engines.has(slug)));
  const counts = await Promise.all([...closed].map((slug) => queued(indexedDB, slug!).catch(() => 0)));
  return [...engines.values()].reduce((n, e) => n + e.pendingCount, 0) + counts.reduce((a, b) => a + b, 0);
}

/** This tab's open engines whose copy or queue is that person's: what signing them in again has to keep (auth.ts). */
export const enginesOf = (userId: string): SyncEngine[] => [...engines.values()].filter((e) => e.belongsTo(userId));

/** Saves and closes every engine: their databases can then be deleted (sign-out). */
export async function closeEngines(): Promise<void> {
  const all = [...engines.values()];
  engines.clear();
  await Promise.all(all.map((e) => e.persist().finally(() => e.dispose())));
}

/** A value made once per engine: module caches of computeds that read the store must not outlive their engine. */
export function perEngine<T>(create: () => T): () => T {
  const values = new WeakMap<SyncEngine, T>();
  return () => {
    let v = values.get(current);
    if (v === undefined) values.set(current, (v = create()));
    return v;
  };
}

/**
 * Changes left unsent in another workspace (offline there, and the tab closed) would wait until someone opened it: an
 * engine of each such workspace runs until its queue is empty.
 */
async function sendOtherQueues(): Promise<void> {
  const dbs = await indexedDB.databases?.().catch(() => []);
  for (const slug of new Set((dbs ?? []).map((d) => copySlug(d.name)))) {
    if (!slug || slug === current.slug || !(await queued(indexedDB, slug).catch(() => 0))) continue;
    const { engines: held, release } = holdEngines([slug]);
    const e = held.get(slug)!;
    void when(() => e.status !== "loading" && (e.pendingCount === 0 || e.errorCode !== null)).then(release);
  }
}
if (signedIn()) void when(() => store.connection === "online").then(sendOtherQueues);

// Mark for the perf checks (tools/perf): the socket is up. Data may be on screen long before, from IndexedDB.
void when(() => store.connection === "online").then(() => performance.mark("rsva:hello"));

// Dev only: the store from the console and from Playwright checks (`rsva.updateIssue(...)`).
if (import.meta.env.DEV) Object.assign(globalThis, { rsva: store });
