// What the Decisions screen and the sidebar's count read (RSVA-644): the open questions that wait on the viewer and the
// saved rules, from the server (apps/server/src/api-decisions.ts). Questions are comments, which are not in the
// workspace's snapshot, so they are asked for: once after the sidebar has painted, again when the screen opens, and
// when the tab comes back after a minute away. Small and in the startup chunk for the count; the screen is lazy.
import type { DecisionRule, OpenDecision } from "@rsva/protocol/decisions";
import { errorText } from "@rsva/schema/util";
import { makeAutoObservable, observableRef, runInAction } from "mobx";
import { call } from "../lib/api.ts";

type Rule = DecisionRule & { mine: boolean };

const STALE_MS = 60_000;
const base = (ws: string) => `/api/v1/workspaces/${encodeURIComponent(ws)}`;

class DecisionsState {
  ws: string | null = null;
  /** Null until the first answer: the screen says it is loading, not that nothing waits. */
  open: OpenDecision[] | null = null;
  error: string | null = null;
  rules: Rule[] | null = null;
  /** Answered in this tab and not yet listed answered by the server: the screen's sitting sets it. */
  answered: ReadonlySet<string> = new Set();
  private at = 0;
  private asking: Promise<void> | null = null;

  constructor() {
    makeAutoObservable<DecisionsState, "at" | "asking">(this, { open: observableRef, rules: observableRef, answered: observableRef, at: false, asking: false });
  }

  /** The open questions of `ws`; asked again only when `fresh` or older than a minute. */
  load(ws: string, fresh = false): Promise<void> {
    if (ws !== this.ws) {
      this.ws = ws;
      this.open = null;
      this.rules = null;
      this.error = null;
      this.asking = null;
    } else if (this.asking || (!fresh && Date.now() - this.at < STALE_MS)) return this.asking ?? Promise.resolve();
    this.at = Date.now();
    const asking = call<{ decisions: OpenDecision[] }>("GET", `${base(ws)}/decisions`).then(
      (r) =>
        runInAction(() => {
          if (this.ws !== ws) return;
          this.open = r.decisions;
          this.error = null;
        }),
      (e: unknown) =>
        runInAction(() => {
          if (this.ws === ws) this.error = errorText(e);
        }),
    );
    const done = asking.finally(() => (this.asking = null));
    this.asking = done;
    return done;
  }

  /** What waits: the open questions not answered here yet. */
  get waiting(): OpenDecision[] {
    return (this.open ?? []).filter((d) => !this.answered.has(d.commentId));
  }

  setAnswered(ids: ReadonlySet<string>): void {
    this.answered = ids;
  }

  async loadRules(ws: string): Promise<void> {
    const r = await call<{ rules: Rule[] }>("GET", `${base(ws)}/decision-rules`);
    runInAction(() => this.ws === ws && (this.rules = r.rules));
  }

  async saveRule(ws: string, rule: Pick<DecisionRule, "project" | "question" | "answer">): Promise<void> {
    const r = await call<{ rule: Rule }>("POST", `${base(ws)}/decision-rules`, rule);
    runInAction(() => this.ws === ws && this.rules && (this.rules = [r.rule, ...this.rules]));
  }

  async removeRule(ws: string, id: string): Promise<void> {
    await call("DELETE", `${base(ws)}/decision-rules/${encodeURIComponent(id)}`);
    runInAction(() => this.ws === ws && this.rules && (this.rules = this.rules.filter((x) => x.id !== id)));
  }
}

export const decisions = new DecisionsState();
