import assert from "node:assert/strict";
import { test } from "node:test";
import type { GithubEvent, GithubLink } from "@rsva/schema/models";
import { checksName, githubWords, pullLive } from "@rsva/display/github";
import { githubRows, pullLabel, pullRef } from "./github.ts";

const link = (over: Partial<GithubLink>): GithubLink => ({
  id: "x", issueId: "i", kind: "pull", repo: "acme/infra", number: 1, sha: null, title: "T", state: "open", head: "h", base: "main",
  review: null, checks: null, failing: 0, author: "a", authorBot: false, at: "2026-10-30T10:00:00Z", closing: true, ...over,
});

test("pull requests go by state, the latest first; commits newest first, apart", () => {
  const rows = githubRows([
    link({ id: "closed", state: "closed", at: "2026-10-31T10:00:00Z" }),
    link({ id: "merged", state: "merged" }),
    link({ id: "open old", at: "2026-10-29T10:00:00Z" }),
    link({ id: "c old", kind: "commit", state: null, at: "2026-10-29T10:00:00Z" }),
    link({ id: "draft", state: "draft" }),
    link({ id: "open new" }),
    link({ id: "c new", kind: "commit", state: null }),
  ]);
  assert.deepEqual(rows.pulls.map((l) => l.id), ["open new", "open old", "draft", "merged", "closed"]);
  assert.deepEqual(rows.commits.map((l) => l.id), ["c new", "c old"]);
});

test("a row's words", () => {
  assert.equal(pullRef({ repo: "acme/obase", number: 57 }), "obase#57");
  assert.deepEqual(checksName("fail", 2), { full: "2 checks failing", short: "2 failing" });
  assert.deepEqual(checksName("fail", 1), { full: "1 check failing", short: "1 failing" });
  assert.deepEqual(checksName("pass", 0), { full: "Checks passing", short: "Passing" });
});

const event = (over: Partial<GithubEvent>): GithubEvent => ({ verb: "merged", repo: "o/r", number: 1, sha: null, title: "T", state: "merged", by: "dan", closing: true, at: "2026-10-30T10:00:00Z", ...over });

test("a state move is GitHub's line, with what moved it", () => {
  assert.deepEqual(githubWords(event({ verb: "opened" }), true), { line: "moved", who: "GitHub", verb: "opened", stays: false });
  assert.equal(githubWords(event({ verb: "ready" }), true).verb, "marked ready");
  assert.equal(githubWords(event({ verb: "branch" }), true).verb, "created");
  assert.equal(githubWords(event({ verb: "pushed" }), true).verb, "pushed");
  assert.equal(githubWords(event({ closing: false }), true).stays, false);
});

test("a merge without a move names nobody first; only a Linked one says the state stays", () => {
  assert.deepEqual(githubWords(event({}), false), { line: "merged", who: null, verb: "merged", stays: false });
  assert.deepEqual(githubWords(event({ closing: false }), false), { line: "merged", who: null, verb: "merged", stays: true });
});

test("a commit without a move is its author's line", () => {
  assert.deepEqual(githubWords(event({ verb: "pushed", number: null, sha: "abc", state: null }), false), { line: "pushed", who: "dan", verb: "pushed", stays: false });
});

test("a pull request is named by its number alone while every one shown is of one repository", () => {
  const a = link({ repo: "r3cursiva/recursiva", number: 387 });
  const b = link({ repo: "r3cursiva/infra", number: 5 });
  assert.equal(pullLabel(a, [a, link({ repo: a.repo, number: 1 })]), "#387");
  assert.equal(pullLabel(a, [a, b]), "recursiva#387");
});

test("a merged or closed pull request has no live checks or review to show, on any screen", () => {
  assert.equal(pullLive("merged"), false);
  assert.equal(pullLive("closed"), false);
  for (const state of ["open", "draft", null, undefined]) assert.equal(pullLive(state), true);
});
