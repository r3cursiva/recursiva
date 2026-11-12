// "Comment on selection" for now: the selected text goes into the issue's comment composer as a quote. Comments anchored
// to a text range (Yjs relative positions) come later; this keeps the action useful until then.
type Listener = (markdown: string) => void;

const listeners = new Map<string, Set<Listener>>();
/** A quote asked for before the composer's editor loaded waits here. */
const waiting = new Map<string, string>();

export const commentQuote = {
  request(issueId: string, markdown: string): void {
    const set = listeners.get(issueId);
    if (set?.size) for (const l of set) l(markdown);
    else waiting.set(issueId, (waiting.get(issueId) ?? "") + markdown);
  },
  listen(issueId: string, l: Listener): () => void {
    let set = listeners.get(issueId);
    if (!set) listeners.set(issueId, (set = new Set()));
    set.add(l);
    const queued = waiting.get(issueId);
    if (queued) {
      waiting.delete(issueId);
      l(queued);
    }
    return () => void set.delete(l);
  },
};
