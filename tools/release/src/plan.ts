// What a release would change and whether it may go: pure functions over facts gathered by repo.ts and host.ts.

export interface LiveState {
  tag: string;
  previous: string | null;
  healthy: boolean;
}

export interface Migration {
  file: string;
  /** Statements a rollback of the image cannot survive. */
  risky: string[];
}

export interface Change {
  commits: string[];
  files: string[];
  /** Added since the live tag. A migration of a release that rolled back is here too, though it is already applied. */
  migrations: Migration[];
  /** Migrations the target commit has in all: what the database holds once its server has started. */
  schema: number;
  protocol: { from: number; to: number } | null;
}

/** The Perf workflow on a commit, with a link when it failed. A report: nothing here blocks a release (ADR 0023). */
export type PerfState = "ok" | "running" | "none" | { failed: string };

/**
 * A file the host holds apart from the image: rsva-deploy changes only the tag, so these do not follow the image.
 * The release puts the main version on the host itself when the host still has the live commit's version; a host copy
 * that is neither was edited there by hand, and the release stops rather than overwrite it.
 */
export interface Drift {
  path: string;
  lines: string[];
  /** The host has the live commit's version: the release replaces it, keeping a copy. */
  put: boolean;
}

export interface Facts {
  live: LiveState;
  sha: string;
  /** Null when the live tag is not a commit this repository knows. */
  change: Change | null;
  /** The live tag is an ancestor of the target: the release only moves forward. */
  forward: boolean;
  drift: Drift[];
  perf: PerfState;
}

export interface PlanOptions {
  skipChecks: boolean;
  allowDiverged: boolean;
  allowDestructive: boolean;
}

export interface Plan extends Facts {
  tag: string;
  /** pnpm check and sync:browser on the commit before its image goes to the host (ADR 0035). */
  checks: boolean;
  blockers: string[];
  notes: string[];
}

export interface Counts {
  issues: number;
  projects: number;
  comments: number;
  lastAction: number;
  migrations: number;
}

export const toTag = (sha: string): string => sha.slice(0, 9);

/** `rsva-deploy --status`: the tag line, then the body of /healthz (nothing when the server does not answer). */
export function parseStatus(out: string): LiveState {
  const m = /^tag (\S+), previous (\S+)$/m.exec(out);
  if (!m) throw new Error(`unexpected rsva-deploy --status output: ${out}`);
  return { tag: m[1] as string, previous: m[2] === "none" ? null : (m[2] as string), healthy: out.includes('"ok":true') };
}

const RISKY = /\b(DROP\s+(TABLE|COLUMN|TYPE|SCHEMA)|TRUNCATE|DELETE\s+FROM|RENAME\s+(TO|COLUMN)|ALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE)\b/i;

/** Lines of a migration the previous image may not run against. */
export const riskyLines = (sql: string): string[] =>
  sql.split("\n").map((l) => l.trim()).filter((l) => RISKY.test(l));

/** Entries of drizzle's journal: the list its migrator applies. */
export const migrationCount = (journal: string): number => (JSON.parse(journal) as { entries: unknown[] }).entries.length;

export const protocolOf = (source: string): number | null => {
  const m = /PROTOCOL_VERSION = (\d+)/.exec(source);
  return m ? Number(m[1]) : null;
};

/** The paths the image is built from: every COPY of the Dockerfile but its destination. */
export function contextOf(dockerfile: string): string[] {
  const copies = dockerfile.split("\n").filter((l) => l.startsWith("COPY "));
  return ["deploy/stand/Dockerfile", ...copies.flatMap((l) => l.split(/\s+/).slice(1, -1))];
}

/** Lines only the host has (-) and only the target has (+): enough to see what a stale file lacks. */
export function lineDiff(host: string, target: string): string[] {
  const a = host.split("\n");
  const b = target.split("\n");
  const added = new Set(b);
  const removed = new Set(a);
  return [...a.filter((l) => !added.has(l)).map((l) => `- ${l}`), ...b.filter((l) => !removed.has(l)).map((l) => `+ ${l}`)];
}

const SHIPPED = /^(apps\/(server|web)\/|packages\/|deploy\/|pnpm-lock\.yaml$)/;

export function planOf(f: Facts, o: PlanOptions): Plan {
  const blockers: string[] = [];
  const notes: string[] = [];
  const { change, live } = f;
  if (!live.healthy) notes.push(`The live server does not answer /healthz.`);
  if (!change) blockers.push(`The live tag ${live.tag} is not a commit known here: the plan cannot be worked out. Use the manual steps in docs/stand-rsva.md.`);
  else if (!f.forward && !o.allowDiverged) blockers.push(`Main does not contain the live tag ${live.tag}, so this would drop what is live. --allow-diverged ships it anyway.`);
  for (const d of f.drift) {
    const diff = d.lines.map((l) => `    ${l}`).join("\n");
    if (d.put) notes.push(`${d.path} changed since the live tag: the release puts it on the host before the switch, keeping a copy:\n${diff}`);
    else blockers.push(`${d.path} on the host is neither the live commit's version nor main's: edited there by hand? Bring the change into the repository, or put main's version on the host (docs/stand-rsva.md):\n${diff}`);
  }
  const risky = change?.migrations.filter((m) => m.risky.length) ?? [];
  if (risky.length && !o.allowDestructive) {
    blockers.push(`Migrations that an older image may not survive, so a rollback would not work. --allow-destructive ships them anyway:\n${risky.flatMap((m) => m.risky.map((l) => `    ${m.file}: ${l}`)).join("\n")}`);
  }
  if (change && !change.files.some((p) => SHIPPED.test(p))) notes.push(`Nothing that reaches the server changed: this would only restart it.`);
  return { ...f, tag: toTag(f.sha), checks: !o.skipChecks, blockers, notes };
}

const perfLine = (p: PerfState) =>
  p === "ok" ? "Perf: ok" : p === "running" ? "Perf: still running, not blocking" : p === "none" ? "Perf: no run for this commit" : `Perf: failed, not blocking: ${p.failed}`;

export function formatPlan(p: Plan): string {
  const { change } = p;
  const checks = p.checks ? "pnpm check and sync:browser before the build" : "none, --skip-checks";
  const lines = [`Live ${p.live.tag} -> ${p.tag} (checks: ${checks})`, perfLine(p.perf)];
  if (change) {
    lines.push(`Commits (${change.commits.length}):`, ...change.commits.map((c) => `  ${c}`));
    lines.push(change.migrations.length ? `Migrations: ${change.migrations.map((m) => m.file).join(", ")} (a dump is taken first, no automatic rollback)` : `Migrations: none`);
    if (change.protocol) lines.push(`Protocol ${change.protocol.from} -> ${change.protocol.to}: open clients reload once`);
  }
  lines.push(...p.notes.map((n) => `Note: ${n}`), ...p.blockers.map((b) => `Blocked: ${b}`));
  return lines.join("\n");
}

export const parseCounts = (row: string): Counts => {
  const [issues, projects, comments, lastAction, migrations] = row.trim().split("|").map(Number);
  if (migrations === undefined || [issues, projects, comments, lastAction, migrations].some((n) => !Number.isFinite(n))) {
    throw new Error(`unexpected counts: ${row}`);
  }
  return { issues, projects, comments, lastAction, migrations } as Counts;
};

/** Rows may go by themselves (a comment deleted meanwhile), so only a drop above this share counts as lost data. */
const LOST_SHARE = 0.01;

/**
 * `schema`: migrations expected in the database. A total, not before + new: a release that rolled back leaves its
 * migrations applied, and its repeat would come up one short.
 */
export function compareCounts(before: Counts, after: Counts, schema: number): { failures: string[]; warnings: string[] } {
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const key of ["issues", "projects", "comments"] as const) {
    const drop = before[key] - after[key];
    if (drop <= 0) continue;
    (drop > before[key] * LOST_SHARE ? failures : warnings).push(`${key}: ${before[key]} -> ${after[key]}`);
  }
  if (after.lastAction < before.lastAction) failures.push(`last sync_action went back: ${before.lastAction} -> ${after.lastAction}`);
  if (after.migrations !== schema) failures.push(`migrations: ${schema} expected, ${after.migrations} applied`);
  return { failures, warnings };
}
