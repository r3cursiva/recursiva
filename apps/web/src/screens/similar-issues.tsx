// The create panel's "Similar open issues" (PLNR-295): under the title, up to three open issues whose titles look like what is
// being typed, from the pool the app already holds, so there is no request. The score is the one the server refuses a strong
// match with (packages/protocol/src/similar.ts), so what the panel showed is what the API would have said. The code rides in
// the panel's lazy chunk, not the start bundle.
import { similarIssues } from "@rsva/protocol/similar";
import type { Issue } from "@rsva/schema/models";
import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import { Link } from "../link.tsx";
import { store } from "../store.ts";
import { issuePath } from "./issue-actions.ts";
import { StateGlyph } from "./state-glyph.tsx";

/** The pause in typing before the pool is scanned, and the shortest title that is looked up. */
const IDLE_MS = 150;
const MIN_CHARS = 3;
const SHOWN = 3;

/** The matches for a title: the pool is scanned when the pause ends, not on every render. */
function useSimilarIssues(title: string, projectId: string): Issue[] {
  const [found, setFound] = useState<Issue[]>([]);
  useEffect(() => {
    const probe = title.trim();
    if (probe.length < MIN_CHARS) return setFound([]);
    const timer = setTimeout(() => {
      // An issue the server has not numbered yet reads "KEY-?" and has no page to open.
      const pool = [...store.issues.values()].filter((i) => i.number > 0);
      setFound(similarIssues(probe, pool, (i) => store.states.get(i.stateId)?.group, { limit: SHOWN, projectId }).map((m) => m.issue));
    }, IDLE_MS);
    return () => clearTimeout(timer);
  }, [title, projectId]);
  return found;
}

/**
 * `onOpen` runs before an issue opens: the panel saves its draft and closes, so what was typed waits in the draft for the
 * next "new issue". The links are out of the form's Tab order (a title is followed by its description); a click or a tap
 * opens them, and a modified click opens a new tab and leaves the panel alone.
 */
export const SimilarIssues = observer(function SimilarIssues({ title, projectId, onOpen }: { title: string; projectId: string; onOpen: () => void }) {
  const issues = useSimilarIssues(title, projectId);
  if (!issues.length) return null;
  return (
    <div role="group" aria-label="Similar open issues" className="-mt-0.5 mb-1 flex flex-col">
      <span className="text-[11.5px] text-ink-3 max-md:text-[12px]">Similar open issues</span>
      {issues.map((issue) => {
        const state = store.states.get(issue.stateId);
        const href = issuePath(issue);
        return (
          <Link
            key={issue.id}
            href={href}
            tabIndex={-1}
            before={onOpen}
            className="-mx-2 flex h-8 min-w-0 items-center gap-2.5 rounded-[7px] px-2 text-[13px] outline-none md:row-plate max-md:h-11 max-md:text-[14px]"
          >
            {state && <StateGlyph state={state} />}
            <span className="min-w-[62px] shrink-0 font-mono text-[11.5px] text-ink-3">{store.issueKey(issue)}</span>
            <span className="min-w-0 flex-1 truncate">{issue.title}</span>
          </Link>
        );
      })}
    </div>
  );
});
