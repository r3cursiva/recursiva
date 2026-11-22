// The rules people saved from their answers (RSVA-644), for the Decisions screen's Rules: server-only rows read and
// removed over REST (apps/server/src/api-decisions.ts); one is saved with an answer, through the sync engine.
import { errorText } from "@rsva/schema/util";
import { makeAutoObservable, observableRef, runInAction } from "mobx";
import { call } from "../lib/api.ts";

interface Rule {
  id: string;
  project: string;
  topic: string;
  answer: string;
  by: string;
  mine: boolean;
}

const base = (ws: string) => `/api/v1/workspaces/${encodeURIComponent(ws)}/decision-rules`;

class Rules {
  ws: string | null = null;
  /** Null until loaded. */
  list: Rule[] | null = null;
  error: string | null = null;

  constructor() {
    makeAutoObservable(this, { list: observableRef });
  }

  async load(ws: string): Promise<void> {
    this.ws = ws;
    try {
      const r = await call<{ rules: Rule[] }>("GET", base(ws));
      runInAction(() => {
        if (this.ws !== ws) return;
        this.list = r.rules;
        this.error = null;
      });
    } catch (e) {
      runInAction(() => (this.error = errorText(e)));
    }
  }

  async remove(ws: string, id: string): Promise<void> {
    await call("DELETE", `${base(ws)}/${encodeURIComponent(id)}`);
    runInAction(() => this.list && (this.list = this.list.filter((r) => r.id !== id)));
  }
}

export const rules = new Rules();
