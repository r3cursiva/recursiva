// The Plane DB → bundle mapping on small synthetic rows (no real data).
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeReaction, planeMarkdown } from "@rsva/connector-plane/plane";
import type { BundleComment, BundleIssue, BundleLine, BundleReaction, BundleSubscription, BundleUser } from "@rsva/schema/bundle";
import { archivedMoment, liveTargets, threadComments, toBundle, type PlaneComment, type PlaneRows } from "../src/map.ts";

const T = "2026-10-01T10:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T) + min * 60_000).toISOString();
const DEL = "2026-10-02T00:00:00.000Z";

function rows(over: Partial<PlaneRows> = {}): PlaneRows {
  return {
    workspace: { id: "w", slug: "acme", name: "Acme", ownerId: "u-owner" },
    users: [
      { id: "u-owner", email: "owner@example.com", displayName: "Owner", firstName: null, lastName: null, isBot: false },
      { id: "u-bot", email: "bot@example.com", displayName: "", firstName: "Bot", lastName: "One", isBot: false },
      { id: "u-gone", email: "gone@example.com", displayName: "Gone", firstName: null, lastName: null, isBot: false },
    ],
    members: [
      { userId: "u-owner", role: 20, isActive: true, deletedAt: null },
      { userId: "u-bot", role: 15, isActive: true, deletedAt: null },
      { userId: "u-gone", role: 20, isActive: false, deletedAt: null },
    ],
    projects: [{ id: "p", identifier: "AC", name: "Acme", createdAt: T, archivedAt: null, deletedAt: null }],
    states: [
      { id: "s-todo", projectId: "p", name: "Todo", group: "unstarted", color: "#000", sequence: 1, isDefault: true, isTriage: false, deletedAt: null },
      { id: "s-triage", projectId: "p", name: "Triage", group: "triage", color: "#000", sequence: 2, isDefault: false, isTriage: true, deletedAt: null },
    ],
    labels: [
      { id: "l-a", projectId: "p", parentId: null, name: "a", color: "#111", sortOrder: 1, deletedAt: null },
      { id: "l-b", projectId: "p", parentId: "l-a", name: "b", color: "#222", sortOrder: 2, deletedAt: null },
      { id: "l-x", projectId: "p", parentId: null, name: "x", color: "#333", sortOrder: 3, deletedAt: DEL },
    ],
    issues: [issue("i1", 1), issue("i2", 2, { parentId: "i1", archivedAt: "2026-10-05", priority: "urgent" })],
    assignees: [],
    issueLabels: [],
    comments: [],
    reactions: [],
    archiveEvents: [],
    relations: [],
    links: [],
    subscriptions: [],
    assets: [],
    ...over,
  };
}

function issue(id: string, n: number, over: Partial<PlaneRows["issues"][number]> = {}): PlaneRows["issues"][number] {
  return {
    id, projectId: "p", sequenceId: n, name: `Issue ${n}`, stateId: "s-todo", priority: "none", parentId: null, startDate: null,
    targetDate: null, sortOrder: n * 1000, createdById: "u-owner", createdAt: T, updatedAt: T, completedAt: null, archivedAt: null,
    isDraft: false, descriptionHtml: null, deletedAt: null, ...over,
  };
}

function comment(id: string, min: number, over: Partial<PlaneComment> = {}): PlaneComment {
  return {
    id, issueId: "i1", parentId: null, actorId: "u-owner", createdById: "u-owner", commentHtml: `<p>${id}</p>`, createdAt: at(min),
    editedAt: null, deletedAt: null, ...over,
  };
}

const pick = <M extends BundleLine["m"]>(lines: BundleLine[], m: M) => lines.filter((l): l is Extract<BundleLine, { m: M }> => l.m === m);

test("only live assignee and label rows count: Plane soft-deletes and recreates them on every edit", () => {
  const links = [
    { issueId: "i1", targetId: "u-bot", createdAt: at(0), deletedAt: at(5) }, // removed
    { issueId: "i1", targetId: "u-owner", createdAt: at(0), deletedAt: at(5) }, // recreated below
    { issueId: "i1", targetId: "u-owner", createdAt: at(5), deletedAt: null },
    { issueId: "i1", targetId: "u-owner", createdAt: at(6), deletedAt: null }, // a duplicate live row
    { issueId: "i2", targetId: "u-bot", createdAt: at(1), deletedAt: null },
    { issueId: "i2", targetId: "u-owner", createdAt: at(0), deletedAt: null },
  ];
  assert.deepEqual(Object.fromEntries(liveTargets(links)), { i1: ["u-owner"], i2: ["u-owner", "u-bot"] });

  const { lines, report } = toBundle(rows({
    assignees: links,
    issueLabels: [
      { issueId: "i1", targetId: "l-b", createdAt: at(0), deletedAt: null },
      { issueId: "i1", targetId: "l-a", createdAt: at(0), deletedAt: DEL },
      { issueId: "i1", targetId: "l-x", createdAt: at(0), deletedAt: null }, // the label itself is deleted
    ],
  }));
  const [i1, i2] = pick(lines, "Issue");
  assert.deepEqual(i1!.assignees, [{ ext: "u-owner" }]);
  assert.deepEqual(i2!.assignees, [{ ext: "u-owner" }, { ext: "u-bot" }]);
  assert.deepEqual(i1!.labels, [{ ext: "l-b" }]);
  assert.equal(report.assigneeLinks, 3);
  assert.equal(report.labelLinks, 1);
});

test("users, roles, owner, agents; issues, states, labels and the archive date", () => {
  const { header, lines, report } = toBundle(rows({
    issues: [
      issue("i1", 1),
      issue("i2", 2, { parentId: "i1", archivedAt: "2026-10-05", priority: "urgent" }),
      issue("i3", 3, { archivedAt: "2026-10-06" }),
      issue("i-del", 4, { deletedAt: DEL }),
      issue("i-draft", 5, { isDraft: true }),
      issue("i-triage", 6, { stateId: "s-triage" }),
      issue("i-orphan", 7, { parentId: "i-del" }),
    ],
    archiveEvents: [
      { issueId: "i2", at: "2026-10-05T14:30:00.000Z" },
      { issueId: "i2", at: "2026-10-01T09:00:00.000Z" }, // an older archive, undone since
    ],
  }));
  assert.deepEqual(header, { m: "Bundle", version: 1, source: "plane", workspace: { slug: "acme", name: "Acme" }, owner: { ext: "u-owner" } });
  const users = pick(lines, "User");
  assert.deepEqual(users.map((u) => [u.ext, u.name, u.kind, u.role]), [
    ["u-owner", "Owner", "human", "admin"],
    ["u-bot", "Bot One", "agent", "member"],
    ["u-gone", "Gone", "human", null],
  ] satisfies [string, string, BundleUser["kind"], BundleUser["role"]][]);
  assert.deepEqual(pick(lines, "State").map((s) => s.ext), ["s-todo"]);
  assert.deepEqual(pick(lines, "Label").map((l) => [l.ext, l.parent?.ext ?? null]), [["l-a", null], ["l-b", "l-a"]]);

  const issues = pick(lines, "Issue");
  assert.deepEqual(issues.map((i) => i.ext), ["i1", "i2", "i3", "i-orphan"]);
  const i2 = issues[1]!;
  assert.deepEqual([i2.number, i2.priority, i2.parent, i2.archivedAt], [2, 1, { ext: "i1" }, "2026-10-05T14:30:00.000Z"]);
  assert.equal(issues[2]!.archivedAt, "2026-10-06T00:00:00.000Z");
  assert.equal(issues[3]!.parent, null);
  assert.deepEqual([report.issuesDeletedSkipped, report.issuesDraftSkipped, report.issuesTriageSkipped], [1, 1, 1]);
});

test("archivedMoment: the activity's time on the same UTC date, else midnight UTC", () => {
  assert.equal(archivedMoment("2026-10-05", ["2026-10-05T23:59:00Z", "2026-10-05T01:00:00Z"]), "2026-10-05T23:59:00.000Z");
  assert.equal(archivedMoment("2026-10-05", ["2026-10-04T23:59:00Z"]), "2026-10-05T00:00:00.000Z");
  assert.equal(archivedMoment("2026-10-05"), "2026-10-05T00:00:00.000Z");
});

test("replies thread one level deep; a deleted top comment with live replies stays as a tombstone", () => {
  const comments = [
    comment("c1", 0),
    comment("r1", 1, { parentId: "c1" }),
    comment("r2", 2, { parentId: "r1" }), // a reply to a reply hangs under the thread's top comment
    comment("d1", 3, { deletedAt: DEL }),
    comment("r3", 4, { parentId: "d1" }),
    comment("r4", 5, { parentId: "d1" }),
    comment("d2", 6, { deletedAt: DEL }), // deleted, no replies: not moved
    comment("r5", 7, { parentId: "hard-deleted" }), // its parent is gone from the database
    comment("r6", 8, { parentId: "c1", deletedAt: DEL }),
  ];
  assert.deepEqual(threadComments(comments).map((t) => [t.comment.id, t.parentId, t.tombstone]), [
    ["d1", null, true],
    ["c1", null, false],
    ["r1", "c1", false],
    ["r2", "c1", false],
    ["r3", "d1", false],
    ["r4", "d1", false],
    ["r5", null, false],
  ]);

  const { lines, report } = toBundle(rows({ comments }));
  const out = pick(lines, "Comment");
  const d1 = out.find((c) => c.ext === "d1")!;
  assert.deepEqual([d1.body, d1.deletedAt, d1.parent], ["", DEL, null]);
  assert.equal(out.find((c) => c.ext === "r2")!.parent?.ext, "c1");
  assert.equal(out.find((c) => c.ext === "c1")!.body, "c1");
  assert.equal(out.find((c) => c.ext === "c1")!.deletedAt, null);
  assert.deepEqual([report.commentsTop, report.replies, report.commentTombstones, report.repliesPromoted, report.repliesReparented], [2, 4, 1, 1, 1]);
});

test("reactions: code points decode to emoji; deleted, duplicate and dangling ones are skipped", () => {
  assert.equal(decodeReaction("128077"), "👍");
  assert.equal(decodeReaction("10084-65039"), "❤️");
  assert.equal(decodeReaction("🎉"), "🎉");
  assert.equal(decodeReaction("0"), null);
  assert.equal(decodeReaction("55357"), null); // a lone surrogate
  assert.equal(decodeReaction("<b>"), null);

  const r = (id: string, over: Partial<PlaneRows["reactions"][number]>) => ({
    id, issueId: "i1", commentId: null, actorId: "u-owner", reaction: "128077", createdAt: at(Number(id.slice(1))), deletedAt: null, ...over,
  });
  const { lines, report } = toBundle(rows({
    comments: [comment("c1", 0), comment("c2", 1, { deletedAt: DEL })],
    reactions: [
      r("r1", {}),
      r("r2", { deletedAt: DEL, reaction: "128078" }),
      r("r3", {}), // the same user, emoji and issue again
      r("r4", { issueId: null, commentId: "c1", reaction: "128640", actorId: "u-bot" }),
      r("r5", { issueId: null, commentId: "c2" }), // on a deleted comment
      r("r6", { actorId: "u-stranger" }),
      r("r7", { reaction: "x" }),
    ],
  }));
  assert.deepEqual(pick(lines, "Reaction"), [
    { m: "Reaction", ext: "r1", issue: { ext: "i1" }, comment: null, user: { ext: "u-owner" }, emoji: "👍", createdAt: at(1) },
    { m: "Reaction", ext: "r4", issue: { ext: "i1" }, comment: { ext: "c1" }, user: { ext: "u-bot" }, emoji: "🚀", createdAt: at(4) },
  ] satisfies BundleReaction[]);
  assert.deepEqual([report.issueReactions, report.commentReactions, report.reactionsDuplicate, report.reactionsSkipped], [1, 1, 1, 3]);
});

test("Plane HTML → Markdown: structure, rules, mentions with names, images as links", () => {
  const html = [
    "<h2>Plan</h2>",
    "<p>Text with <strong>bold</strong>, <code>code</code> and a <a href=\"https://example.com/x\">link</a>.</p>",
    "<ul><li><p>one</p></li><li><p>two</p></li></ul>",
    "<ul data-type=\"taskList\"><li data-type=\"taskItem\" data-checked=\"true\"><label><input type=\"checkbox\"></label><div><p>done</p></div></li></ul>",
    "<div data-type=\"horizontalRule\"><div></div></div>",
    "<pre><code class=\"language-ts\">const a = 1;</code></pre>",
    "<p>Ping <mention-component id=\"m1\" entity_identifier=\"5f1c2a3b-0d4e-4f60-8a71-92b3c4d5e6f7\" entity_name=\"user_mention\"></mention-component>, <em><mention-component entity_identifier=\"u-gone\" entity_name=\"user_mention\"></mention-component></em> too</p>",
    "<image-component src=\"0b9c1f8e-6a1d-4c11-9a52-6d1f0b2e7c11\" width=\"100\"></image-component>",
    "<image-component width=\"100\"></image-component>",
    "<attachment-component id=\"a1\"></attachment-component>",
  ].join("");
  const stats = { mentions: 0, mentionsAsText: 0, images: 0, imagesDropped: 0, attachmentsDropped: 0 };
  const md = planeMarkdown(html, { userName: (id) => (id === "5f1c2a3b-0d4e-4f60-8a71-92b3c4d5e6f7" ? "Bot One" : undefined), assetUrl: (id) => `https://plane.test/a/${id}/` }, stats);
  assert.equal(
    md,
    [
      "## Plan",
      "",
      "Text with **bold**, `code` and a [link](https://example.com/x).",
      "",
      "- one",
      "- two",
      "",
      "* [x] done", // adjacent lists alternate the marker so they stay two lists
      "",
      "---",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      // A known user is a mention of the bundle's user by ext (RSVA-42); one the bundle lacks stays text.
      "Ping [@Bot One](mention:5f1c2a3b-0d4e-4f60-8a71-92b3c4d5e6f7), *@user* too",
      "",
      "[image](https://plane.test/a/0b9c1f8e-6a1d-4c11-9a52-6d1f0b2e7c11/)",
    ].join("\n"),
  );
  assert.deepEqual(stats, { mentions: 1, mentionsAsText: 1, images: 1, imagesDropped: 1, attachmentsDropped: 1 });

  const { lines } = toBundle(rows({ issues: [issue("i1", 1, { descriptionHtml: "<p>Hi <em>there</em></p><p></p>" })] }));
  assert.equal((pick(lines, "Issue")[0] as BundleIssue).description, "Hi *there*");
  const { lines: noAssets } = toBundle(rows({ comments: [comment("c1", 0, { commentHtml: "<image-component src=\"0b9c1f8e-6a1d-4c11-9a52-6d1f0b2e7c11\"></image-component>" })] }));
  assert.equal((pick(noAssets, "Comment")[0] as BundleComment).body, "");
});

test("relations land on the end Plane stores them on; a pair keeps one; Gantt relations are counted, not moved", () => {
  const rel = (id: string, issueId: string, relatedId: string, type: string) => ({ id, issueId, relatedId, type, deletedAt: null });
  const { lines, report } = toBundle(
    rows({
      issues: [issue("i1", 1), issue("i2", 2), issue("i3", 3)],
      relations: [
        rel("r1", "i1", "i2", "blocked_by"),
        rel("r2", "i2", "i1", "relates_to"), // the same pair again
        rel("r3", "i3", "i1", "duplicate"),
        rel("r4", "i2", "i3", "start_before"),
        rel("r5", "i1", "gone", "blocked_by"),
        rel("r6", "i3", "i2", "duplicate"), // i3 duplicates i1 already: goes on i2's end
      ],
    }),
  );
  const byExt = new Map(pick(lines, "Issue").map((i) => [i.ext, i]));
  assert.deepEqual(byExt.get("i1")!.blockedBy, [{ ext: "i2" }]);
  assert.equal(byExt.get("i2")!.related, undefined);
  assert.deepEqual(byExt.get("i3")!.duplicateOf, { ext: "i1" });
  assert.deepEqual(byExt.get("i2")!.duplicateOf, { ext: "i3" });
  assert.deepEqual([report.relations, report.relationsDuplicate, report.relationsUnsupported, report.relationsSkipped], [3, 1, 1, 1]);
});

test("links: a pull request mirrored into issue_links moves once, with the PR's title; links of skipped issues stay", () => {
  const link = (id: string, issueId: string, url: string, source: "link" | "github", title: string | null = null) =>
    ({ id, issueId, url, title, createdById: source === "link" ? "u-owner" : null, createdAt: T, deletedAt: null, source });
  const pr = "https://github.com/acme/app/pull/7";
  const { lines, report } = toBundle(
    rows({
      links: [
        link("l1", "i1", pr, "link", "https://github.com/acme/app/pull/7"),
        link("g1", "i1", pr, "github", "Fix the login"),
        link("l2", "i1", " https://example.com/spec ", "link", "Spec"),
        link("l3", "nope", "https://example.com", "link"),
      ],
    }),
  );
  const links = pick(lines, "Link");
  assert.deepEqual(links.map((l) => [l.ext, l.url, l.title]), [["g1", pr, "Fix the login"], ["l2", "https://example.com/spec", "Spec"]]);
  assert.deepEqual(links[1]!.createdBy, { ext: "u-owner" });
  assert.deepEqual([report.githubLinks, report.links, report.linksDuplicate, report.linksSkipped], [1, 1, 1, 1]);
});

test("subscriptions: live ones on moved issues by known users, one per person and issue", () => {
  const s = (id: string, over: Partial<PlaneRows["subscriptions"][number]> = {}) => ({
    id, issueId: "i1", subscriberId: "u-bot", createdAt: at(Number(id.slice(1))), deletedAt: null, ...over,
  });
  const { lines, report } = toBundle(rows({
    subscriptions: [s("s1"), s("s2"), s("s3", { deletedAt: DEL, issueId: "i2" }), s("s4", { subscriberId: "u-stranger" }), s("s5", { issueId: "i-gone" })],
  }));
  assert.deepEqual(pick(lines, "Subscription"), [{ m: "Subscription", ext: "s1", issue: { ext: "i1" }, user: { ext: "u-bot" } }] satisfies BundleSubscription[]);
  assert.deepEqual([report.subscriptions, report.subscriptionsSkipped], [1, 3]);
});

test("images whose bytes moved become the workspace's files, issue attachments File lines; the rest stays a link", () => {
  const asset = (id: string, over: Partial<PlaneRows["assets"][number]> = {}) => ({
    id, entityType: "ISSUE_DESCRIPTION", issueId: "i1", name: `${id}.png`, type: "image/png", createdById: null, createdAt: "2026-01-01T00:00:00.000Z", deletedAt: null, ...over,
  });
  const moved = "00000000-0000-4000-8000-000000000001";
  const linked = "00000000-0000-4000-8000-000000000002";
  const unused = "00000000-0000-4000-8000-000000000003";
  const sha = "a".repeat(64);
  const { lines, report } = toBundle(
    rows({
      issues: [issue("i1", 1, { descriptionHtml: `<image-component src="${moved}"></image-component><image-component src="${linked}"></image-component>` })],
      assets: [
        asset(moved),
        asset(linked),
        asset(unused),
        asset("att", { entityType: "ISSUE_ATTACHMENT", name: "report.pdf", type: "application/pdf" }),
        asset("gone", { entityType: "ISSUE_ATTACHMENT", deletedAt: "2026-02-01T00:00:00.000Z" }),
      ],
    }),
    { assetHash: (id) => (id === linked ? null : sha), assetUrl: (id) => `https://plane.example/${id}` },
  );
  const description = lines.find((l) => l.m === "Issue")!.description!;
  assert.match(description, new RegExp(`^!\\[image\\]\\(/files/[a-z-]+/${sha}\\)$`, "m"));
  assert.match(description, new RegExp(`https://plane.example/${linked}`));
  assert.deepEqual(
    lines.filter((l) => l.m === "File").map((f) => [f.ext, f.issue?.ext ?? null]),
    [[moved, null], ["att", "i1"]],
  );
  assert.equal(report.filesInText, 1);
  assert.equal(report.filesAttached, 1);
});
