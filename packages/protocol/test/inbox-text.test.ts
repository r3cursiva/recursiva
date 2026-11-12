import assert from "node:assert/strict";
import { test } from "node:test";
import { commentLine, inboxEvent, INBOX_TEXT_MAX, type InboxContext } from "../src/inbox.ts";

test("a comment reads as one plain line: mentions and links as their text, marks off, cut to the limit", () => {
  assert.equal(commentLine("## Done\n\n- [x] **deployed** to `prod`, see [the run](https://x.test/1)\n> quoted ![shot](a.png)"), "Done deployed to prod, see the run quoted");
  assert.equal(commentLine("[@Ann](mention:0190a000-0000-7000-8000-000000000001) take a look"), "@Ann take a look");
  const long = commentLine("word ".repeat(100));
  assert.equal(long.length <= INBOX_TEXT_MAX, true);
  assert.equal(long.endsWith("…"), true);
  assert.equal(commentLine("![only a picture](a.png)"), "");
});

test("a comment's event carries its first line; a state change carries none", () => {
  const ctx: InboxContext = { me: "me", issue: () => ({ createdById: "me", assigneeIds: [] }), stage: () => undefined, group: () => undefined, reviews: () => false, commented: () => false, inThread: () => false, mark: () => undefined };
  const comment = inboxEvent({ id: 7, m: "Comment", a: "I", mid: "c1", by: "bot", d: { issueId: "i1", body: "Tests pass, **opening** a pull request" } }, undefined, "2026-11-10T00:00:00Z", ctx);
  assert.deepEqual(comment, { id: 7, by: "bot", at: "2026-11-10T00:00:00Z", issueId: "i1", commentId: "c1", kind: "comment", text: "Tests pass, opening a pull request" });
  const moved = inboxEvent({ id: 8, m: "Issue", a: "U", mid: "i1", by: "bot", d: { stateId: "done" } }, [], "2026-11-10T00:00:00Z", ctx);
  assert.equal(moved && "text" in moved, false);
});

test("Done is news unless the viewer chose it: out of approval for nobody, out of review not for who reviews", () => {
  const stages: Record<string, "progress" | "review" | "approved"> = { doing: "progress", review: "review", approved: "approved" };
  const ctx = (reviews: boolean): InboxContext => ({
    me: "me",
    issue: () => ({ createdById: reviews ? "me" : "bot", assigneeIds: ["me"] }),
    stage: (id) => stages[id],
    group: (id) => (id === "done" ? "completed" : id === "cancelled" ? "cancelled" : "started"),
    reviews: () => reviews,
    commented: () => false,
    inThread: () => false,
    mark: () => undefined,
  });
  const move = (to: string, from: string | null, reviews: boolean) => inboxEvent({ id: 9, m: "Issue", a: "U", mid: "i1", by: "github", d: { stateId: to } }, [], "2026-11-10T00:00:00Z", ctx(reviews), from)?.kind ?? null;
  assert.equal(move("done", "approved", true), null);
  assert.equal(move("done", "approved", false), null, "approved was the news; Done is what it was for");
  assert.equal(move("done", "review", true), null, "the reviewer merged it");
  assert.equal(move("done", "review", false), "state", "the one whose work it was hears it was accepted");
  assert.equal(move("done", "doing", true), "state", "closed past the review");
  assert.equal(move("done", null, true), "state", "nothing known of where it was");
  assert.equal(move("cancelled", "review", true), "state", "a refusal is news");
});
