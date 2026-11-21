// The agents started from this Mac and their state on the list's rows, read locally every two seconds; a run whose pull
// request is merged is cleaned up: its session, its clone (kept a week in the TUI's trash) and its tokens. Each session's
// run on the server is tended on the way (agent-run.ts): renewed while the session lives, failed when it ends live.
import { join } from "node:path";
import type { SyncEngine } from "@rsva/sync";
import { errorText } from "@rsva/schema/util";
import { sessionCalls, Tending, tendedText } from "./agent-run.ts";
import { exec } from "./commands.ts";
import { agentStates, cleanUp, rexSessions, Runs, type Config } from "./dispatch.ts";
import type { Seg } from "./widgets.ts";
import type { AgentOn } from "./home-view.ts";

/** How often the agents' state is read: `claude agents` and `rex ls`, both local. */
const AGENTS_MS = 2000;

export interface AgentsHost {
  store: SyncEngine;
  config: Config;
  /** The rows' agents, by issue key. */
  set(agents: ReadonlyMap<string, AgentOn>): void;
  /** Their number now: none listed and no runs, nothing is asked. */
  size(): number;
  say(message: Seg[]): void;
}

/** Starts reading; the function it returns stops it. */
export function watchAgents(host: AgentsHost): () => void {
  const runs = new Runs();
  /** Runs being cleaned up, or left after a try: each is tried once while the TUI runs, unless its agent was busy. */
  const cleaning = new Set<string>();
  const tending = new Tending();
  const read = async () => {
    // Without runs nothing else is asked: no claude or rex process every two seconds while the TUI just shows issues.
    const list = await runs.all();
    if (!list.length && !host.size()) return;
    const [live, states] = list.length ? await Promise.all([rexSessions(exec), agentStates(exec)]) : [new Set<string>(), new Map<string, string>()];
    const next = new Map<string, AgentOn>();
    for (const r of list) {
      const st = live.has(r.rexSession) ? states.get(r.sessionId) : undefined;
      const state = !live.has(r.rexSession) ? "done" : st === "busy" ? "running" : st === "blocked" ? "waits" : "idle";
      next.set(r.key, { state, model: r.executor ? `${r.model}+${r.executor}` : r.model, startedAt: r.startedAt });
    }
    host.set(next);
    for (const r of list) {
      if (!r.claim) continue;
      const settings = join(host.config.runs, `${r.sessionId}.json`);
      // A call that failed is tried again later (Tending); what a look did is said when there is something to say.
      void tending
        .look(r.key, r.claim, r.startedAt, live.has(r.rexSession), () => sessionCalls(settings))
        .then((t) => {
          const said = t && tendedText(r.key, t);
          if (said) host.say([[said, { fg: "error" }]]);
        })
        .catch(() => undefined);
    }
    // The merge comes with the copy, from the GitHub bot; nothing here asks GitHub.
    const { store } = host;
    for (const r of list) {
      const issue = store.status === "ready" ? store.issueByKey(r.key) : undefined;
      const merged = issue && store.githubOf(issue.id).some((g) => g.kind === "pull" && g.state === "merged" && g.head === r.branch);
      if (!merged || cleaning.has(r.key)) continue;
      cleaning.add(r.key);
      void cleanUp(r, { exec, runs, settings: join(host.config.runs, `${r.sessionId}.json`) })
        .then((result) => {
          if (result === "wait") return void cleaning.delete(r.key);
          host.say([
            ["✓", { fg: "success" }],
            [` ${r.key} merged · session closed, clone moved to the trash for a week`, { fg: "ink-2" }],
          ]);
        })
        .catch((e: unknown) => host.say([[`${r.key}: clean-up failed: ${errorText(e).split("\n")[0]}`, { fg: "error" }]]));
    }
  };
  const timer = setInterval(() => void read().catch(() => undefined), AGENTS_MS);
  void read().catch(() => undefined);
  return () => clearInterval(timer);
}
