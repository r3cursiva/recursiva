// Markdown and HTML conversion. Fixtures in test/fixtures are invented Plane-shaped HTML (Tiptap output as Plane
// configures it), made for the editor comparison (docs/research/editors-2026-10-27.md); no real data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertLinear } from "@rsva/test-kit";
import { COMMENT_MAX } from "@rsva/schema/models";
import { Node } from "prosemirror-model";
import { DOC_MARKDOWN_MAX, docText, mentionIds, sameDoc, type DocMark, type DocNode } from "../src/doc.ts";
import { fromHtml } from "../src/html.ts";
import { fromMarkdown, markdownNormal, toMarkdown } from "../src/markdown.ts";
import { schema } from "../src/schema.ts";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}.html`, import.meta.url), "utf8");

/** The document fits the schema and is already in toJSON's canonical form. */
function valid(doc: DocNode): DocNode {
  const n = Node.fromJSON(schema, doc);
  n.check();
  assert.deepEqual(plain(n), doc, "canonical");
  return doc;
}

/** Empty paragraphs have no Markdown form: compare without them (except where the schema needs one). */
function withoutEmpty(n: DocNode): DocNode {
  if (!n.content) return n;
  const kids = n.content.map(withoutEmpty);
  const keep = kids.filter((c) => !(c.type === "paragraph" && !c.content));
  // An item starts with a paragraph: an empty one comes back only if the item has no other to start with.
  if (/item$/.test(n.type) && keep[0]?.type !== "paragraph") keep.unshift({ type: "paragraph" });
  return { ...n, content: keep.length ? keep : kids.slice(0, 1) };
}

/**
 * doc → Markdown → doc gives the document as Markdown carries it; realistic documents then stay the same Markdown
 * (`fixedPoint`). Random mark soup may still move a mark off a space on the second trip, which changes no text.
 */
function roundTrip(doc: DocNode, fixedPoint = true): string {
  valid(doc);
  const md = toMarkdown(doc);
  const back = valid(fromMarkdown(md));
  const want = withoutEmpty(markdownNormal(doc));
  if (!sameDoc(withoutEmpty(back), want)) assert.deepEqual(withoutEmpty(back), want, `round trip of:\n${md}`);
  // After the first trip the Markdown is a fixed point: saving a comment again does not rewrite it.
  const md2 = toMarkdown(back);
  if (fixedPoint) assert.equal(toMarkdown(fromMarkdown(md2)), md2, "stable");
  else assert.equal(docText(fromMarkdown(md2)), docText(back), "stable text");
  return md;
}

test("Plane descriptions: HTML → document → Markdown → the same document", () => {
  for (const name of ["rt1", "rt2", "rt3", "rt4", "rt5", "desc-3k5", "doc-50k"]) roundTrip(fromHtml(fixture(name)));
});

test("Markdown written from Plane HTML reads like hand-written Markdown", () => {
  assert.equal(
    toMarkdown(fromHtml(fixture("rt1"))),
    [
      "## Login fails after password reset",
      "",
      "After resetting the password the user is sent back to **/login** and sees *“Session expired”*. Reported by support, see [ticket 4812](https://example.com/tickets/4812).",
      "",
      "### Steps",
      "",
      "1. Open the reset link from the email.",
      "2. Set a new password with at least `12` characters.",
      "3. Submit the form and wait for the redirect.",
      "",
      "Expected: the user is logged in. ~~Actual: nothing happens.~~ Actual: a 401 from `/api/session`.",
      "",
    ].join("\n"),
  );
  assert.equal(
    toMarkdown(fromHtml(fixture("rt4"))),
    [
      "# Onboarding redesign",
      "",
      "The <u>new flow</u> must keep ***both*** entry points working. Links like [this one](https://example.com/a?b=1&c=2) must survive.",
      "",
      "**Background and research**",
      "",
      "Five interviews, three of them with admins.",
      "",
      "- Admins want bulk invite",
      "- Members want fewer steps",
      "",
      "Decision pending.",
      "",
    ].join("\n"),
  );
  const rt5 = toMarkdown(fromHtml(fixture("rt5")));
  assert.match(rt5, /^Line one of the address\\\nLine two of the address$/m);
  assert.match(rt5, /^- \[ \] Ask legal about the DPA\n {2}- \[x\] Send the draft\n {2}- \[ \] Get a signature\n- \[ \] Book the next call$/m);
  assert.match(rt5, /^3\. Third item continues numbering\n4\. Fourth item$/m);
  assert.match(rt5, /^Escaping: 2 \\\* 3 = 6, a_b_c, \\\[not a link\\\], # not a heading, 1\. not a list, \\<tag>\.$/m);
});

test("agent-written Markdown: CommonMark and GitHub forms", () => {
  const doc = fromMarkdown(
    [
      "# Title",
      "Some *em* and __strong__ and ~~gone~~, `code`, a [link](https://x.dev/a_(b)) and https://x.dev/c.",
      "",
      "Soft line",
      "continues.  ",
      "Hard break above.",
      "",
      "* one",
      "* two",
      "  1. nested",
      "",
      "- [x] done",
      "- [ ] todo",
      "",
      "> quoted",
      "> > nested",
      "",
      "~~~py",
      "print(1)",
      "~~~",
      "",
      "<details open><summary>More</summary>",
      "",
      "Hidden **text**.",
      "</details>",
      "",
      "***",
      "#### Deep heading",
    ].join("\n"),
  );
  valid(doc);
  const types = (doc.content ?? []).map((n) => n.type);
  assert.deepEqual(types, ["heading", "paragraph", "paragraph", "bullet_list", "task_list", "blockquote", "code_block", "paragraph", "paragraph", "horizontal_rule", "heading"]);
  const p = doc.content![1]!.content!;
  const marked = (t: string) => p.find((n) => n.text === t)?.marks?.map((m) => m.type + (m.attrs ? `(${m.attrs.href})` : ""));
  assert.deepEqual(marked("em"), ["italic"]);
  assert.deepEqual(marked("strong"), ["bold"]);
  assert.deepEqual(marked("gone"), ["strike"]);
  assert.deepEqual(marked("code"), ["code"]);
  assert.deepEqual(marked("link"), ["link(https://x.dev/a_(b))"]);
  assert.deepEqual(marked("https://x.dev/c"), ["link(https://x.dev/c)"]);
  assert.equal(docText(doc.content![2]!), "Soft line continues.\nHard break above.");
  assert.equal(doc.content![3]!.content![1]!.content![1]!.type, "ordered_list");
  assert.deepEqual(doc.content![4]!.content!.map((i) => i.attrs!.checked), [true, false]);
  assert.equal(doc.content![5]!.content![1]!.type, "blockquote");
  assert.deepEqual(doc.content![6]!.attrs, { language: "py" });
  // A collapsible section reads as its title in bold and its content (PLNR-378).
  assert.deepEqual(doc.content![7]!.content, [{ type: "text", text: "More", marks: [{ type: "bold" }] }]);
  assert.equal(docText(doc.content![8]!), "Hidden text.");
  assert.deepEqual(doc.content![10]!.attrs, { level: 3 });
});

test("emphasis follows CommonMark: nesting, intraword, flanking, rule of three", () => {
  const md = (s: string) => {
    const content = fromMarkdown(s).content![0]!.content ?? [];
    return content.map((n) => (n.marks?.length ? `${n.marks.map((m) => m.type[0]).join("")}(${n.text})` : n.text)).join("|");
  };
  assert.equal(md("***both***"), "bi(both)");
  assert.equal(md("**a *b* c**"), "b(a )|bi(b)|b( c)");
  assert.equal(md("*a **b** c*"), "i(a )|bi(b)|i( c)");
  assert.equal(md("snake_case_name and _x_"), "snake_case_name and |i(x)");
  assert.equal(md("un*frigging*believable"), "un|i(frigging)|believable");
  assert.equal(md("2 * 3 * 4"), "2 * 3 * 4");
  assert.equal(md("**bold** *it*"), "b(bold)| |i(it)");
  assert.equal(md("*foo**bar**baz*"), "i(foo)|bi(bar)|i(baz)");
  assert.equal(md("<u>under *it*</u>"), "u(under )|iu(it)");
  assert.equal(md("<strong>a<em>b</strong>c</em>"), "b(a<em>b)|c</em>");
  assert.equal(md("`**not bold**`"), "c(**not bold**)");
  assert.equal(md("\\*not\\* \\_em\\_"), "*not* _em_");
});

test("unsafe links keep their text and lose the link; raw HTML stays text", () => {
  const doc = fromMarkdown('[click](javascript:alert(1)) <img src=x onerror="alert(1)"> <script>x</script> [rel](/a) <mailto:a@b.dev>');
  const p = doc.content![0]!.content!;
  assert.equal(docText(doc), 'click <img src=x onerror="alert(1)"> <script>x</script> rel mailto:a@b.dev');
  assert.deepEqual(
    p.filter((n) => n.marks).map((n) => n.marks),
    [[{ type: "link", attrs: { href: "mailto:a@b.dev" } }]],
  );
});

test("hostile input stays linear and shallow", () => {
  const deep = ">".repeat(5000) + " x\n" + "- ".repeat(3000) + "y\n" + "<details>\n".repeat(500);
  valid(fromMarkdown(deep));
  const shapes: Record<string, (n: number) => string> = {
    emphasis: (n) => "*a ".repeat(n),
    code: (n) => "`a".repeat(n),
    links: (n) => "[a".repeat(n),
    tags: (n) => "<u>".repeat(n),
    underscores: (n) => "_".repeat(2 * n),
    strong: (n) => "**a".repeat((2 * n) / 3) + "b**".repeat((2 * n) / 3),
    words: (n) => "h ".repeat(n),
    pipes: (n) => "|".repeat(n) + "\n|-|\n",
    "table rows": (n) => "| a | b |\n| - | - |\n" + "|\n".repeat(n / 2),
    "delimiter rows": (n) => "a|\n|-|\n".repeat(n / 7),
  };
  // Linear against itself at the same moment, not a bound in milliseconds: a busy CI runner cannot fail it (PLNR-190).
  for (const [name, shape] of Object.entries(shapes)) {
    valid(fromMarkdown(shape(30_000)));
    assertLinear(name, shape, fromMarkdown, 30_000);
  }
});

// ── Property: any document of our schema survives Markdown ────────────────────────────────────────────────────────

let seed = 42;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const PEOPLE = ["01a184e8-6f14-7a63-9060-5c74bf8f8f89", "01a184e8-dbd6-74dd-8b9a-f68daf2497a5"];
const WORDS = ["a|b", "\\|", "|", "alpha", "beta", "2 * 3", "a_b", "_x", "[y]", "#tag", "1.", "- dash", "`tick`", "~", "~~", "<u>", "x&amp;y", "https://x.dev/p", "  ", " ", "end.", "😀", "**", "\\", "<b>", "*"];
const MARK_SETS: DocMark[][] = [[], [], [{ type: "bold" }], [{ type: "italic" }], [{ type: "bold" }, { type: "italic" }], [{ type: "strike" }], [{ type: "underline" }], [{ type: "code" }], [{ type: "link", attrs: { href: "https://x.dev/l" } }], [{ type: "link", attrs: { href: "https://x.dev/l" } }, { type: "bold" }], [{ type: "link", attrs: { href: "https://x.dev/k" } }, { type: "code" }], [{ type: "italic" }, { type: "underline" }, { type: "strike" }]];

function randomInline(n: number): DocNode[] {
  const out: DocNode[] = [];
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.08) out.push({ type: "hard_break" });
    else if (rnd() < 0.08) {
      // Any marks, link and code included (a selection formatted whole): Markdown keeps the emphasis.
      const marks = pick(MARK_SETS);
      out.push({ type: "mention", attrs: { id: pick(PEOPLE), label: pick(["Ann", "Bob *x* [y]", "a_b & <c>", "&amp; \\ !", "Ann"]) }, ...(marks.length ? { marks } : {}) });
    } else out.push({ type: "text", text: pick(WORDS) + (rnd() < 0.5 ? " " : ""), marks: pick(MARK_SETS) });
  }
  // Through ProseMirror: merges runs and sorts marks as stored documents have them.
  return (plain(Node.fromJSON(schema, { type: "paragraph", content: out.map((x) => (x.marks?.length ? x : { type: x.type, ...(x.text ? { text: x.text } : {}), ...(x.attrs ? { attrs: x.attrs } : {}) })) })) as DocNode).content ?? [];
}

/** A table of random size; its rows of random widths and alignments, as an edited or imported one may have. */
function randomTable(): DocNode {
  const cell = () => ({ type: "table_cell", attrs: { align: pick(["", "", "left", "center", "right"]) }, content: randomInline(1 + Math.floor(rnd() * 3)).filter((n) => n.type !== "hard_break") });
  const row = () => ({ type: "table_row", content: Array.from({ length: 1 + Math.floor(rnd() * 3) }, cell) });
  return { type: "table", content: Array.from({ length: 1 + Math.floor(rnd() * 3) }, row) } as DocNode;
}

function randomBlock(depth: number): DocNode {
  const k = depth > 3 ? 0 : Math.floor(rnd() * 11);
  const blocks = () => Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => randomBlock(depth + 1));
  const item = (type: string) => ({ type, ...(type === "task_item" ? { attrs: { checked: rnd() < 0.5 } } : {}), content: [{ type: "paragraph", content: randomInline(3) }, ...(rnd() < 0.3 ? blocks() : [])] });
  switch (k) {
    case 1:
      return { type: "heading", attrs: { level: 1 + Math.floor(rnd() * 3) }, content: randomInline(3) };
    case 2:
      return { type: "blockquote", content: blocks() } as DocNode;
    case 3:
      return { type: "code_block", attrs: { language: pick(["", "ts"]) }, content: [{ type: "text", text: pick(["a\n  b", "```x```", "# not", "x"]) }] } as DocNode;
    case 4:
      return { type: "bullet_list", content: [item("list_item"), item("list_item")] } as DocNode;
    case 5:
      return { type: "ordered_list", attrs: { order: pick([1, 3, 10]) }, content: [item("list_item"), item("list_item")] } as DocNode;
    case 6:
      return { type: "task_list", content: [item("task_item"), item("task_item")] } as DocNode;
    case 8:
      return { type: "horizontal_rule" };
    case 9:
      return randomTable();
    default:
      return { type: "paragraph", content: randomInline(1 + Math.floor(rnd() * 8)) } as DocNode;
  }
}

test("mentions: [@Name](mention:<user id>), emphasis around them, labels escaped, anything else stays text", () => {
  const [ann, bob] = PEOPLE as [string, string];
  const md = `Hi [@Ann](mention:${ann}) and **[@Bob \\*B\\*](mention:${bob.toUpperCase()})**, [@Eve](mention:eve@x.test), ![@Img](mention:${ann})`;
  const doc = valid(fromMarkdown(md));
  assert.deepEqual(doc.content![0]!.content, [
    { type: "text", text: "Hi " },
    { type: "mention", attrs: { id: ann, label: "Ann" } },
    { type: "text", text: " and " },
    { type: "mention", attrs: { id: bob, label: "Bob *B*" }, marks: [{ type: "bold" }] },
    { type: "text", text: ", @Eve, @Img" },
  ]);
  assert.equal(toMarkdown(doc), `Hi [@Ann](mention:${ann}) and **[@Bob \\*B\\*](mention:${bob})**, @Eve, @Img\n`);
  roundTrip(doc);
  assert.equal(docText(doc), "Hi @Ann and @Bob *B*, @Eve, @Img");
  assert.deepEqual(mentionIds({ type: "doc", content: [doc, doc] }), [ann, bob]);
});

test("mentions: a resolver turns other targets into people (the agent API's emails and me)", () => {
  const [ann] = PEOPLE as [string];
  const seen: string[] = [];
  const doc = fromMarkdown("[@A](mention:ann@x.test) [](mention:me) [@?](mention:nobody)", {
    mention: (t) => (seen.push(t), t === "nobody" ? null : { id: ann, ...(t === "me" ? { label: "Ann" } : {}) }),
  });
  assert.deepEqual(seen, ["ann@x.test", "me", "nobody"]);
  assert.deepEqual(doc.content![0]!.content, [
    { type: "mention", attrs: { id: ann, label: "A" } },
    { type: "text", text: " " },
    { type: "mention", attrs: { id: ann, label: "Ann" } },
    { type: "text", text: " @?" },
  ]);
  // Without a resolver, only a user id is a mention (in any case; stored in lower case).
  assert.equal(fromMarkdown(`[@A](mention:${ann.toUpperCase()})`).content![0]!.content![0]!.attrs!.id, ann);
  assert.equal(docText(fromMarkdown("[@A](mention:ann@x.test)")), "@A");
});

test("mentions: a link over one closes before it, `!` before one stays text, labels keep their characters", () => {
  const [ann] = PEOPLE as [string];
  const link = { type: "link" as const, attrs: { href: "https://x.dev/" } };
  const doc: DocNode = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "see ", marks: [link] },
          { type: "mention", attrs: { id: ann, label: "&amp; x" }, marks: [link] },
          { type: "text", text: " here wow!", marks: [link] },
          { type: "mention", attrs: { id: ann, label: "Ann" } },
        ],
      },
    ],
  };
  const md = toMarkdown(doc);
  assert.equal(md, `[see ](https://x.dev/)[@\\&amp; x](mention:${ann})[ here wow!](https://x.dev/)[@Ann](mention:${ann})\n`);
  assert.deepEqual(mentionIds(fromMarkdown(md)), [ann]);
  assert.equal(fromMarkdown(md).content![0]!.content!.filter((n) => n.type === "mention").length, 2);
  assert.equal(fromMarkdown(md).content![0]!.content![1]!.attrs!.label, "&amp; x");
  const bang: DocNode = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "wow!" }, { type: "mention", attrs: { id: ann, label: "Ann" } }] }] };
  assert.equal(toMarkdown(bang), `wow\\![@Ann](mention:${ann})\n`);
  roundTrip(bang);
  // Plain text too: "wow!" before a link no longer turns it into an image.
  assert.equal(toMarkdown(fromMarkdown("wow\\![x](https://x.dev/)")), "wow\\![x](https://x.dev/)\n");
});

test("two lists of one kind with an empty paragraph between stay two lists", () => {
  const item = { type: "task_item", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] };
  const doc = { type: "doc", content: [{ type: "task_list", content: [item] }, { type: "paragraph" }, { type: "task_list", content: [item] }] } as DocNode;
  assert.equal(roundTrip(doc), "- [x] a\n\n* [x] a\n");
});

test("property: 3000 random documents survive doc → Markdown → doc", () => {
  for (let i = 0; i < 3000; i++) {
    const doc = plain(Node.fromJSON(schema, { type: "doc", content: Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => randomBlock(0)) })) as DocNode;
    roundTrip(doc, false);
  }
});

function plain(n: Node): unknown {
  return JSON.parse(JSON.stringify(n.toJSON()));
}

test("images (PLNR-50): a line of its own with a workspace file; anything else stays text", async () => {
  const { validateDoc, DocError } = await import("../src/validate.ts");
  const src = `/files/atlas/${"ab".repeat(32)}`;
  const doc = valid(fromMarkdown(`Before\n![Screen shot](${src})\nafter`));
  assert.deepEqual(
    doc.content!.map((n) => n.type),
    ["paragraph", "image", "paragraph"],
    "an image line ends the paragraph above it",
  );
  assert.deepEqual(doc.content![1], { type: "image", attrs: { src, alt: "Screen shot" } });
  assert.equal(toMarkdown(doc), `Before\n\n![Screen shot](${src})\n\nafter\n`);
  assert.ok(sameDoc(fromMarkdown(toMarkdown(doc)), doc), "round trip");
  // In a list item, after its paragraph.
  const item = valid(fromMarkdown(`- one\n\n  ![](${src})`));
  assert.ok(sameDoc(fromMarkdown(toMarkdown(item)), item));
  // Another address, an inline image, a bad hash: text, never an image.
  for (const md of ["![x](https://evil.test/a.png)", `text ![x](${src}) more`, "![x](/files/atlas/abc)", "![x](javascript:alert(1))"]) {
    assert.ok(!JSON.stringify(fromMarkdown(md)).includes('"image"'), md);
  }
  // The text "![x](/files/…)" typed into a paragraph stays text through a round trip.
  const typed: DocNode = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `![x](${src})` }] }] };
  assert.ok(sameDoc(fromMarkdown(toMarkdown(typed)), typed), toMarkdown(typed));
  // The server refuses an image of any other source.
  assert.throws(() => validateDoc({ type: "doc", content: [{ type: "image", attrs: { src: "https://evil.test/x.png", alt: "" } }] }), DocError);
  assert.deepEqual(validateDoc({ type: "doc", content: [{ type: "image", attrs: { src, alt: "a" } }] }).content![0], { type: "image", attrs: { src, alt: "a" } });
  assert.equal(docText(doc), "Before\n\nafter");
});

test("hostile Markdown at the size limit parses in linear time", () => {
  // Each shape was quadratic: a growing text buffer re-read at every line end (17 s for 200 KB), every blank line in a
  // list item rescanning the blank lines after it (105 s), every trailing `)` of a bare URL recounting the parentheses
  // (12 s). The server parses agent Markdown and mentions synchronously, and every viewer parses each comment.
  const shapes: Record<string, (n: number) => string> = {
    "plain lines": (n) => "abc\n".repeat(n / 4),
    "lines ending in spaces": (n) => "abc  \nd \n".repeat(n / 10),
    "blank lines in a list item": (n) => "- a\n" + "\n".repeat(n - 8) + "  b",
    // The run of parentheses grows with the input, the number of URLs stays: the old cost was in the run.
    "parens after bare URLs": (n) => ("http://a" + ")".repeat(n / 50 - 10) + " ").repeat(50),
  };
  linearAt(DOC_MARKDOWN_MAX, shapes);
});

test("a line's patterns are linear in its length (RSVA-621): no run of spaces or marks is rescanned from each of its characters", () => {
  // At 64 KB a line took 0.9 s (a fence line), 3 s (a heading), 1.4 s (a delimiter row); a fence of tildes before a
  // backtick was cubic: one of 2 KB took 2 s. Thirty-two link destinations of spaces as long as the window took 170 ms.
  const shapes: Record<string, (n: number) => string> = {
    "spaces in a fence line": (n) => "```" + " ".repeat(n) + "`",
    "tildes in fence lines": (n) => ("~~~" + "~".repeat(n / 256) + "`\n").repeat(256),
    "spaces in a heading": (n) => "# a" + " ".repeat(n) + "b",
    "spaces in a delimiter row": (n) => "a|b\n|-" + " ".repeat(n) + "x",
    "spaces in link destinations": (n) => ("[a](" + " ".repeat(n / 32)).repeat(32),
  };
  linearAt(COMMENT_MAX, shapes);
});

test("bare URLs that do not parse cost their host, not the window (RSVA-623)", () => {
  // Each candidate scanned and parsed up to 4 KB ahead: 64 KB of `(http://[` took 100 ms. In 16 lines a line is the window
  // at 64 KB and a 16th of it at 4 KB, so that cost shows as growth.
  const lines = (unit: string) => (n: number) => (unit.repeat(Math.ceil(n / 16 / unit.length)).slice(0, n / 16 - 1) + "\n").repeat(16);
  linearAt(COMMENT_MAX, {
    "bad hosts": lines("(http://["),
    "bad ports": lines("*http://x:99999/"),
    "empty hosts": lines("(http:///"),
    "bad hosts before a query": lines("(http://[?"),
  });
  // What still links: a host that parses, its path, a query after punctuation, a balanced parenthesis.
  const links = (md: string) => fromMarkdown(md).content![0]!.content!.filter((t) => t.marks).map((t) => t.text);
  assert.deepEqual(links("(http://[ http://x:80;? (https://x.dev/a_(b)) http://\\\\x.dev/p?q=1. https://[::1]/"), [
    "http://x:80",
    "https://x.dev/a_(b)",
    "http://\\\\x.dev/p?q=1",
    "https://[::1]/",
  ]);
});

/**
 * Each shape parses to something, in time linear against itself at the same moment: not a bound in milliseconds, which a
 * busy CI runner could fail (PLNR-190).
 */
function linearAt(n: number, shapes: Record<string, (n: number) => string>): void {
  for (const [name, shape] of Object.entries(shapes)) {
    assert.ok(fromMarkdown(shape(n)).content?.length, name);
    assertLinear(name, shape, fromMarkdown, n);
  }
}

test("tables (PLNR-367): GitHub's, alignments, escaped pipes, short and long rows, a table interrupting a paragraph", () => {
  const doc = valid(fromMarkdown("Stages\n| # | What | Risk |\n|:-|:-:|--:|\n| 1 | **Repo** \\| app | 0 |\n| 2 |\n| 3 | a | b | extra |\n\nafter"));
  assert.deepEqual(doc.content!.map((n) => n.type), ["paragraph", "table", "paragraph"]);
  const rows = doc.content![1]!.content!;
  assert.deepEqual(rows.map((r) => r.content!.length), [3, 3, 3, 3], "short rows filled, long ones cut");
  assert.deepEqual(rows[0]!.content!.map((c) => c.attrs!.align), ["left", "center", "right"]);
  assert.equal(docText(doc.content![1]!), "# | What | Risk\n1 | Repo | app | 0\n2 |  | \n3 | a | b");
  assert.equal(
    toMarkdown(doc),
    "Stages\n\n| # | What | Risk |\n| :--- | :---: | ---: |\n| 1 | **Repo** \\| app | 0 |\n| 2 |  |  |\n| 3 | a | b |\n\nafter\n",
  );
  roundTrip(doc);
  // A table in a list item and a quote.
  roundTrip(valid(fromMarkdown("- item\n\n  | a |\n  | --- |\n  | 1 |\n\n> | q |\n> | --- |")));
  // Not tables: no delimiter row, cell counts that differ, no pipe, a delimiter row alone, too many columns.
  for (const md of ["| a | b |\n| c | d |", "| a | b |\n| --- |", "a\n---", "| --- |", `|${"x|".repeat(65)}\n|${"-|".repeat(65)}`]) {
    assert.ok(!JSON.stringify(fromMarkdown(md)).includes('"table"'), md);
  }
  // A pipe in code splits the cell, as on GitHub; escaped, it stays in the code.
  const code = valid(fromMarkdown("| `a|b` | `c\\|d` |\n| - | - | - |"));
  assert.deepEqual(code.content![0]!.content![0]!.content!.map((c) => docText(c)), ["`a", "b`", "c|d"]);
});

test("tables stay within their caps: one cell budget for a document, wide and huge stored tables refused", async () => {
  const { validateDoc, DocError } = await import("../src/validate.ts");
  const { TABLE_CELLS_MAX } = await import("../src/doc.ts");
  // Hundreds of small tables of bare rows, each filled to 64 columns: the budget is the document's, not each table's.
  const header = `|${"a|".repeat(64)}\n|${"-|".repeat(64)}\n`;
  const many = (header + "|\n".repeat(150) + "\n").repeat(300);
  const cells = (d: DocNode): number => (d.type === "table_cell" ? 1 : (d.content ?? []).reduce((n, c) => n + cells(c), 0));
  assert.ok(cells(fromMarkdown(many)) <= TABLE_CELLS_MAX, "within the budget");
  assertLinear("small tables", (n) => (header + "|\n".repeat(150) + "\n").repeat(Math.ceil(n / 600)), fromMarkdown, 200_000);
  // Stored: one wide row and many short ones would be filled out when written as Markdown.
  const row = (n: number) => ({ type: "table_row", content: Array.from({ length: n }, () => ({ type: "table_cell", attrs: { align: "" } })) });
  assert.throws(() => validateDoc({ type: "doc", content: [{ type: "table", content: [row(65)] }] }), DocError, "too wide");
  assert.throws(() => validateDoc({ type: "doc", content: [{ type: "table", content: [row(64), ...Array.from({ length: 200 }, () => row(1))] }] }), DocError, "too many cells once filled");
  assert.ok(validateDoc({ type: "doc", content: [{ type: "table", content: [row(64), row(1)] }] }));
});
