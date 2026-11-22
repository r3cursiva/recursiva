// What the sidebar's count and the Decisions screen read (RSVA-644): the open questions agents put to the viewer, from
// the workspace's own copy (open Decision rows come with the snapshot, answers as deltas), so the count needs no request
// and holds offline. `answered`: what the screen's sitting answered and still holds for its undo window.
//
// Answers sent as the page closed are also kept here on the device (`keepHeld`): the engine's queue reaches IndexedDB
// asynchronously and a closing tab may not wait for it. The next start sends each one whose question is still open in
// the copy, once; one the server has since answered is no longer in the snapshot and is dropped.
import { decisionWaits } from "@rsva/protocol/my-work";
import type { Decision, DecisionAnswer } from "@rsva/schema/models";
import { computed, makeAutoObservable, observableRef, reaction } from "mobx";
import { readLocal, writeLocal } from "../lib/local-storage.ts";
import { currentWs, store } from "../store.ts";

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

const HELD = "rsva:decisions-held";
/** A held answer older than this is dropped: its question has long been answered or moved on. */
const HELD_MS = 86_400_000;
interface Held {
  ws: string;
  id: string;
  set: DecisionAnswer;
  at: number;
}

const readHeld = (): Held[] => {
  const v = readLocal(HELD);
  return Array.isArray(v) ? (v as Held[]).filter((h) => h && typeof h.id === "string" && Date.now() - h.at < HELD_MS) : [];
};

/** Answers sent as the page closes, kept until a start finds them sent. */
export function keepHeld(answers: { id: string; set: DecisionAnswer }[]): void {
  const ws = currentWs();
  writeLocal(HELD, [...readHeld().filter((h) => !answers.some((a) => a.id === h.id)), ...answers.map((a) => ({ ws, id: a.id, set: a.set, at: Date.now() }))]);
}

/** Sends the kept answers whose questions are open in this workspace's copy, and forgets them. */
function sendHeld(): void {
  const held = readHeld();
  if (!held.length) return;
  const ws = currentWs();
  const sent = held.filter((h) => h.ws === ws && store.decisions.get(h.id)?.status === "open");
  for (const h of sent) store.answerDecision(h.id, h.set);
  if (sent.length || held.length !== (readLocal(HELD) as unknown[] | null)?.length) writeLocal(HELD, held.filter((h) => !sent.includes(h)));
}

// When open questions arrive (the snapshot, a delta), the kept answers to them go.
reaction(
  () => [...store.decisions.values()].filter((d) => d.status === "open").length,
  sendHeld,
  { fireImmediately: true },
);
