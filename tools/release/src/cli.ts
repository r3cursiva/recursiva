#!/usr/bin/env node
// `pnpm release`: ships origin/main to app.rsva.dev. ADR 0019, docs/stand-rsva.md.
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { publicSite, sshHost } from "./host.ts";
import { writeJournal } from "./journal.ts";
import { release, rollback, status, type Ports } from "./release.ts";
import { gitRepo } from "./repo.ts";
import { confirm } from "./run.ts";

const HELP = `pnpm release [options]      ship origin/main to app.rsva.dev

  --dry-run             show the plan and what blocks it; change nothing
  --yes                 do not ask before releasing (needed without a terminal)
  --status              what is live, how far main is ahead
  --rollback            back to the previous tag (--dry-run shows what it undoes)
  --skip-checks         release without pnpm check and sync:browser on the commit
  --allow-diverged      release although main does not contain the live tag
  --allow-destructive   release migrations an older image may not survive
  -h, --help            this text`;

const { values: v } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    status: { type: "boolean", default: false },
    rollback: { type: "boolean", default: false },
    "skip-checks": { type: "boolean", default: false },
    "allow-diverged": { type: "boolean", default: false },
    "allow-destructive": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const ports: Ports = {
  repo: gitRepo(import.meta.dirname),
  host: sshHost,
  site: publicSite,
  log: (line) => console.log(line),
  confirm: (question) => confirm(question, v.yes),
  journal: writeJournal,
  sleep: (ms) => sleep(ms),
  today: () => new Date(),
};

function main(): Promise<number> {
  if (v.help) {
    console.log(HELP);
    return Promise.resolve(0);
  }
  if (v.status) return status(ports);
  if (v.rollback) return rollback(ports, { dryRun: v["dry-run"] });
  return release(ports, { dryRun: v["dry-run"], skipChecks: v["skip-checks"], allowDiverged: v["allow-diverged"], allowDestructive: v["allow-destructive"] });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
