// What asks the viewer in the open workspace, by the one rule (RSVA-572, `asksViewer`): their own reviews and the new
// assignments to decide on (My work is what is assigned to them, owner 2026-11-11), not proposals. One pass over the workspace's issues, shared by the sidebar's count on My work and its marks on the
// projects, so the two cannot disagree. The open workspace only: the others' engines are held while My work is open,
// not while the sidebar is, so Home (every workspace) can show more than this for someone who is in several.
import { asksViewer, collect, forTriage, type WorkItem } from "@rsva/protocol/my-work";
import { computed } from "mobx";
import { currentWs, store } from "../store.ts";

export const myAsks = computed<WorkItem[]>(() => collect(currentWs(), store, Date.now()).filter(asksViewer));

/** What Triage lists in the open workspace: proposals and the reviews of what agents made. */
export const myTriage = computed<WorkItem[]>(() => collect(currentWs(), store, Date.now(), { others: true }).filter((x) => forTriage(x, store.me?.id)));
