// Similar issues (PLNR-295): which open issues look like a title being typed or just filed. One pure function, so the
// server (the 409 on a strong match), the create panel, the TUI queue and the Telegram /triage card give the same
// answer: the match the API refuses on is the match the panel showed. A subpath of its own (`@rsva/protocol/similar`):
// through the package's index it would ride in the browser's startup chunk.
//
// The score is trigram similarity in the spirit of PostgreSQL's pg_trgm: lower-case, split on anything that is not a letter
// or a digit, pad each word with two spaces in front and one behind, take the set of three-character slices; the score
// is |A ∩ B| / |A ∪ B|. Words are padded one by one, so reordered words score 1 and a typo costs a few trigrams.
// Considered against pg_trgm on the server plus MiniSearch in a worker on the client: docs/research/similar-issues-2026-11-06.md.
import { isOpenIssue, type Issue } from "@rsva/schema/models";

/** What the score reads of an issue: the title, the project, and what says whether it is still open. */
export type SimilarCandidate = Pick<Issue, "id" | "title" | "projectId" | "stateId" | "archivedAt" | "deletedAt">;

export interface SimilarOptions {
  /** How many to return; 5. */
  limit?: number;
  /** The lowest score listed; `SHOWN`. */
  floor?: number;
  /** An issue that is not its own match (triage lists similar issues to a proposal). */
  exclude?: string;
  /** The new issue's project: a candidate in another project counts at `OTHER_PROJECT` of its score. */
  projectId?: string;
}

/**
 * Set on 2026-11-06 from our 860 live issues and 15 duplicates found by hand (docs/research/similar-issues-2026-11-06.md,
 * `node tools/perf/src/similar.ts`), titles only:
 * - SHOWN 0.35: the original is in the top 2 for all 15 pairs and scores 0.35 or more for 12 of them; 62 of the 860 issues
 *   (7 %) had such a match when they were filed, at 0.3 it would be 125 (15 %), mostly series ("Notifications 5/7") that
 *   are related, not the same;
 * - STRONG 0.75: no false positive in the whole workspace (the highest pair that is not a duplicate scores 0.68), and in
 *   the sample of 100; it would have refused 2 of the 15 pairs when they were filed (0.83 and 0.78) and the two exact
 *   copies PLANE-1 and PLANE-2, the rest are listed;
 * - OTHER_PROJECT 0.8: the per-site twins (site-a.example and site-b.example "check whether upload files are served by Next")
 *   score 0.84 to 0.86 as raw titles and are separate work; 14 of the 15 pairs are in one project.
 */
export const SHOWN = 0.35;
export const STRONG = 0.75;
export const OTHER_PROJECT = 0.8;

const WORD = /[\p{L}\p{N}]+/gu;

/** The trigrams of a text, pg_trgm style. */
export function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const [word] of text.toLowerCase().matchAll(WORD)) {
    const padded = `  ${word} `;
    // By code points: a letter outside the BMP is one character, not two halves.
    const chars = Array.from(padded);
    for (let i = 0; i + 3 <= chars.length; i++) out.add(chars[i]! + chars[i + 1]! + chars[i + 2]!);
  }
  return out;
}

/** |A ∩ B| / |A ∪ B|; 0 when either is empty. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let both = 0;
  for (const t of small) if (large.has(t)) both++;
  return both / (a.size + b.size - both);
}

// A candidate's trigrams, by its title: typing scores the same ~1000 titles on every keystroke, and a title is a string
// that is the same across issues and across edits that did not touch it.
const cache = new Map<string, Set<string>>();
const CACHE_MAX = 20_000;

function titleTrigrams(title: string): Set<string> {
  let t = cache.get(title);
  if (!t) {
    if (cache.size >= CACHE_MAX) cache.clear();
    t = trigrams(title);
    cache.set(title, t);
  }
  return t;
}

/**
 * The open issues whose titles look most like `title`, best first. `group` names the state group of an issue (the caller
 * knows its states); closed, archived and deleted issues never match. Only titles are compared: a probe with the first 300
 * characters of its description found the original later (rank 8–14 for pairs that title alone put first) and listed a
 * match for half of the issues filed.
 */
export function similarIssues<T extends SimilarCandidate>(
  title: string,
  issues: Iterable<T>,
  group: (issue: T) => string | null | undefined,
  { limit = 5, floor = SHOWN, exclude, projectId }: SimilarOptions = {},
): { issue: T; score: number }[] {
  const a = trigrams(title);
  const found: { issue: T; score: number }[] = [];
  for (const issue of issues) {
    if (issue.id === exclude || !isOpenIssue(issue, group(issue))) continue;
    const score = jaccard(a, titleTrigrams(issue.title)) * (projectId && issue.projectId !== projectId ? OTHER_PROJECT : 1);
    if (score >= floor) found.push({ issue, score });
  }
  return found.sort((x, y) => y.score - x.score).slice(0, limit);
}
