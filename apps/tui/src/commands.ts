// The TUI's work without its screens, from a terminal: `rsva-tui dispatch KEY` starts Claude on an issue and
// `rsva-tui agents` lists the runs. The screens call the same functions (dispatch.ts); here the planner is written
// through the agent API with the person's token, there through the engine.
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { errorText } from "@rsva/schema/util";
import { UsageError, type Client } from "@rsva/terminal/client";
import { runWord, sessionCalls, sessionsSeen, tend, tendedText } from "./agent-run.ts";
import { agentOf, agentStates, dispatch, EFFORTS, loadConfig, MODELS, planOf, rexSessions, Runs, withProjects, type Effort, type Exec, type Model, type Step, type Tracker } from "./dispatch.ts";


/** A program and its arguments, no shell: nothing in them is read as shell syntax. */
export const exec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env ? { ...process.env, ...opts.env } : process.env, maxBuffer: 16 * 2 ** 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} ${args[0] ?? ""}: ${(stderr || err.message).trim()}`)) : resolve(stdout),
    );
  });

/** Text to the clipboard, as an argument: nothing in it is read as shell syntax. */
export const copyText = (exec: Exec, text: string) => exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text]);

const restTracker = (api: Client): Tracker => ({
  async comment(key, body) {
    await api.request("POST", `/issues/${encodeURIComponent(key)}/comments`, { body: { body } });
  },
  async start(key, labels) {
    const project = key.split("-")[0]!;
    const states = await api.request<{ name: string; group: string }[]>("GET", "/states", { query: { project } });
    const started = states.find((s) => s.group === "started");
    if (!started) throw new Error(`${project} has no started state`);
    const members = await api.request<{ email: string; kind: string }[]>("GET", "/members");
    const delegate = agentOf(members.filter((m) => m.kind === "agent"));
    await api.request("PATCH", `/issues/${encodeURIComponent(key)}`, { body: { state: started.name, delegate, labels } });
  },
});

const MARK: Record<Step["state"], string> = { running: "…", done: "✓", failed: "✗", undone: "↺" };
const line = (s: Step) => `${MARK[s.state]} ${s.text}${s.ms !== undefined ? ` (${s.ms} ms)` : ""}${s.detail ? `: ${s.detail.split("\n")[0]}` : ""}`;

export async function dispatchCommand(api: Client, argv: string[], out: (s: string) => void): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { model: { type: "string" }, effort: { type: "string" }, executor: { type: "string" }, context: { type: "string" }, "dry-run": { type: "boolean" } },
  });
  const key = positionals[0]?.toUpperCase();
  if (!key) throw new UsageError("dispatch KEY [--model fable|opus|sonnet] [--effort low…max] [--executor sonnet|opus|fable] [--context TEXT|-] [--dry-run]");
  const config = await loadConfig();
  const model = (values.model ?? config.model) as Model;
  const effort = (values.effort ?? config.effort) as Effort;
  if (!MODELS.includes(model)) throw new UsageError(`--model: one of ${MODELS.join(", ")}`);
  if (!EFFORTS.includes(effort)) throw new UsageError(`--effort: one of ${EFFORTS.join(", ")}`);
  const executor = (values.executor ?? null) as Model | null;
  if (executor !== null && !MODELS.includes(executor)) throw new UsageError(`--executor: one of ${MODELS.join(", ")}`);
  const context = values.context === "-" ? await text(process.stdin) : (values.context ?? "");
  const [issue, projects] = await Promise.all([
    api.request<{ key: string; title: string; labels: string[] }>("GET", `/issues/${encodeURIComponent(key)}`),
    api.request<{ key: string; formerKeys: string[] }[]>("GET", "/projects"),
  ]);
  const plan = planOf(issue, { model, effort, executor, context }, withProjects(config, projects));
  if (values["dry-run"]) {
    out([`repo      ${plan.repo}`, `worktree  ${plan.worktree}`, `branch    ${plan.branch}`, `session   ${plan.session}`, `claude    ${plan.command.slice(0, -1).join(" ")} <prompt>`, "", plan.prompt].join("\n"));
    return;
  }
  let shown = 0;
  await dispatch(plan, issue, {
    exec,
    tracker: restTracker(api),
    runs: new Runs(),
    report(steps) {
      // A step's last state on its own line: a terminal or a pipe reads the same.
      for (; shown < steps.length && steps[shown]!.state !== "running"; shown++) out(line(steps[shown]!));
    },
  });
  out(`✓ Claude is working on ${key} in Rex session "${plan.session}"`);
}

/**
 * The runs and their state, each with its server run: stage, attempt and how it stands. Listing tends them as the
 * screen does: a live session's run is renewed, a closed one's still live is failed. Then a closed session's settings
 * file, which holds the agent's tokens, goes, unless its run could not be told (it is tried again next time). A session
 * Rex does not list is asked about once more before it counts as closed.
 */
export async function agentsCommand(out: (s: string) => void): Promise<void> {
  const runs = await new Runs().all();
  if (!runs.length) return out("no agents started from this Mac");
  const [live, states, config] = await Promise.all([
    sessionsSeen(() => rexSessions(exec), runs.map((r) => r.rexSession), () => new Promise((r) => setTimeout(r, 1000))),
    agentStates(exec),
    loadConfig(),
  ]);
  for (const r of runs) {
    const alive = live.has(r.rexSession);
    const state = alive ? (states.get(r.sessionId) ?? "starting") : "closed";
    const settings = join(config.runs, `${r.sessionId}.json`);
    let run = "";
    let told = true;
    const calls = r.claim && (await sessionCalls(settings));
    if (r.claim && calls) {
      const t = await tend(r.key, r.claim, alive, calls).catch((e: unknown) => errorText(e).split("\n")[0]!);
      if (typeof t === "string") {
        told = false;
        run = `${r.claim.stage} #${r.claim.attempt} ? (${t})`;
      } else {
        const said = tendedText(r.key, t);
        if (said) out(said);
        run = t.run && (t.did !== "ended" || t.run.id === r.claim.id) ? `${t.run.stage} #${t.run.attempt} ${runWord(t.run)}` : `${r.claim.stage} #${r.claim.attempt} ended`;
      }
    } else if (r.claim) run = `${r.claim.stage} #${r.claim.attempt}`;
    if (state === "closed" && told) await rm(settings, { force: true });
    out(`${r.key}  ${state}${run ? `  ${run}` : ""}  ${r.model} ${r.effort}${r.executor ? ` + ${r.executor}` : ""}  since ${r.startedAt.slice(0, 16).replace("T", " ")}  ${r.session}`);
  }
}
