// What GitHub did, as an issue's feed words it: shared by the web and the TUI so the two say the same. No drawing here.
import { plural } from "@rsva/schema/util";

/** What the words read of a GitHub event (GithubEvent in @rsva/schema). */
export interface GithubDeed {
  verb: "branch" | "opened" | "ready" | "merged" | "pushed";
  /** GitHub login. */
  by: string;
  /** The pull request closes the issue when merged; false: it only links. */
  closing: boolean;
}

const VERB: Record<GithubDeed["verb"], string> = { branch: "created", opened: "opened", ready: "marked ready", merged: "merged", pushed: "pushed" };

/**
 * The feed line of what GitHub did. The server sends an event with no state move only for a merge or a pushed commit, so
 * those are the lines besides the move: who starts the line, and the verb after what it is about.
 */
export function githubWords(gh: GithubDeed, moved: boolean): { line: "moved" | "merged" | "pushed"; who: string | null; verb: string; stays: boolean } {
  const verb = VERB[gh.verb];
  if (moved) return { line: "moved", who: "GitHub", verb, stays: false };
  if (gh.verb === "merged") return { line: "merged", who: null, verb, stays: !gh.closing };
  return { line: "pushed", who: gh.by, verb, stays: false };
}

/** A pull request still waiting on its review and checks; once merged or closed they say nothing, so every screen shows the state instead. */
export const pullLive = (state: string | null | undefined): boolean => state !== "merged" && state !== "closed";

/** The checks in a row (PullChecks in @rsva/schema): the full words, and a phone's short ones. */
export function checksName(checks: "pass" | "fail" | "run", failing: number): { full: string; short: string } {
  if (checks === "pass") return { full: "Checks passing", short: "Passing" };
  if (checks === "run") return { full: "Checks running", short: "Running" };
  return { full: `${plural(failing, "check")} failing`, short: `${failing} failing` };
}
