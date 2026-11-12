// Cycle rollover (PLNR-64, ADR 0049). In a project with the switch on, a cycle whose last day is over completes itself and
// its open issues move to the next cycle: one transaction, signed by the app's bot (APP_BOT), made of the same two writes the
// completion dialog sends (updateCycle freezes the summary first, then each issue's cycleId changes, so every move is in
// the issue's activity and the completed cycle lists what moved on).
//
// The sweep looks at state, not at the clock: "over and not completed" is what it finds, at the server's start and every
// hour (main.ts). A server that was off on the day catches up on its first run; nothing depends on being awake at
// midnight. Two sweeps at once (two processes during a release) do nothing twice: the cycle row is locked and read again
// in the transaction, and a completed one is left alone. Days are UTC, as everywhere on the server.
//
// With no next cycle ahead the cycle stays ended, its issues with it, and it waits for a person or for a next cycle to be
// planned (owner's choice, 2026-11-02): completing it would freeze the issues in a cycle that takes nothing back. A cycle
// with nothing open completes either way. The next cycle is the first ahead with dates, as the dialog and the agents' API
// pick it (`cyclesAhead`): a cycle that is over itself is no target, so after a long gap the issues skip to a live one.
import { cyclesAhead } from "@rsva/query";
import { APP_BOT, type CycleSummary } from "@rsva/schema/models";
import { and, asc, eq, isNull, lt, notInArray, sql as dsql } from "drizzle-orm";
import { db, schema, type Tx } from "../db.ts";
import { asBot } from "./bots.ts";
import { todayUtc, updateCycle } from "./cycles.ts";
import type { Pending } from "./tx-error.ts";
import { updateIssue } from "./write.ts";

const { project, cycle, issue, workflowState } = schema;

/**
 * Completes the cycles that are due and moves their open issues on, oldest first, each in its own transaction: one that
 * fails (a refusal, a lost connection) leaves the others done and is tried again next time. Returns how many it completed.
 */
export async function sweepCycles(onError: (e: unknown, cycleId: string) => void, today = todayUtc()): Promise<number> {
  const due = await db
    .select({ id: cycle.id, workspaceId: cycle.workspaceId })
    .from(cycle)
    .innerJoin(project, eq(project.id, cycle.projectId))
    .where(and(eq(project.cycleRollover, true), isNull(project.archivedAt), isNull(cycle.completedAt), lt(cycle.endDate, today)))
    .orderBy(asc(cycle.endDate), asc(cycle.id));
  let completed = 0;
  for (const c of due) {
    try {
      const r = await asBot(c.workspaceId, APP_BOT, (tx, bot) => rollOver(tx, c.workspaceId, bot, c.id, today));
      if (r.actions.some((a) => a.m === "Cycle")) completed++;
    } catch (e) {
      onError(e, c.id);
    }
  }
  return completed;
}

async function rollOver(tx: Tx, workspaceId: string, bot: string, id: string, today: string): Promise<Pending[]> {
  // Read again under the lock: another sweep or a person may have completed it, or the switch went off, since the list.
  const [c] = await tx.select().from(cycle).where(eq(cycle.id, id)).for("update");
  if (!c || c.completedAt || !c.endDate || c.endDate >= today) return [];
  const [p] = await tx.select({ on: project.cycleRollover, archivedAt: project.archivedAt }).from(project).where(eq(project.id, c.projectId));
  if (!p?.on || p.archivedAt) return [];
  const next = cyclesAhead(await tx.select().from(cycle).where(eq(cycle.projectId, c.projectId)), c.id, today).find((x) => x.startDate);
  if (!next && (await hasOpen(tx, c.id))) return [];
  const done = await updateCycle(tx, workspaceId, bot, id, { completedAt: new Date().toISOString() });
  if (!done) return [];
  const out: Pending[] = [done];
  // The summary's open issues are the ones to move. Without a next cycle there are none, unless one came in since
  // hasOpen: it stays, as after a completion that moves nothing.
  if (!next) return out;
  for (const issueId of [...(done.d!.summary as CycleSummary).open].sort()) {
    const moved = await updateIssue(tx, workspaceId, bot, false, issueId, { cycleId: next.id });
    if (moved) out.push(moved);
  }
  return out;
}

/** Whether the cycle has an issue that is not done or cancelled, as the summary counts open ones. */
async function hasOpen(tx: Tx, cycleId: string): Promise<boolean> {
  const [row] = await tx
    .select({ x: dsql`1` })
    .from(issue)
    .innerJoin(workflowState, eq(workflowState.id, issue.stateId))
    .where(and(eq(issue.cycleId, cycleId), isNull(issue.deletedAt), notInArray(workflowState.group, ["completed", "cancelled"])))
    .limit(1);
  return !!row;
}
