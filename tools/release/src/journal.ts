// The line about a release in the host's journal. The journal is a Russian document (CLAUDE.md), so this text is too.
import { execFile } from "node:child_process";
import { appendFile, access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Counts, Migration } from "./plan.ts";

const exec = promisify(execFile);

export type Outcome =
  /** Live and verified. */
  | "shipped"
  /** rsva-deploy did not see it healthy and brought the previous tag back by itself. */
  | "start-failed"
  /** Verification failed and the previous tag came back. */
  | "rolled-back"
  /** Verification failed, but the release brought migrations: left as it is for a person. */
  | "left-failing"
  /** `pnpm release --rollback`. */
  | "manual-rollback";

export interface ReleaseRecord {
  outcome: Outcome;
  from: string;
  to: string;
  commits: string[];
  migrations: Migration[];
  dump: string | null;
  /** Host files the release replaced (compose.yaml, rsva-deploy), each with its copy. */
  files: { path: string; backup: string }[];
  counts: Counts | null;
  failures: string[];
  warnings: string[];
}

export const moscow = (at: Date): string => `${at.toLocaleString("sv-SE", { timeZone: "Europe/Moscow" }).slice(0, 16)} MSK`;

function headline(r: ReleaseRecord): string {
  switch (r.outcome) {
    case "shipped": return `**планировщик обновлён \`${r.from}\` → \`${r.to}\`**`;
    case "start-failed": return `**выкладка планировщика \`${r.to}\` не поднялась, \`rsva-deploy\` вернул \`${r.from}\`**`;
    case "rolled-back": return `**выкладка планировщика \`${r.to}\` не прошла проверку и откатилась на \`${r.from}\`**`;
    case "left-failing": return `**планировщик обновлён \`${r.from}\` → \`${r.to}\`, проверка после выкладки не прошла, в выпуске миграции, откат не запускался**`;
    case "manual-rollback": return `**планировщик откатан \`${r.from}\` → \`${r.to}\`**`;
  }
}

export function journalEntry(r: ReleaseRecord, at: Date): string {
  const command = r.outcome === "manual-rollback" ? "pnpm release --rollback" : "pnpm release";
  const what = r.commits.length ? `: ${r.commits.join("; ")}` : "";
  const parts = [`- ${moscow(at)} — ${headline(r)} (\`${command}\`)${what}.`];
  parts.push(r.migrations.length ? `Миграции ${r.migrations.map((m) => `\`${m.file}\``).join(", ")}, перед выкладкой дамп \`${r.dump}\`.` : "Миграций нет, дамп не снимался.");
  for (const f of r.files) parts.push(`\`${f.path}\` заменён на версию из репозитория, копия \`${f.backup}\`.`);
  if (r.failures.length) parts.push(`Проверка: ${r.failures.join("; ")}.`);
  if (r.warnings.length) parts.push(`Предупреждения: ${r.warnings.join("; ")}.`);
  if (r.counts) {
    const c = r.counts;
    parts.push(`После: задач ${c.issues}, проектов ${c.projects}, комментариев ${c.comments}, последняя запись \`sync_action\` ${c.lastAction}, миграций ${c.migrations}.`);
  }
  if (r.outcome === "shipped") parts.push(`Откат: \`pnpm release --rollback\` (образ \`rsva:${r.from}\` на месте).`);
  return parts.join(" ");
}

/** RSVA_JOURNAL_REPO: a git repository, RSVA_JOURNAL_FILE: a file in it (default `journal.md`). Unset, the line is only printed. */
const JOURNAL = process.env.RSVA_JOURNAL_FILE || "journal.md";

/** Appends the line to the journal file of RSVA_JOURNAL_REPO and pushes it. Says so when it cannot. */
export async function writeJournal(entry: string, tag: string): Promise<string> {
  const repo = process.env.RSVA_JOURNAL_REPO ?? "";
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);
  const byHand = (why: string) => `Journal not written (${why}), add it to the journal by hand:\n${entry}`;
  if (!repo) return byHand("RSVA_JOURNAL_REPO is not set");
  try {
    await access(join(repo, JOURNAL));
    const { stdout } = await git("status", "--porcelain", "--", JOURNAL);
    if (stdout.trim()) return byHand(`${JOURNAL} has uncommitted changes`);
    await appendFile(join(repo, JOURNAL), `${entry}\n`);
    await git("commit", "-q", "-m", `rsva: release ${tag}`, "--", JOURNAL);
    await git("pull", "-q", "--rebase", "--autostash");
    await git("push", "-q");
    return `Journal: ${repo}/${JOURNAL}, pushed.`;
  } catch (e) {
    return byHand(e instanceof Error ? e.message.split("\n")[0] as string : String(e));
  }
}
