// The queue and the dispatch on screen (PLNR-306): what the owner is doing past the list, which keys it takes, and
// the frame for it. The queue goes through a list one card at a time (TuiQueue); a dispatch asks for context
// (TuiContext), then the agent, model and effort (TuiDispatch), then runs dispatch.ts and shows its log (TuiLaunch*).
// Writes go through the sync engine, as the browser's do: at once on the screen, then to the server.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Issue } from "@rsva/schema/models";
import type { SyncEngine } from "@rsva/sync";
import { cacheRoot } from "@rsva/terminal/copies";
import { copyText } from "./commands.ts";
import { paintContext, paintDispatchPanel, paintLaunch, type LaunchStep } from "./dispatch-screens.ts";
import { isProposalLabel } from "@rsva/policy";
import { agentOf, choiceText, dispatch, EFFORTS, MODELS, planOf, Runs, stepTexts, withProjects, type Choice, type Config, type Exec, type Plan, type Run, type Step, type Tracker } from "./dispatch.ts";
import { Grid } from "./grid.ts";
import { editField } from "./terminal.ts";
import type { HomeView } from "./home.ts";
import type { Seg } from "./widgets.ts";
import { ago, cardOf, similarField, stateMark } from "./home-view.ts";
import { dimBehind } from "./panels.ts";
import { changed, press } from "./keys.ts";
import { paintQueue, QUEUE_HINTS, QUEUE_KEYS, type Mark, type QueueView } from "./queue.ts";
import { errorText } from "@rsva/schema/util";

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const MAX_CONTEXT = 4000;

export interface FlowHost {
  store: SyncEngine;
  exec: Exec;
  config: Config;
  say(message: Seg[]): void;
  redraw(): void;
  open(url: string): void;
  browse(key: string): string;
  /** The text in the person's editor, leaving the screen while it runs. */
  edit(text: string): Promise<string>;
  /** A long text through the person's pager, leaving the screen while it runs. */
  page(text: string): void;
  /** The issue screen over the queue: the card read in full, back to it with Esc. */
  read(id: string): void;
}

interface Queue {
  source: string;
  ids: string[];
  marks: Mark[];
  at: number;
  /** What each decision changed, to undo the last one. */
  history: { at: number; id: string; before: Pick<Issue, "stateId" | "labelIds"> }[];
}

interface Dispatching {
  id: string;
  from: "list" | "queue";
  step: "context" | "panel" | "launch";
  context: string;
  /** The cursor in the context (RSVA-465). */
  contextAt: number;
  model: number;
  effort: number;
  /** Into EXECUTORS: 0 is off, Claude alone. */
  executor: number;
  field: number;
  plan: Plan | null;
  steps: Step[];
  t0: number;
  seconds: number | null;
  run: Run | null;
  /** Hidden with Esc while it runs: the list is back, the status line says how it goes. */
  hidden: boolean;
  /** The spinner's timer while it runs, and the run itself, which quitting waits for. */
  spin?: ReturnType<typeof setInterval>;
  running?: Promise<void> | undefined;
}

/**
 * The last choice per project, kept on this Mac across restarts: "remembered: opus · high · sonnet executes for PLNR".
 * The executor since PLNR-388; a file from before has only the model and the effort. One that names an agent (site-dev,
 * until PLNR-394) opens as Claude.
 */
const CHOICES = join(cacheRoot(), "dispatch-choices.json");
export type Remembered = { model: string; effort: string; executor?: string | null };

/** The executor row: off, then a model for each line. The curator's own model is shown but not chosen. */
const EXECUTORS = [null, ...MODELS] as const;
/** The panel's choices, in Tab order: model, effort, executor. */
const FIELDS = 3;

/** The panel's picks, as indices into MODELS, EFFORTS and EXECUTORS. */
export type Picks = Pick<Dispatching, "model" | "effort" | "executor">;

/** What the panel has chosen, as dispatch.ts takes it: no executor on the curator's own model. */
export function choiceOf(p: Picks, context = ""): Choice {
  const model = MODELS[p.model]!;
  const executor = EXECUTORS[p.executor] ?? null;
  return { model, effort: EFFORTS[p.effort]!, executor: executor !== model ? executor : null, context };
}

/** A choice as the file keeps it. */
export const rememberedOf = (c: Choice): Remembered => ({ model: c.model, effort: c.effort, executor: c.executor });

/** The picks a dispatch opens on: the project's last choice, else the config's model and effort, Claude alone. */
export function picksOf(r: Remembered | undefined, config: Pick<Config, "model" | "effort">): Picks {
  const at = <T>(list: readonly T[], v: T) => Math.max(0, list.indexOf(v));
  return {
    model: at<string>(MODELS, r?.model ?? config.model),
    effort: at<string>(EFFORTS, r?.effort ?? config.effort),
    executor: at<string | null>(EXECUTORS, r?.executor ?? null),
  };
}

/** `h`/`l` on a field: round its row. The executor passes over the curator's model. */
export function choose(p: Picks, field: number, by: number): void {
  const n = [MODELS.length, EFFORTS.length, EXECUTORS.length][field]!;
  if (field === 0) p.model = (p.model + by + n) % n;
  if (field === 1) p.effort = (p.effort + by + n) % n;
  if (field === 2) {
    do p.executor = (p.executor + by + n) % n;
    while (EXECUTORS[p.executor] === MODELS[p.model]);
  }
  // A curator moved onto the executor's model works alone.
  if (EXECUTORS[p.executor] === MODELS[p.model]) p.executor = 0;
}

export class Flow {
  queue: Queue | null = null;
  dispatching: Dispatching | null = null;
  private frame = 0;
  private readonly host: FlowHost;

  constructor(host: FlowHost) {
    this.host = host;
  }

  /** The configuration with the repositories under the projects' keys now: a rename while the TUI runs follows too. */
  private get config(): Config {
    return withProjects(this.host.config, [...this.host.store.projects.values()]);
  }

  /** Whether the flow has the screen: the list's keys and frame are not in use. */
  get active(): boolean {
    return !!this.queue || (!!this.dispatching && !this.dispatching.hidden);
  }

  startQueue(ids: string[], source: string): void {
    if (!ids.length) return;
    this.queue = { source, ids, marks: ids.map((_, i) => (i ? "next" : "now")), at: 0, history: [] };
  }

  /** A launch on its way (shown or hidden): quitting waits for it, so its writes to the planner are not lost. */
  settled(): Promise<void> {
    return this.dispatching?.running ?? Promise.resolve();
  }

  async startDispatch(id: string, from: "list" | "queue"): Promise<void> {
    const issue = this.host.store.issues.get(id);
    if (!issue) return;
    const project = this.host.store.projects.get(issue.projectId)?.key ?? "";
    // One launch at a time: a hidden one still owns this.dispatching until it is done.
    const busy = this.dispatching;
    if (busy?.running) {
      this.host.say([[`a launch is still running (${busy.plan?.key ?? "…"}): wait for it, its log is in the status line`, { fg: "warning" }]]);
      return;
    }
    if (!this.config.repos[project]) {
      this.host.say([[`${project}: no repository to dispatch to (INFRA and hosts stay with /tasks)`, { fg: "warning" }]]);
      return;
    }
    const remembered = (await this.choices())[project];
    const d: Dispatching = { id, from, step: "context", context: "", contextAt: 0, ...picksOf(remembered, this.host.config), field: 0, plan: null, steps: [], t0: 0, seconds: null, run: null, hidden: false };
    this.dispatching = d;
    if (remembered) this.host.say([[`remembered: ${choiceText(choiceOf(d))} for ${project}`, { fg: "ink-3" }]]);
  }

  private async choices(): Promise<Record<string, Remembered>> {
    try {
      return JSON.parse(await readFile(CHOICES, "utf8")) as Record<string, Remembered>;
    } catch {
      return {};
    }
  }

  private async remember(project: string, c: Choice): Promise<void> {
    const all = await this.choices();
    all[project] = rememberedOf(c);
    await mkdir(dirname(CHOICES), { recursive: true, mode: 0o700 });
    await writeFile(CHOICES, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  }

  // ── Keys ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Takes a key while the flow has the screen; false when it is the list's. */
  key(key: string): boolean {
    const d = this.dispatching;
    if (d && !d.hidden) {
      if (d.step === "context") this.contextKey(d, key);
      else if (d.step === "panel") this.panelKey(d, key);
      else this.launchKey(d, key);
      return true;
    }
    if (this.queue) {
      this.queueKey(this.queue, key);
      return true;
    }
    return false;
  }

  private queueKey(q: Queue, key: string): void {
    const id = q.ids[q.at];
    const issue = id ? this.host.store.issues.get(id) : undefined;
    const store = this.host.store;
    const decide = (mark: Mark, change?: Partial<Pick<Issue, "stateId" | "labelIds">>) => {
      if (!issue) return;
      q.history.push({ at: q.at, id: issue.id, before: { stateId: issue.stateId, labelIds: issue.labelIds } });
      if (change) store.updateIssue(issue.id, change);
      q.marks[q.at] = mark;
      q.at = Math.min(q.at + 1, q.ids.length);
      if (q.at < q.ids.length) q.marks[q.at] = "now";
    };
    const withoutProposed = (i: Issue) => i.labelIds.filter((l) => !isProposalLabel(store.labels.get(l)?.name ?? ""));
    const stateOf = (i: Issue, group: string) => store.statesOf(i.projectId).find((s) => s.group === group);
    press(
      QUEUE_KEYS,
      {
        back: () => (this.queue = null),
        read: () => issue && this.host.read(issue.id),
        dispatch: () => issue && void this.startDispatch(issue.id, "queue").then(() => this.host.redraw()),
        approve: () => {
          if (!issue) return;
          const todo = stateOf(issue, "unstarted");
          decide("dispatched", { ...(todo ? { stateId: todo.id } : {}), labelIds: withoutProposed(issue) });
          this.host.say([["✓", { fg: "success" }], [` ${store.issueKey(issue)} → ${todo?.name ?? "approved"}`, { fg: "ink-2" }]]);
        },
        skip: () => decide("skipped"),
        cancel: () => {
          if (!issue) return;
          const cancelled = stateOf(issue, "cancelled");
          if (!cancelled) return this.host.say([[`${store.issueKey(issue)}: its project has no cancelled state`, { fg: "warning" }]]);
          decide("skipped", { stateId: cancelled.id });
          this.host.say(changed(store.issueKey(issue), `→ ${cancelled.name}`));
        },
        browse: () => issue && this.host.open(this.host.browse(store.issueKey(issue))),
        undo: () => {
          const last = q.history.pop();
          if (!last) return;
          store.updateIssue(last.id, last.before);
          if (q.at < q.ids.length) q.marks[q.at] = "next";
          q.at = last.at;
          q.marks[q.at] = "now";
        },
      },
      key,
      { chord: "" },
    );
  }

  private contextKey(d: Dispatching, key: string): void {
    // As in the web's fields: Enter goes on, Shift+Enter is a new line (Alt+Enter where the terminal cannot tell).
    if (key === "esc") this.close(d);
    else if (key === "enter" || key === "ctrl-enter" || key === "tab") d.step = "panel";
    else if (key === "ctrl-e")
      void this.host.edit(d.context).then((text) => {
        d.context = text.slice(0, MAX_CONTEXT);
        d.contextAt = d.context.length;
        this.host.redraw();
      });
    else {
      // The rest are the field's, at the cursor (RSVA-465).
      const f = editField({ text: d.context, at: d.contextAt }, key, true, MAX_CONTEXT);
      if (f) [d.context, d.contextAt] = [f.text, f.at];
    }
  }

  private panelKey(d: Dispatching, key: string): void {
    const move = (by: number) => choose(d, d.field, by);
    if (key === "esc" || key === "e") d.step = "context";
    else if (key === "tab" || key === "down" || key === "j") d.field = (d.field + 1) % FIELDS;
    else if (key === "up" || key === "k") d.field = (d.field + FIELDS - 1) % FIELDS;
    else if (key === "l" || key === "right") move(1);
    else if (key === "h" || key === "left") move(-1);
    else if (key === "enter") void this.launch(d);
  }

  private launchKey(d: Dispatching, key: string): void {
    const failed = d.steps.some((s) => s.state === "failed");
    if (key === "esc") {
      if (d.seconds !== null) this.close(d);
      else d.hidden = true;
    } else if (failed && key === "r") void this.launch(d);
    else if (failed && key === "e") {
      d.steps = [];
      d.seconds = null;
      d.step = "context";
    } else if (key === "l") this.host.page(d.steps.map((s) => `${s.state.padEnd(7)} ${s.text}${s.ms !== undefined ? ` (${s.ms} ms)` : ""}${s.detail ? `\n${s.detail}` : ""}`).join("\n"));
    else if (failed && key === "y") {
      const error = d.steps.find((s) => s.state === "failed")?.detail ?? "";
      void copyText(this.host.exec, error).then(() => this.host.say([["error copied", { fg: "ink-2" }]]));
    }
  }

  private close(d: Dispatching): void {
    // Only its own: a launch that ends hidden must not close a dispatch begun since.
    if (this.dispatching === d) this.dispatching = null;
    // Back to the queue, the card decided: dispatched.
    if (d.from === "queue" && this.queue && d.run) {
      const q = this.queue;
      q.marks[q.at] = "dispatched";
      q.at = Math.min(q.at + 1, q.ids.length);
      if (q.at < q.ids.length) q.marks[q.at] = "now";
    }
  }

  // ── The launch ────────────────────────────────────────────────────────────────────────────────────────────────

  private tracker(): Tracker {
    const store = this.host.store;
    // Nothing silent: what cannot be written fails the step, which the log shows ✗ (the agent keeps working).
    const issueOf = (key: string) => store.issueByKey(key) ?? Promise.reject(new Error(`no issue ${key} in the copy`));
    return {
      async comment(key, body) {
        store.addComment((await issueOf(key)).id, body);
      },
      async start(key) {
        const i = await issueOf(key);
        const started = store.statesOf(i.projectId).find((s) => s.group === "started");
        if (!started) throw new Error(`${key}: its project has no started state`);
        const agents = [...store.users.values()].filter((u) => u.kind === "agent");
        const email = agentOf(agents);
        const agent = agents.find((u) => u.email === email)!;
        store.updateIssue(i.id, { stateId: started.id, delegateId: agent.id, labelIds: i.labelIds.filter((l) => !isProposalLabel(store.labels.get(l)?.name ?? "")) });
      },
    };
  }

  private launch(d: Dispatching): Promise<void> {
    d.running = this.run(d).finally(() => (d.running = undefined));
    return d.running;
  }

  private async run(d: Dispatching): Promise<void> {
    const store = this.host.store;
    const issue = store.issues.get(d.id);
    if (!issue) return;
    const key = store.issueKey(issue);
    const labels = issue.labelIds.flatMap((l) => store.labels.get(l)?.name ?? []);
    const choice = choiceOf(d, d.context);
    try {
      d.plan = planOf({ key, title: issue.title, labels }, choice, this.config);
    } catch (e) {
      this.host.say([[(e as Error).message, { fg: "error" }]]);
      return;
    }
    void this.remember(key.split("-")[0]!, choice).catch(() => undefined);
    d.step = "launch";
    d.steps = [];
    d.seconds = null;
    d.run = null;
    d.t0 = performance.now();
    d.spin = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.host.redraw();
    }, 100);
    try {
      d.run = await dispatch(d.plan, { key, title: issue.title, labels }, {
        exec: this.host.exec,
        tracker: this.tracker(),
        runs: new Runs(),
        report: (steps) => {
          d.steps = steps.map((s) => ({ ...s }));
          this.host.redraw();
        },
      });
      // The session is named, not opened: it is in Rex's sidebar (owner's decision 2026-11-05, no Remote Control).
      this.host.say([
        ["✓", { fg: "success" }],
        [` ${key} → In Progress · Rex session `, { fg: "ink-2" }],
        [d.plan.session, { fg: "ink" }],
      ]);
    } catch (e) {
      const at = d.steps.find((s) => s.state === "failed")?.text;
      this.host.say([[at ? `✗ Launch failed at ${at} · rolled back` : `✗ ${errorText(e).split("\n")[0]}`, { fg: "error" }]]);
    } finally {
      clearInterval(d.spin);
      d.seconds = (performance.now() - d.t0) / 1000;
      // Through, it closes itself, shown or hidden: the status line has the result (owner's decision 2026-11-06).
      // A failed step keeps the log open for retry, edit and the error.
      if (!d.steps.some((s) => s.state === "failed")) this.close(d);
      this.host.redraw();
    }
  }

  /** The status line's message while a hidden launch runs. */
  progress(): Seg[] | null {
    const d = this.dispatching;
    if (!d?.hidden || d.seconds !== null || !d.plan) return null;
    const running = d.steps.find((s) => s.state === "running");
    return [
      [SPINNER[this.frame]!, { fg: "ink" }],
      [` launching ${d.plan.key}${running ? ` · ${running.text}` : ""}`, { fg: "ink-2" }],
    ];
  }

  // ── Frames ────────────────────────────────────────────────────────────────────────────────────────────────────

  private queueView(status: HomeView["status"]): QueueView {
    const q = this.queue!;
    const store = this.host.store;
    const issue = store.issues.get(q.ids[q.at] ?? "");
    const now = Date.now();
    let card: QueueView["card"] = null;
    if (issue) {
      const c = cardOf(store, issue, now);
      const project = store.projects.get(issue.projectId);
      const by = issue.createdById ? store.users.get(issue.createdById)?.email : undefined;
      const proposed = c.brief.labels.some((l) => isProposalLabel(l.name));
      // A proposal lists what it may duplicate: the owner decides on the card.
      const similar = proposed ? similarField(store, issue) : null;
      card = {
        key: c.key,
        title: c.title,
        state: c.state,
        priority: c.priority,
        project: { key: project?.key ?? "", name: project?.name ?? "" },
        labels: c.brief.labels,
        filed: by ? { by, ago: `${ago(issue.createdAt, now)} ago` } : null,
        proposed,
        description: c.description,
        fields: [...c.fields.filter((f) => ["parent", "relations", "links"].includes(f.label)), ...(similar ? [similar] : [])],
      };
    }
    return {
      source: q.source,
      marks: q.marks,
      next: q.ids.slice(q.at + 1).map((id) => {
        const i = store.issues.get(id);
        return i ? store.issueKey(i) : "?";
      }),
      card,
      status,
      keys: QUEUE_HINTS,
    };
  }

  /** The launch log from the steps reported so far and the ones still to come. */
  private launchSteps(d: Dispatching): { steps: LaunchStep[]; undone: { text: string; ms: number }[] } {
    const names = stepTexts(d.plan!);
    const planned = [names.fetch, names.worktree, ...(names.install ? [names.install] : []), names.rex, names.started, names.start];
    const failedAt = d.steps.findIndex((s) => s.state === "failed");
    const steps = planned.map((text): LaunchStep => {
      const s = d.steps.find((x) => x.text === text && x.state !== "undone");
      if (s && s.state !== "undone") return { text, state: s.state, ...(s.ms !== undefined ? { ms: s.ms } : {}) };
      return { text, state: failedAt >= 0 ? "skipped" : "pending" };
    });
    const undone = d.steps.filter((s) => s.state === "undone").map((s) => ({ text: s.text, ms: s.ms ?? 0 }));
    return { steps, undone };
  }

  /**
   * The frame while the flow has the screen. `home` paints the list under a panel that floats over it; the queue
   * paints itself. The status line and the keys of the step are the base screen's.
   */
  paint(size: { columns: number; rows: number }, home: (status: HomeView["status"], keys: HomeView["keys"]) => Grid, status: HomeView["status"]): Grid {
    const d = this.dispatching && !this.dispatching.hidden ? this.dispatching : null;
    const store = this.host.store;
    let g = new Grid(size.columns, size.rows);
    const base = (keys: HomeView["keys"] | null, message: Seg[] = status.message) => {
      const s = { ...status, message, brief: message.map(([t]) => t).join("") };
      if (d?.from === "queue" || (!d && this.queue)) {
        const v = this.queueView(s);
        if (keys) paintQueue(g, { ...v, keys }, "");
        else paintQueue(g, v);
      } else g = home(s, keys ?? []);
    };
    if (!d) {
      base(null);
      return g;
    }
    const issue = store.issues.get(d.id);
    if (!issue) {
      base(null);
      return g;
    }
    const key = store.issueKey(issue);
    const st = store.states.get(issue.stateId);
    if (d.step === "context") {
      base(
        [
          ["↵", "next"],
          ["⇧↵", "new line"],
          ["⌃E", "$EDITOR"],
          ["Esc", "back"],
        ],
        [[`writing context for ${key}`, { fg: "ink-3" }]],
      );
      dimBehind(g);
      paintContext(g, { key, title: issue.title, text: d.context, cursor: d.contextAt, max: MAX_CONTEXT });
      return g;
    }
    if (d.step === "panel") {
      base([
        ["Tab", "field"],
        ["h/l", "choose"],
        ["↵", "launch"],
        ["Esc", "back"],
      ]);
      dimBehind(g);
      const choice = choiceOf(d, d.context);
      const plan = planOf({ key, title: issue.title, labels: [] }, choice, this.config);
      const c = cardOf(store, issue, Date.now());
      paintDispatchPanel(g, {
        key,
        title: c.title,
        state: st ? stateMark(store, st) : c.state,
        priority: c.priority,
        labels: c.brief.labels,
        session: plan.session,
        models: MODELS.map((m, i) => ({ name: m, on: i === d.model })),
        efforts: EFFORTS.map((e, i) => ({ name: e, on: i === d.effort })),
        executors: EXECUTORS.map((m) => ({ name: m ?? "off", on: m === choice.executor, off: m !== null && m === choice.model })),
        executorEffort: this.host.config.executorEffort,
        field: d.field,
        repo: plan.repo.replace(homedir(), "~"),
        branch: plan.branch,
        base: "origin/main",
        context: d.context,
      });
      return g;
    }
    const failed = d.steps.some((s) => s.state === "failed");
    base(
      failed
        ? [
            ["r", "retry"],
            ["e", "edit"],
            ["y", "copy error"],
            ["Esc", "back"],
          ]
        : [
            ["Esc", "hide"],
            ["l", "log"],
          ],
    );
    dimBehind(g);
    const { steps, undone } = this.launchSteps(d);
    const error = d.steps.find((s) => s.state === "failed")?.detail?.split("\n") ?? [];
    paintLaunch(g, {
      key,
      title: issue.title,
      who: `Claude · ${choiceText(d.plan!.choice)} · ${d.plan!.repo.replace(homedir(), "~")}`,
      steps,
      spinner: SPINNER[this.frame]!,
      command: `rex new ${d.plan!.session} -c ${d.plan!.worktree.replace(homedir(), "~")} -- claude --model ${d.plan!.choice.model} --effort ${d.plan!.choice.effort}${d.plan!.choice.executor ? ` --agents executor:${d.plan!.choice.executor}` : ""}`,
      error: failed ? { title: error[0] ?? "failed", detail: error[1] ?? "", why: error[2] ?? "" } : null,
      undone,
    });
    return g;
  }
}
