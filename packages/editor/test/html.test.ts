// The DOM-free HTML reader on malformed input: it must stay linear in time (PLNR-32) and read what it can.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLinear } from "@rsva/test-kit";
import { docText } from "../src/doc.ts";
import { fromHtml } from "../src/html.ts";

test("pathological input parses in linear time", () => {
  // The case that backtracked exponentially: an unclosed tag with many quoted attributes (40 took minutes). It has no
  // time bound: an exponential parser does not finish it, and the test's own limit fails it.
  fromHtml("<a" + " a='b'".repeat(40) + " /");
  const shapes: Record<string, (n: number) => string> = {
    manyAttributes: (n) => "<a" + " a='b'".repeat(n) + " /",
    // Quadratic even with disjoint alternatives: every failed tag was retried from the next "<".
    unclosedTags: (n) => "<a b=c ".repeat(n),
    unclosedComments: (n) => "<!--".repeat(n),
    unclosedQuotes: (n) => "<a b='".repeat(n),
    lessThans: (n) => "<<a<".repeat(n),
  };
  // Linear against itself at the same moment, not a bound in milliseconds: a busy CI runner cannot fail it (PLNR-190).
  for (const [name, shape] of Object.entries(shapes)) assertLinear(name, shape, fromHtml, 40_000);
});

test("malformed tags: a stray < is text, a tag the input ends inside is dropped with the rest", () => {
  assert.equal(docText(fromHtml("<p>1 < 2 and 3 > 2</p>")), "1 < 2 and 3 > 2");
  assert.equal(docText(fromHtml("<p>kept</p><p>also <a href='x")), "kept\nalso");
  assert.equal(docText(fromHtml("<!doctype html><p>a<!-- note -->b</p><?xml x?>")), "ab");
  assert.equal(docText(fromHtml("<p>before</p><!-- never closed <p>after</p>")), "before");
});

test("attributes: quoted, unquoted, valueless, with spaces around =", () => {
  const doc = fromHtml(`<ul data-type="taskList"><li data-type = 'taskItem' data-checked="true"><p>done</p></li></ul><p><a href=https://example.com/a?b=1>link</a></p>`);
  assert.equal(doc.content?.[0]?.type, "task_list");
  assert.equal(doc.content?.[0]?.content?.[0]?.attrs?.checked, true);
  const link = doc.content?.[1]?.content?.[0];
  assert.equal(link?.marks?.[0]?.attrs?.href, "https://example.com/a?b=1");
});

test("an image of the workspace is an image block, in a list too; any other image stays a link", () => {
  const src = `/files/acme/${"a".repeat(64)}`;
  assert.deepEqual(fromHtml(`<p><img src="${src}" alt="shot"></p>`).content, [{ type: "image", attrs: { src, alt: "shot" } }]);
  const item = fromHtml(`<ul><li><p>text</p><p><img src="${src}"></p></li></ul>`).content![0]!.content![0]!;
  assert.deepEqual(item.content!.map((n) => n.type), ["paragraph", "image"]);
  const alone = fromHtml(`<ul><li><p><img src="${src}"></p></li></ul>`).content![0]!.content![0]!;
  assert.deepEqual(alone.content!.map((n) => n.type), ["paragraph", "image"]);
  assert.equal(fromHtml(`<p><img src="https://example.com/a.png"></p>`).content![0]!.type, "paragraph");
  assert.equal(fromHtml(`<p><img src="/files/acme/nothash"></p>`).content![0]!.content, undefined);
});

test("tables: a merged cell spreads only up to the column cap, rows stop at the document's cell budget", () => {
  const wide = fromHtml(`<table><tr>${'<td colspan="1000">x</td>'.repeat(500)}</tr></table>`);
  assert.equal(wide.content![0]!.content![0]!.content!.length, 64);
  const tall = fromHtml(`<table>${'<tr><td colspan="64">x</td></tr>'.repeat(1000)}</table>`.repeat(3));
  const cells = tall.content!.reduce((n, t) => n + (t.content ?? []).length * 64, 0);
  assert.ok(cells <= 10_000, String(cells));
  assertLinear("merged cells", (n) => `<table><tr>${'<td colspan="64">x</td>'.repeat(n / 20)}</tr></table>`, fromHtml, 40_000);
});

test("a mention-component the resolver knows is a mention; spaces around it stay, one at the end of a block too (RSVA-42)", () => {
  const html = "<p> Ping <mention-component user='u1' label='Ann  Lee'></mention-component> now <mention-component user='u2' label='Bo'></mention-component></p>";
  const mention = (t: string) => (t === "u1" ? { id: "id-1" } : null);
  assert.deepEqual(fromHtml(html, { mention }).content, [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Ping " }, { type: "mention", attrs: { id: "id-1", label: "Ann Lee" } }, { type: "text", text: " now @Bo" }],
    },
  ]);
  assert.deepEqual(fromHtml("<p>Hi <mention-component user='u1' label='A'></mention-component> </p>", { mention }).content, [
    { type: "paragraph", content: [{ type: "text", text: "Hi " }, { type: "mention", attrs: { id: "id-1", label: "A" } }] },
  ]);
  // Without a resolver nothing becomes a mention: an id from elsewhere is not a person here.
  assert.equal(docText(fromHtml(html)), "Ping @Ann Lee now @Bo");
});

test("a name of Object.prototype is neither an entity nor a mark (RSVA-427)", () => {
  // Plain objects looked both up: `&constructor;` became the text of Object's source, <constructor> a mark of no type.
  assert.deepEqual(fromHtml("<p>a &constructor; &#39;b&#x27; &amp;</p>"), {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "a &constructor; 'b' &" }] }],
  });
  assert.deepEqual(fromHtml("<p><constructor>x</constructor> <b>y</b></p>"), {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "x " }, { type: "text", text: "y", marks: [{ type: "bold" }] }] }],
  });
});
