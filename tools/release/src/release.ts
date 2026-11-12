// The order of a release. Every step goes through the ports below, so each way a release can end is tested without a
// host (release.test.ts); repo.ts and host.ts are the real ones.
import { createHash } from "node:crypto";
import { journalEntry, type Outcome, type ReleaseRecord } from "./journal.ts";
import { compareCounts, formatPlan, lineDiff, planOf, toTag, type Change, type Counts, type Drift, type LiveState, type PerfState, type Plan, type PlanOptions } from "./plan.ts";

export interface Repo {
  fetchMain(): Promise<string>;
  isAncestor(tag: string, sha: string): Promise<boolean>;
  fileAt(ref: string, path: string): Promise<string>;
  changes(from: string, to: string): Promise<Change | null>;
  perfStatus(sha: string): Promise<PerfState>;
  /** With `checks`, pnpm check and sync:browser on the commit first: a failure throws before anything reaches the host. */
  build(sha: string, log: (line: string) => void, checks: boolean): Promise<void>;
}

interface Lock {
  release(): Promise<void>;
}

export interface Host {
  status(): Promise<LiveState>;
  hasImage(tag: string): Promise<boolean>;
  file(path: string): Promise<string | null>;
  /**
   * Replaces the file, keeping owner and mode, after copying it to `backup`; only while it still has the content
   * hashed `expected` (sha256, hex) and the new content passes the file's check on the host (compose.yaml against
   * rsva.env), else it throws and changes nothing.
   */
  putFile(path: string, content: string, expected: string, backup: string): Promise<void>;
  /** Null when another release holds it. */
  lock(): Promise<Lock | null>;
  dump(tag: string): Promise<string>;
  counts(): Promise<Counts>;
  now(): Promise<string>;
  switchTo(tag: string): Promise<boolean>;
  rollback(): Promise<boolean>;
  runningImage(): Promise<string>;
  bundle(): Promise<string | null>;
  errorsSince(since: string): Promise<string[]>;
}

export interface Site {
  healthy(): Promise<boolean>;
  bundle(): Promise<string | null>;
  brokenNeighbours(): Promise<string[]>;
}

export interface Ports {
  repo: Repo;
  host: Host;
  site: Site;
  log(line: string): void;
  confirm(question: string): Promise<boolean>;
  journal(entry: string, tag: string): Promise<string>;
  sleep(ms: number): Promise<void>;
  today(): Date;
}

export interface Options extends PlanOptions {
  dryRun: boolean;
}

/** repo path -> host path, for the files rsva-deploy does not carry. */
const HOST_FILES = [
  ["deploy/stand/compose.yaml", "/opt/rsva/compose.yaml"],
  ["deploy/stand/rsva-deploy", "/usr/local/sbin/rsva-deploy"],
] as const;

/** Open clients reconnect right after the restart: long enough for a broken server to show it in the log. */
const SETTLE_MS = 15_000;
/** One error may be a client's bad request; a run of them is the release. */
const ERROR_LIMIT = 3;

/** A host file the release puts, with what the plan saw there. */
interface HostFile extends Drift {
  hostPath: string;
  target: string;
  hostHash: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function driftOf(p: Ports, liveTag: string, sha: string): Promise<HostFile[]> {
  const drift = await Promise.all(
    HOST_FILES.map(async ([path, hostPath]): Promise<HostFile | null> => {
      const [target, host, live] = await Promise.all([p.repo.fileAt(sha, path), p.host.file(hostPath), p.repo.fileAt(liveTag, path).catch(() => null)]);
      if (host === target) return null;
      if (host === null) return { path, hostPath, target, hostHash: "", put: false, lines: [`${hostPath} is missing`] };
      return { path, hostPath, target, hostHash: sha256(host), put: host === live, lines: lineDiff(host, target) };
    }),
  );
  return drift.filter((d) => d !== null);
}

/** The files the plan put: each copied aside, replaced only if nobody changed it since, then read back. */
async function putFiles(p: Ports, plan: Plan): Promise<{ path: string; backup: string }[]> {
  const day = p.today().toISOString().slice(0, 10).replaceAll("-", "");
  const put = [];
  for (const d of plan.drift as HostFile[]) {
    const backup = `${d.hostPath}.bak-${day}-${plan.tag}`;
    p.log(`Putting ${d.path} on the host (copy: ${backup})`);
    await p.host.putFile(d.hostPath, d.target, d.hostHash, backup);
    if ((await p.host.file(d.hostPath)) !== d.target) throw new Error(`${d.hostPath} on the host is not main's version after putting it`);
    put.push({ path: d.hostPath, backup });
  }
  return put;
}

async function planFor(p: Ports, live: LiveState, sha: string, o: Options): Promise<Plan> {
  const [change, forward, drift, perf] = await Promise.all([
    p.repo.changes(live.tag, sha),
    p.repo.isAncestor(live.tag, sha),
    driftOf(p, live.tag, sha),
    p.repo.perfStatus(sha),
  ]);
  return planOf({ live, sha, change, forward, drift, perf }, o);
}

interface Verdict {
  failures: string[];
  warnings: string[];
  counts: Counts;
}

/** The live system against what was meant to go out: the exit code of rsva-deploy only says that /healthz answered. */
async function verify(p: Ports, tag: string, before: Counts, since: string, schema: number): Promise<Verdict> {
  await p.sleep(SETTLE_MS);
  const [image, healthy, served, built, counts, errors, neighbours] = await Promise.all([
    p.host.runningImage(),
    p.site.healthy(),
    p.site.bundle(),
    p.host.bundle(),
    p.host.counts(),
    p.host.errorsSince(since),
    p.site.brokenNeighbours(),
  ]);
  const { failures, warnings } = compareCounts(before, counts, schema);
  if (image !== `rsva:${tag}`) failures.push(`running ${image}, not rsva:${tag}`);
  if (!healthy) failures.push("public /healthz does not answer 200");
  if (!served || served !== built) failures.push(`public site serves ${served}, the image has ${built}`);
  if (errors.length) (errors.length >= ERROR_LIMIT ? failures : warnings).push(`${errors.length} errors in the server log, the first: ${errors[0]}`);
  warnings.push(...neighbours.map((n) => `neighbour ${n}`));
  return { failures, warnings, counts };
}

async function finish(p: Ports, tag: string, outcome: Outcome, record: Omit<ReleaseRecord, "outcome">): Promise<void> {
  for (const w of record.warnings) p.log(`Warning: ${w}`);
  for (const f of record.failures) p.log(`Failed: ${f}`);
  p.log(await p.journal(journalEntry({ ...record, outcome }, p.today()), tag));
}

async function ship(p: Ports, plan: Plan): Promise<number> {
  const { tag, sha, live } = plan;
  const change = plan.change as Change;
  const { migrations, commits } = change;
  if (await p.host.hasImage(tag)) p.log(`Image rsva:${tag} is already on the host: not built or checked again`);
  else await p.repo.build(sha, p.log, plan.checks);
  let dump: string | null = null;
  if (migrations.length) {
    p.log("Migrations ship: taking a dump");
    dump = await p.host.dump(tag);
    p.log(`Dump: ${dump}`);
  }
  // After the build and the dump, which may fail: the files change only for a release that goes on to the switch. A file
  // refused by its check stops the release here, before the switch.
  const files = await putFiles(p, plan);
  const before = await p.host.counts();
  const since = await p.host.now();
  const base = { from: live.tag, to: tag, commits, migrations, dump, files };

  p.log(`Switching to ${tag}`);
  if (!(await p.host.switchTo(tag))) {
    const failures = ["the server did not become healthy"];
    if (migrations.length) failures.push("its migrations may already be applied");
    await finish(p, tag, "start-failed", { ...base, counts: null, failures, warnings: [] });
    return 1;
  }

  p.log("Verifying");
  const v = await verify(p, tag, before, since, change.schema);
  const record = { ...base, counts: v.counts, failures: v.failures, warnings: v.warnings };
  if (!v.failures.length) {
    await finish(p, tag, "shipped", record);
    p.log(`Live: ${tag}. Rollback: pnpm release --rollback`);
    return 0;
  }
  if (migrations.length) {
    await finish(p, tag, "left-failing", record);
    p.log(`Not rolled back: this release applied migrations, and the older image has not seen them. Decide by hand: pnpm release --rollback, or fix forward. Dump: ${dump}`);
    return 1;
  }
  p.log(`Rolling back to ${live.tag}`);
  const back = await p.host.rollback();
  if (!back) record.failures.push(`the rollback to ${live.tag} failed too`);
  await finish(p, tag, "rolled-back", record);
  return 1;
}

/** Takes the lock, and makes sure nobody moved the live tag since the plan was shown. */
async function locked(p: Ports, liveTag: string, work: () => Promise<number>): Promise<number> {
  const lock = await p.host.lock();
  if (!lock) {
    p.log("Another release is running.");
    return 1;
  }
  try {
    const now = await p.host.status();
    if (now.tag !== liveTag) {
      p.log(`The live tag moved to ${now.tag} since the plan: run it again.`);
      return 1;
    }
    return await work();
  } finally {
    await lock.release();
  }
}

export async function release(p: Ports, o: Options): Promise<number> {
  const sha = await p.repo.fetchMain();
  const tag = toTag(sha);
  const live = await p.host.status();
  if (live.tag === tag) {
    p.log(`${tag} is already live.`);
    return 0;
  }
  const plan = await planFor(p, live, sha, o);
  p.log(formatPlan(plan));
  if (plan.blockers.length) return 1;
  if (o.dryRun) return 0;
  if (!(await p.confirm(`Release ${tag}?`))) return 1;
  return locked(p, live.tag, () => ship(p, plan));
}

export async function rollback(p: Ports, o: Pick<Options, "dryRun">): Promise<number> {
  const live = await p.host.status();
  const target = live.previous;
  if (!target) {
    p.log("There is no previous tag.");
    return 1;
  }
  const change = await p.repo.changes(target, live.tag);
  p.log(`Live ${live.tag} -> back to ${target}`);
  for (const c of change?.commits ?? []) p.log(`  undoes: ${c}`);
  if (change?.migrations.length) p.log(`Warning: the schema stays as it is. ${target} runs against migrations it has not seen: ${change.migrations.map((m) => m.file).join(", ")}`);
  if (o.dryRun) return 0;
  if (!(await p.confirm(`Roll back to ${target}?`))) return 1;
  return locked(p, live.tag, async () => {
    const before = await p.host.counts();
    const since = await p.host.now();
    const base = { from: live.tag, to: target, commits: [], migrations: [], dump: null, files: [] };
    if (!(await p.host.rollback())) {
      await finish(p, target, "manual-rollback", { ...base, counts: null, failures: ["rsva-deploy --rollback failed"], warnings: [] });
      return 1;
    }
    const v = await verify(p, target, before, since, before.migrations);
    await finish(p, target, "manual-rollback", { ...base, counts: v.counts, failures: v.failures, warnings: v.warnings });
    return v.failures.length ? 1 : 0;
  });
}

export async function status(p: Ports): Promise<number> {
  const [sha, live] = await Promise.all([p.repo.fetchMain(), p.host.status()]);
  const change = await p.repo.changes(live.tag, sha);
  p.log(`Live ${live.tag}, previous ${live.previous ?? "none"}, ${live.healthy ? "healthy" : "NOT healthy"}`);
  const tag = toTag(sha);
  if (tag === live.tag) p.log("Main is live.");
  else p.log(`Main ${tag}: ${change ? `${change.commits.length} commits ahead, ${change.migrations.length} migrations` : "the live tag is not known here"}`);
  return live.healthy ? 0 : 1;
}
