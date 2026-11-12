import assert from "node:assert/strict";
import { test } from "node:test";
import { jaccard, OTHER_PROJECT, SHOWN, similarIssues, STRONG, trigrams, type SimilarCandidate } from "../src/similar.ts";

let n = 0;
const issue = (title: string, over: Partial<SimilarCandidate> = {}): SimilarCandidate => ({ id: `i${++n}`, title, projectId: "p1", stateId: "todo", archivedAt: null, deletedAt: null, ...over });
const group = (i: SimilarCandidate) => (i.stateId === "done" ? "completed" : i.stateId === "no" ? "cancelled" : "unstarted");
const scores = (probe: string, issues: SimilarCandidate[], opts = {}): [string, number][] => similarIssues(probe, issues, group, opts).map((m) => [m.issue.title, Math.round(m.score * 100) / 100]);

test("trigrams are pg_trgm's: each word padded with two spaces before and one after, in lower case", () => {
  assert.deepEqual([...trigrams("Cat")].sort(), ["  c", " ca", "at ", "cat"]);
  assert.deepEqual([...trigrams("a-b")].sort(), ["  a", "  b", " a ", " b "]);
  assert.equal(trigrams("--- !!!").size, 0);
  // A letter outside the BMP is one character.
  assert.deepEqual([...trigrams("𝒜")].sort(), ["  𝒜", " 𝒜 "]);
});

test("jaccard: |A ∩ B| / |A ∪ B|, 0 for an empty side", () => {
  assert.equal(jaccard(trigrams("cat"), trigrams("cat")), 1);
  assert.equal(jaccard(trigrams("cat"), trigrams("dog")), 0);
  assert.equal(jaccard(trigrams(""), trigrams("cat")), 0);
  assert.equal(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"])), 0.5);
});

test("an exact title scores 1, reordered words and another case too", () => {
  const pool = [issue("Fix the login redirect"), issue("Update the billing page")];
  assert.deepEqual(scores("Fix the login redirect", pool), [["Fix the login redirect", 1]]);
  assert.deepEqual(scores("redirect login the fix", pool), [["Fix the login redirect", 1]]);
  assert.deepEqual(scores("FIX THE LOGIN REDIRECT", pool), [["Fix the login redirect", 1]]);
});

test("a typo costs a few trigrams, a different subject scores nothing", () => {
  const pool = [issue("Notifications: reply by email posts a comment"), issue("Resize the list and issue columns with the mouse")];
  const [typo] = similarIssues("Notificatons: reply by emial posts a comment", pool, group);
  assert.equal(typo!.issue.title, "Notifications: reply by email posts a comment");
  assert.ok(typo!.score >= SHOWN && typo!.score < 1, String(typo!.score));
  assert.deepEqual(scores("Rotate the Caddy access logs weekly", pool), []);
});

test("Cyrillic and digits take part; punctuation and key-like words only split", () => {
  const pool = [issue("Бэкап почты на NAS1 не завершился"), issue("PLNR-12 backup of mail")];
  assert.deepEqual(scores("бэкап ПОЧТЫ на nas1 не завершился", pool), [["Бэкап почты на NAS1 не завершился", 1]]);
  assert.deepEqual(scores("backup of mail PLNR 12", pool), [["PLNR-12 backup of mail", 1]]);
});

test("the shown floor and the strong threshold: a near-duplicate is strong, a related title is only shown", () => {
  const original = issue("perf:net fails main at random: issue page, warm sits at the budget on CI");
  const near = scores("perf:net fails main at random: issue page warm sits at the budget on CI", [original]);
  assert.ok(near[0]![1] >= STRONG, String(near[0]![1]));
  const related = similarIssues("perf:net fails on main: kept activity, first fill over the baseline", [original], group, { floor: 0 })[0]!;
  assert.ok(related.score < STRONG);
});

test("closed, archived and deleted issues never match", () => {
  const title = "Same words everywhere";
  const pool = [
    issue(title),
    issue(title, { stateId: "done" }),
    issue(title, { stateId: "no" }),
    issue(title, { archivedAt: "2026-11-01 00:00:00+00" }),
    issue(title, { deletedAt: "2026-11-01 00:00:00+00" }),
  ];
  const found = similarIssues(title, pool, group);
  assert.deepEqual(found.map((m) => m.issue.id), [pool[0]!.id]);
});

test("the issue itself is not its own match", () => {
  const a = issue("Delegate an issue to an agent from the UI");
  const b = issue("Delegate an issue to an agent from the UI, with its state");
  assert.deepEqual(similarIssues(a.title, [a, b], group, { exclude: a.id }).map((m) => m.issue.id), [b.id]);
});

test("best first, at most `limit`, nothing under the floor", () => {
  const pool = [issue("Sign-in code by email"), issue("Sign-in code by email is slow"), issue("Sign-in code"), issue("Sign-in"), issue("Billing")];
  const found = similarIssues("Sign-in code by email", pool, group, { limit: 2 });
  assert.deepEqual(found.map((m) => m.issue.title), ["Sign-in code by email", "Sign-in code by email is slow"]);
  assert.ok(found[0]!.score >= found[1]!.score);
  assert.equal(similarIssues("Sign-in code by email", pool, group, { floor: 0.99 }).length, 1);
});

test("a candidate in another project counts at OTHER_PROJECT of its score: per-site twins stay under STRONG", () => {
  const title = "Check whether upload files are served by Next as static files";
  const mine = issue(title);
  const other = issue(title, { projectId: "p2" });
  const found = similarIssues(title, [other, mine], group, { projectId: "p1" });
  assert.deepEqual(found.map((m) => [m.issue.id, m.score]), [[mine.id, 1], [other.id, OTHER_PROJECT]]);
  // The twin of another site: the same sentence with one word changed scores about 0.86 raw, under STRONG there.
  const twin = issue("Check whether upload files are served by Express as static files", { projectId: "p2" });
  const raw = similarIssues(title, [twin], group)[0]!.score;
  assert.ok(raw > STRONG && raw * OTHER_PROJECT < STRONG, String(raw));
  assert.ok(similarIssues(title, [twin], group, { projectId: "p1" })[0]!.score >= SHOWN);
  // Without a project every candidate counts in full.
  assert.equal(similarIssues(title, [other], group)[0]!.score, 1);
});
