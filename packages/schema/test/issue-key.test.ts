import assert from "node:assert/strict";
import { test } from "node:test";
import { ISSUE_KEY, branchName, issueKey, issuePath, parseIssueKey, projectsByKey } from "../src/models.ts";

test("an issue key parses in any case, to the project key in upper case", () => {
  assert.deepEqual(parseIssueKey("PLNR-27"), { projectKey: "PLNR", number: 27 });
  assert.deepEqual(parseIssueKey("plnr-27"), { projectKey: "PLNR", number: 27 });
  assert.deepEqual(parseIssueKey("Infra2-3"), { projectKey: "INFRA2", number: 3 });
  assert.equal(issueKey("PLNR", 27), "PLNR-27");
});

test("an issue key's number goes up to what an int4 column holds", () => {
  assert.deepEqual(parseIssueKey("LAS-2147483647"), { projectKey: "LAS", number: 2147483647 });
  for (const s of ["LAS-2147483648", "LAS-9999999999", "LAS-12345678901", "LAS-0", "LAS-027"]) assert.equal(parseIssueKey(s), null, s);
});

test("only a whole key parses: a project key as PROJECT_KEY has it, one dash, a number", () => {
  assert.deepEqual(parseIssueKey("ABCDEFGHIJKL-1"), { projectKey: "ABCDEFGHIJKL", number: 1 });
  for (const s of ["ABCDEFGHIJKLM-1", "2PLNR-1", "PLNR-1-2", "PLNR_X-1", "PLNR-", "-1", "PLNR 1", " PLNR-1", "PLNR-1 ", "a/PLNR-1", "PLNR-1x", ""])
    assert.equal(parseIssueKey(s), null, JSON.stringify(s));
  // The source is for larger patterns: a branch name builds on it.
  assert.equal(new RegExp(`^${ISSUE_KEY}$`).test("PLNR-27"), true);
  assert.equal(branchName("PLNR-414", "Follow-up to opto-12 and plnr-9"), "plnr-414-follow-up-to-and");
});

test("an issue's path is its workspace and key", () => {
  assert.equal(issuePath("arsen", "PLNR-27"), "/arsen/browse/PLNR-27");
});

test("projects by key: a former key finds its project, a current key wins", () => {
  const a = { key: "NEW", formerKeys: ["OLD"] };
  const b = { key: "OLD2", formerKeys: [] };
  const byKey = projectsByKey([a, b]);
  assert.equal(byKey.get("NEW"), a);
  assert.equal(byKey.get("OLD"), a);
  assert.equal(byKey.get("OLD2"), b);
  assert.equal(projectsByKey([{ key: "X", formerKeys: [] }, { key: "Y", formerKeys: ["X"] }]).get("X")?.key, "X");
});
