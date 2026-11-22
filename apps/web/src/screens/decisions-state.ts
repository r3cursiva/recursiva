// What the sidebar's count and the Decisions screen read (RSVA-644): the open questions agents put to the viewer, from
// the workspace's own copy (Decision rows come with the snapshot and its deltas), so the count needs no request and
// holds offline. `answered`: what the screen's sitting answered and still holds for its undo window.
import { decisionWaits } from "@rsva/protocol/my-work";
import type { Decision } from "@rsva/schema/models";
import { computed, makeAutoObservable, observableRef } from "mobx";
import { store } from "../store.ts";

class DecisionsState {
  answered: ReadonlySet<string> = new Set();

  constructor() {
    makeAutoObservable(this, { answered: observableRef });
  }

  setAnswered(ids: ReadonlySet<string>): void {
    this.answered = ids;
  }
}

export const decisions = new DecisionsState();

/** The open questions that wait on the viewer and are not answered here yet, oldest first. */
export const waitingDecisions = computed<Decision[]>(() =>
  [...store.decisions.values()]
    .filter((d) => !decisions.answered.has(d.id) && decisionWaits(store, d, store.issues.get(d.issueId)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
);
