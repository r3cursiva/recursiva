// The editor's pieces that run without a browser: input rules, commands, paste cleanup through the schema's parse
// rules (on linkedom's DOM), the read-only renderer, Plane's HTML and the server-side check.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { DOMParser, Node, Slice } from "prosemirror-model";
import { undo } from "prosemirror-history";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { safeHref, readFileLink, fileLink, docText, type DocNode } from "../src/doc.ts";
import { fromHtml } from "../src/html.ts";
import { issueKeys, issueRefs } from "../src/issue-ref.ts";
import { fromMarkdown, toMarkdown } from "../src/markdown.ts";
import { renderDoc } from "../src/render.ts";
import { schema } from "../src/schema.ts";
import { DocError, validateDoc } from "../src/validate.ts";
import { commandFor, setLink } from "../src/view/commands.ts";
import { uploadPlugin } from "../src/view/upload.ts";
import { PAGE_DRAG } from "../src/drag.ts";
import { issueRefKeys } from "../src/view/issue-ref.ts";
import { applyBlock, caretQuery, dismissQuery, insertIssueKey, insertMention } from "../src/view/caret-query.ts";
import { markdownSlice, plugins } from "../src/view/plugins.ts";
import { matchBlocks, SLASH_BLOCKS } from "../src/react/blocks.ts";
import { highlighted, menuAction, menuKey, sessionFor, type Chosen, type Session } from "../src/react/menu-state.ts";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}.html`, import.meta.url), "utf8");
const plain = (n: Node) => JSON.parse(JSON.stringify(n.toJSON())) as DocNode;

/** Just enough of an EditorView for input rules and commands. */
function fakeView(md = "", opts: Parameters<typeof plugins>[0] = {}) {
  const v = {
    state: EditorState.create({ doc: Node.fromJSON(schema, fromMarkdown(md)), plugins: plugins(opts) }),
    composing: false,
    dispatch(tr: Transaction) {
      v.state = v.state.apply(tr);
    },
  };
  return v;
}

/** Types text as the browser would: every character offered to the input rules first. */
function type(v: ReturnType<typeof fakeView>, text: string) {
  const rules = v.state.plugins.find((p) => p.props.handleTextInput)!;
  for (const ch of text) {
    const { from, to } = v.state.selection;
    const handled = rules.props.handleTextInput!.call(rules, v as never, from, to, ch, () => v.state.tr.insertText(ch, from, to));
    if (!handled) v.dispatch(v.state.tr.insertText(ch, from, to));
  }
}

const md = (v: ReturnType<typeof fakeView>) => toMarkdown(plain(v.state.doc));

test("Markdown shortcuts while typing", () => {
  const cases: [string, string][] = [
    ["# Title", "# Title\n"],
    ["### Small", "### Small\n"],
    ["- item", "- item\n"],
    ["1. first", "1. first\n"],
    ["[ ] todo", "- [ ] todo\n"],
    ["[x] done", "- [x] done\n"],
    ["> quote", "> quote\n"],
    ["**bold** and *it* and _it_ and ~~gone~~ and `code` ", "**bold** and *it* and *it* and ~~gone~~ and `code`\n"],
    ["see https://x.dev/a ok", "see <https://x.dev/a> ok\n"],
    ["2 * 3 * 4", "2 \\* 3 \\* 4\n"],
    ["snake_case_name", "snake_case_name\n"],
  ];
  for (const [typed, want] of cases) {
    const v = fakeView();
    type(v, typed);
    assert.equal(md(v), want, typed);
  }
  const v = fakeView();
  type(v, "```ts ");
  type(v, "let a");
  assert.equal(md(v), "```ts\nlet a\n```\n");
  const hr = fakeView();
  type(hr, "---");
  assert.deepEqual(hr.state.doc.content.content.map((n) => n.type.name), ["horizontal_rule", "paragraph"]);
});

/** Mod is ⌘ on a Mac and Ctrl elsewhere, as prosemirror-keymap reads it (CI runs on Linux). */
const mac = /Mac|iP(hone|[oa]d)/.test(globalThis.navigator?.platform ?? "");

/** Presses a key as the browser would: each plugin's handleKeyDown in order, until one takes it. */
function press(v: ReturnType<typeof fakeView>, key: string, mods: { shift?: boolean; mod?: boolean } = {}) {
  const e = { key, keyCode: key === "Enter" ? 13 : 0, shiftKey: !!mods.shift, metaKey: !!mods.mod && mac, ctrlKey: !!mods.mod && !mac, altKey: false };
  return v.state.plugins.some((p) => p.props.handleKeyDown?.call(p, v as never, e as never));
}

test("comments: Enter sends, Shift+Enter makes a new line or list item; descriptions keep Enter", () => {
  let sent = 0;
  const comment = fakeView("hello", { submit: () => sent++, enterSends: true });
  comment.dispatch(comment.state.tr.setSelection(TextSelection.atEnd(comment.state.doc)));
  assert.ok(press(comment, "Enter"));
  assert.equal(sent, 1);
  assert.ok(press(comment, "Enter", { shift: true }));
  assert.equal(sent, 1);
  assert.equal(comment.state.doc.childCount, 2);
  assert.ok(press(comment, "Enter", { mod: true }));
  assert.equal(sent, 2);

  const list = fakeView("- one", { submit: () => sent++, enterSends: true });
  list.dispatch(list.state.tr.setSelection(TextSelection.atEnd(list.state.doc)));
  press(list, "Enter", { shift: true });
  assert.equal(list.state.doc.firstChild!.childCount, 2);

  const description = fakeView("hello", { submit: () => sent++ });
  description.dispatch(description.state.tr.setSelection(TextSelection.atEnd(description.state.doc)));
  press(description, "Enter");
  assert.equal(sent, 2);
  assert.equal(description.state.doc.childCount, 2);
});

test("toolbar commands: lists switch in place, a collapsible wraps the selected blocks, links only when safe", () => {
  const v = fakeView("one\n\ntwo\n\nthree");
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1, v.state.doc.content.size - 1)));
  commandFor("bullet_list")(v.state, v.dispatch);
  assert.equal(md(v), "- one\n- two\n- three\n");
  commandFor("task_list")(v.state, v.dispatch);
  assert.equal(md(v), "- [ ] one\n- [ ] two\n- [ ] three\n");
  commandFor("ordered_list")(v.state, v.dispatch);
  assert.equal(md(v), "1. one\n2. two\n3. three\n");

  const c = fakeView("a\n\nb");
  c.dispatch(c.state.tr.setSelection(TextSelection.create(c.state.doc, 1, 5)));
  commandFor("code_block")(c.state, c.dispatch);
  assert.equal(md(c), "```\na\nb\n```\n");

  const l = fakeView("see docs here");
  l.dispatch(l.state.tr.setSelection(TextSelection.create(l.state.doc, 5, 9)));
  assert.equal(setLink("javascript:alert(1)")(l.state, l.dispatch), false);
  assert.equal(setLink("x.dev/docs")(l.state, l.dispatch), true);
  assert.equal(md(l), "see [docs](https://x.dev/docs) here\n");
  l.dispatch(l.state.tr.setSelection(TextSelection.create(l.state.doc, 7)));
  setLink("")(l.state, l.dispatch);
  assert.equal(md(l), "see docs here\n", "at a caret, the whole link goes");
});

test("paste: messy Google Docs and Word HTML is fitted to the schema, scripts and styles go", () => {
  const { document } = parseHTML(`<!doctype html><html><body>${fixture("paste-messy")}</body></html>`);
  (globalThis as { window?: unknown }).window = { getComputedStyle: () => ({}) };
  const doc = DOMParser.fromSchema(schema).parse(document.body as unknown as HTMLElement);
  doc.check();
  const out = toMarkdown(plain(doc));
  assert.match(out, /^# Quarterly plan$/m);
  assert.match(out, /\*\*Bold lead\.\*\* Normal text with \*italic words\* and a \[link\]\(https:\/\/example\.com\/doc\)\./);
  assert.match(out, /^- First point\n- ~~Struck point~~$/m);
  assert.match(out, /Word junk/);
  assert.match(out, /cell A/);
  assert.match(out, /<u>Underlined<\/u> end/);
  assert.doesNotMatch(out, /pwned|script|style=|MsoNormal|<img/);
});

test("paste: plain text that looks like Markdown arrives formatted; other text stays text", () => {
  const s = markdownSlice("## Notes\n\n- [x] shipped\n- **bold** item")!;
  assert.deepEqual(s.content.content.map((n) => n.type.name), ["heading", "task_list", "bullet_list"]);
  assert.equal(markdownSlice("just a sentence, nothing else"), null);
});

test("a collapsible section (gone since PLNR-378) opens out: a stored one in the editor, the reader and Markdown", () => {
  const stored = {
    type: "doc",
    content: [{ type: "details", attrs: { open: false }, content: [{ type: "details_summary", content: [{ type: "text", text: "S" }, { type: "text", text: "c", marks: [{ type: "code" }] }] }, { type: "paragraph", content: [{ type: "text", text: "body" }] }] }],
  } as unknown as DocNode;
  const want = "**S**`c`\n\nbody\n";
  assert.equal(toMarkdown(stored), want);
  assert.equal(toMarkdown(validateDoc(stored)), want, "the server stores it opened out");
  assert.equal(toMarkdown(fromMarkdown("<details open>\n<summary>S</summary>\n\nbody\n</details>")), "**S**\n\nbody\n");
  assert.equal(toMarkdown(fromHtml("<details><summary>S</summary><p>body</p></details>")), "**S**\n\nbody\n");
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const host = document.createElement("div");
  host.append(renderDoc(stored, {}, document as unknown as Document) as never);
  assert.equal(host.innerHTML, "<p><strong>S</strong><code>c</code></p><p>body</p>");
  assert.equal(SLASH_BLOCKS.some((b) => (b.cmd as string) === "details"), false);
});

test("the reader renders what the editor shows, without parsing HTML and without unsafe links", () => {
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const doc = fromMarkdown("# T\n\n- [x] done\n\n[ok](https://x.dev) <b onclick=x>t</b>");
  const bad = structuredClone(doc);
  bad.content!.at(-1)!.content![0]!.marks = [{ type: "link", attrs: { href: "javascript:alert(1)" } }];
  const host = document.createElement("div");
  host.append(renderDoc(bad, {}, document as unknown as Document) as never);
  assert.equal(host.querySelector("h1")?.textContent, "T");
  assert.equal(host.querySelector('ul[data-type="taskList"] input')?.getAttribute("type"), "checkbox");
  assert.equal(host.querySelectorAll("a").length, 0, "the unsafe link is text");
  assert.equal(host.querySelector("b"), null, "tags in the source stay text");
  assert.ok(host.textContent.includes("<b onclick=x>t</b>"));
});

test("a comment's reading: a file is a card, a long log folds, a quote names its author", () => {
  const { document } = parseHTML("<html><body></body></html>");
  const sha = "a".repeat(64);
  const href = fileLink(`/files/atlas/${sha}`, "du (oct30).txt", 2100);
  assert.deepEqual(readFileLink(href), { name: "du (oct30).txt", size: 2100 });
  assert.equal(safeHref(href), href);
  assert.equal(safeHref(`/files/atlas/${sha}`), null, "a bare path is not a link: it says nothing to show");
  assert.equal(safeHref(`/files/atlas/${sha}?name=x&size=1&then=y`), null);
  assert.equal(safeHref("/etc/passwd"), null);
  const long = fileLink(`/files/atlas/${sha}`, "отчёт ".repeat(40), 1);
  assert.equal(safeHref(long), long, "a long name in Cyrillic is still a file");
  const md = `> **Mira**\n>\n> Keep the key?\n\n> no author here\n\n[du (oct30).txt](${href})\n\ntext [du](${href}) inline\n\n\`\`\`\n${Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n")}\n\`\`\`\n\n\`\`\`\nshort\n\`\`\``;
  const doc = fromMarkdown(md);
  assert.equal(toMarkdown(doc).includes(href), true, "the link survives Markdown");
  const host = document.createElement("div");
  host.append(renderDoc(doc, { foldCode: true, fileSize: (n) => `${n} B` }, document as unknown as Document) as never);
  const card = host.querySelector(".file-card");
  assert.equal(decodeURIComponent(card?.getAttribute("href") ?? ""), decodeURIComponent(href), "linkedom's href setter decodes");
  assert.equal(card?.textContent, "du (oct30).txt2100 B");
  assert.equal(host.querySelectorAll(".file-card").length, 1, "a link inside a sentence stays a link");
  assert.equal(host.querySelector("blockquote .quote-author")?.textContent, "Mira");
  assert.equal(host.querySelectorAll(".quote-author").length, 1, "a quote of one paragraph has no author");
  const fold = host.querySelector(".code-fold");
  assert.equal(host.querySelectorAll(".code-fold").length, 1, "a short block stays whole");
  assert.equal(fold?.hasAttribute("data-cut"), true);
  assert.equal(fold?.querySelector("button")?.textContent, "Show 3 more lines");
  fold?.querySelector("button")?.click();
  assert.equal(fold?.hasAttribute("data-cut"), false);
  assert.equal(fold?.querySelector("button")?.textContent, "Show less");
  const plainHost = document.createElement("div");
  plainHost.append(renderDoc(doc, {}, document as unknown as Document) as never);
  assert.equal(plainHost.querySelectorAll(".file-card, .code-fold").length, 0, "a description draws neither");
});

test("Plane HTML: rule div, task items, mentions, images, tables, dropped tags", () => {
  const doc = fromHtml(
    '<p>Hi <mention-component label="Robin"></mention-component>!</p><div data-type="horizontalRule"><div></div></div>' +
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>done</p></div></li></ul>' +
      '<p><img src="https://x.dev/i.png" alt="shot"><script>alert(1)</script><style>p{}</style></p>' +
      "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>" +
      '<p><a href="javascript:alert(1)">bad</a> <a href="https://ok.dev">ok</a></p>',
  );
  assert.equal(
    toMarkdown(doc),
    "Hi @Robin!\n\n---\n\n- [x] done\n\n[shot](https://x.dev/i.png)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nbad [ok](https://ok.dev/)\n",
  );
});

const ANN = "01a184e8-6f14-7a63-9060-5c74bf8f8f89";

const MENUS = { triggers: ["@", "#", "/"] as const, keys: () => false };

test("@ menu: the query before the caret, picking a person, Esc, and no query in code or mid-word", () => {
  const v = fakeView("", { menus: MENUS });
  type(v, "ping @an");
  assert.deepEqual(caretQuery(v.state), { trigger: "@", from: 6, to: 9, query: "an" });
  assert.ok(insertMention(v as never, ANN, "Ann Lee"));
  type(v, "ok");
  assert.equal(md(v), `ping [@Ann Lee](mention:${ANN}) ok\n`);
  assert.equal(caretQuery(v.state), null);

  type(v, " @b");
  assert.ok(dismissQuery(v as never));
  assert.equal(caretQuery(v.state), null, "Esc closes it");
  type(v, "o");
  assert.equal(caretQuery(v.state), null, "and typing on in the same query keeps it closed");
  type(v, " @");
  assert.deepEqual(caretQuery(v.state)?.query, "", "a new @ opens it again");

  for (const typed of ["mail a@b", "`@x"]) {
    const w = fakeView("", { menus: MENUS });
    type(w, typed);
    assert.equal(caretQuery(w.state), null, typed);
  }
  const w = fakeView("", {});
  type(w, "@ann");
  assert.equal(caretQuery(w.state), null, "without the option there is no query");
});

test("# menu: a key or words of a title after #, the bare key picked, and # at a line's start still a heading", () => {
  const v = fakeView("", { menus: MENUS });
  type(v, "see #login bug");
  assert.deepEqual(caretQuery(v.state), { trigger: "#", from: 5, to: 15, query: "login bug" });
  assert.equal(insertMention(v as never, ANN, "Ann"), false, "a person does not go in place of #");
  assert.ok(insertIssueKey(v as never, "PLNR-43"));
  type(v, "first");
  assert.equal(md(v), "see PLNR-43 first\n", "plain text, no # and no link");
  assert.equal(caretQuery(v.state), null);

  type(v, " #pl");
  assert.ok(dismissQuery(v as never));
  type(v, "nr");
  assert.equal(caretQuery(v.state), null, "Esc closes it as it does the @ menu");

  // "# " makes a heading as before; the menu's query was "" for the moment between the two keys.
  const h = fakeView("", { menus: MENUS });
  type(h, "#");
  assert.deepEqual(caretQuery(h.state), { trigger: "#", from: 1, to: 2, query: "" });
  type(h, " Title");
  assert.equal(md(h), "# Title\n");
  assert.equal(caretQuery(h.state), null);
  type(h, " ##");
  assert.equal(caretQuery(h.state), null, "## is not a query");

  for (const typed of ["issue#12", "C#", "(x)#y", "a # b", "`#x"]) {
    const w = fakeView("", { menus: MENUS });
    type(w, typed);
    assert.equal(caretQuery(w.state), null, typed);
  }
  const w = fakeView("", { menus: { triggers: ["@"], keys: () => false } });
  type(w, "#x");
  assert.equal(caretQuery(w.state), null, "only the triggers asked for");
});

test("/ menu: a block's name after /, the block applied and the / gone, no query in a URL or a path", () => {
  const v = fakeView("", { menus: MENUS });
  type(v, "/bul");
  assert.deepEqual(caretQuery(v.state), { trigger: "/", from: 1, to: 5, query: "bul" });
  assert.equal(insertIssueKey(v as never, "PLNR-1"), false, "a key does not go in place of /");
  assert.ok(applyBlock(v as never, commandFor("bullet_list")));
  type(v, "item");
  assert.equal(md(v), "- item\n");

  const h = fakeView("Title", { menus: MENUS });
  h.dispatch(h.state.tr.setSelection(TextSelection.atEnd(h.state.doc)));
  type(h, " /h2");
  assert.ok(applyBlock(h as never, commandFor("h2")));
  assert.equal(md(h), "## Title\n");

  // The nearest trigger wins: "/" typed after a "#" query is the block menu's.
  const n = fakeView("", { menus: MENUS });
  type(n, "#fix /co");
  assert.equal(caretQuery(n.state)?.trigger, "/");

  for (const typed of ["https://x.dev/a", "and/or", "a/", "`/x"]) {
    const w = fakeView("", { menus: MENUS });
    type(w, typed);
    assert.equal(caretQuery(w.state), null, typed);
  }
});

test("/ menu rows: the toolbar's blocks without inline code, matched by a word, the command or the name without spaces", () => {
  assert.deepEqual(
    SLASH_BLOCKS.map((b) => b.label),
    ["Text", "Heading 1", "Heading 2", "Heading 3", "Bulleted list", "Numbered list", "Checklist", "Quote", "Code block", "Table"],
  );
  const names = (q: string) => matchBlocks(q).map((b) => b.label);
  assert.deepEqual(names("h2"), ["Heading 2"]);
  assert.deepEqual(names("bul"), ["Bulleted list"]);
  assert.deepEqual(names("codeblock"), ["Code block"]);
  assert.deepEqual(names("head"), ["Heading 1", "Heading 2", "Heading 3"]);
  assert.equal(names("").length, 10);
  assert.deepEqual(names("tab"), ["Table"]);
  // In a table cell, "/" offers what can be done to the table.
  assert.deepEqual(
    matchBlocks("", true).map((b) => b.label),
    ["Row above", "Row below", "Column left", "Column right", "Delete row", "Delete column", "Delete table"],
  );
  assert.deepEqual(
    matchBlocks("del", true).map((b) => b.label),
    ["Delete row", "Delete column", "Delete table"],
  );
  assert.deepEqual(names("zzz"), []);
});

test("caret menus: a search opened once per trigger, and Enter in a query with a space only for a chosen row", () => {
  let opened = 0;
  const open = () => ++opened;
  let s: Session<number> | null = null;
  for (const at of ["#5", "#5", "#5"]) s = sessionFor(s, at, open);
  assert.equal(opened, 1, "typing on in one # query keeps its index");
  s = sessionFor(s, null, open);
  assert.equal(s, null, "dropped when the query ends");
  s = sessionFor(s, "#5", open);
  assert.equal(opened, 2, "a # typed again opens a new one");

  // "#42 for the details" + Enter: nothing highlighted, the key goes to the editor, which makes a new line.
  const v = fakeView("", { menus: { triggers: ["#"], keys: (e) => menuAction(e.key, highlighted({ query: "", index: 0 }, "q", caretQuery(v.state)!.query, 3), 3) !== null } });
  type(v, "see #42 for the details");
  assert.equal(highlighted({ query: "", index: 0 }, "q", "42 for the details", 3), -1);
  assert.equal(menuAction("Enter", -1, 3), null);
  assert.equal(menuAction("Tab", -1, 3), null);
  assert.ok(press(v, "Enter"));
  assert.equal(v.state.doc.childCount, 2, "a new line");
  assert.equal(v.state.doc.firstChild!.textContent, "see #42 for the details", "the text untouched");
  assert.equal(caretQuery(v.state), null);

  // Without a space the first row is highlighted and Enter picks it; with one, only a row the arrows or the mouse chose.
  assert.equal(highlighted({ query: "", index: 0 }, "q", "core", 3), 0);
  assert.deepEqual(menuAction("Enter", 0, 3), { pick: 0 });
  assert.deepEqual(menuAction("ArrowDown", -1, 3), { move: 0 });
  assert.deepEqual(menuAction("ArrowUp", -1, 3), { move: 2 });
  assert.deepEqual(menuAction("ArrowUp", 0, 3), { move: 2 });
  const chosen: Chosen = { query: "q", index: 1 };
  assert.equal(highlighted(chosen, "q", "42 for the details", 3), 1);
  assert.deepEqual(menuAction("Enter", 1, 3), { pick: 1 });
  assert.equal(menuAction("Escape", -1, 3), "dismiss");
});

/**
 * The comment field's editor (rich-editors.tsx, Composer): Enter sends, and the three menus take keys as CaretMenus does
 * (menuKey), over fixed rows: "/" the toolbar's blocks, "#" one issue, no row chosen by the arrows.
 */
function commentView() {
  let sent = 0;
  let sentText = "";
  const keys = (e: KeyboardEvent) => {
    const q = caretQuery(v.state)!;
    const rows = q.trigger === "/" ? matchBlocks(q.query).map((b) => () => applyBlock(v as never, commandFor(b.cmd))) : q.trigger === "#" && q.query ? [() => insertIssueKey(v as never, "CORE-7")] : [];
    return menuKey(e, highlighted({ query: "", index: 0 }, "q", q.query, rows.length), rows.length, { dismiss: () => dismissQuery(v as never), move: () => {}, pick: (i) => rows[i]!() });
  };
  const submit = () => {
    sent++;
    sentText = md(v);
  };
  const v: ReturnType<typeof fakeView> = fakeView("", { submit, enterSends: true, menus: { triggers: ["@", "#", "/"], keys } });
  return { v, sent: () => sent, sentText: () => sentText };
}

test("comment field: \"/\" and \"#\" pick on Enter without sending, Esc closes the menu and keeps the text, Enter sends after", () => {
  const c = commentView();
  type(c.v, "/bul");
  assert.ok(press(c.v, "Enter"));
  type(c.v, "item");
  assert.equal(md(c.v), "- item\n", "Enter picked the block");
  assert.equal(c.sent(), 0, "and sent nothing");

  // ⌘/Ctrl+Enter with the menu open is the field's: it sends, the "/bul" untouched.
  const m = commentView();
  type(m.v, "/bul");
  assert.ok(caretQuery(m.v.state));
  assert.ok(press(m.v, "Enter", { mod: true }));
  assert.equal(m.sent(), 1);
  assert.equal(m.sentText(), "/bul\n");

  const k = commentView();
  type(k.v, "see #core");
  assert.ok(press(k.v, "Enter"));
  type(k.v, "ok /h");
  assert.equal(c.sent() + k.sent(), 0);
  assert.ok(press(k.v, "Escape"));
  assert.equal(caretQuery(k.v.state), null, "Esc closes the menu");
  assert.equal(md(k.v), "see CORE-7 ok /h\n", "and leaves the text");
  assert.equal(k.sent(), 0);
  assert.ok(press(k.v, "Enter"));
  assert.equal(k.sent(), 1, "with no menu Enter sends");

  // "#core login": a query with a space highlights no row, so Enter is the field's, as in a description: here it sends.
  const s = commentView();
  type(s.v, "see #core login");
  assert.ok(caretQuery(s.v.state));
  press(s.v, "Enter");
  assert.equal(s.sent(), 1);
  assert.equal(s.sentText(), "see #core login\n", "the text as typed");
});

test("comment field: every block \"/\" offers survives the comment's Markdown", () => {
  for (const b of SLASH_BLOCKS) {
    const { v } = commentView();
    type(v, "/");
    assert.ok(applyBlock(v as never, commandFor(b.cmd)), b.label);
    type(v, "x");
    if (b.cmd !== "paragraph") assert.notEqual(v.state.doc.firstChild!.type.name, "paragraph", b.label);
    assert.ok(Node.fromJSON(schema, fromMarkdown(md(v))).eq(v.state.doc), b.label);
  }
});

test("# menu: a key picked inside a link's text goes in without the link", () => {
  const v = fakeView("[see more](https://x.dev/)", { menus: MENUS });
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 4)));
  type(v, " #co");
  assert.ok(insertIssueKey(v as never, "CORE-1"));
  let linked: boolean | undefined;
  v.state.doc.descendants((n) => {
    if (n.isText && n.text!.includes("CORE-1")) linked = n.marks.some((m) => m.type === schema.marks.link);
  });
  assert.equal(linked, false);
});

test("mentions: pasted from a page, rendered with the current name, checked by the server", () => {
  const { document } = parseHTML(`<!doctype html><html><body><p>Hi <span class="mention" data-mention="${ANN}">@Ann</span> <span data-mention="x">@Bad</span></p></body></html>`);
  const doc = plain(DOMParser.fromSchema(schema).parse(document.body as unknown as HTMLElement));
  assert.deepEqual(doc.content![0]!.content, [{ type: "text", text: "Hi " }, { type: "mention", attrs: { id: ANN, label: "Ann" } }, { type: "text", text: " @Bad" }]);
  const host = document.createElement("div");
  host.append(renderDoc(doc, { mentionName: (id) => (id === ANN ? "Ann Lee" : undefined) }, document as unknown as Document) as never);
  assert.equal(host.querySelector(".mention")?.textContent, "@Ann Lee");
  assert.equal(host.querySelector(".mention")?.getAttribute("data-mention"), ANN);
  assert.deepEqual(validateDoc(doc), doc);
  assert.throws(() => validateDoc({ type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "nope", label: "x" } }] }] }), DocError);
  assert.throws(() => validateDoc({ type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: ANN, label: "x".repeat(81) } }] }] }), DocError);
});

test("the server's check: schema, safe links, size and depth caps, canonical form", () => {
  const ok = fromMarkdown("# Hi\n\n- a\n  - b");
  assert.deepEqual(validateDoc(ok), ok);
  assert.throws(() => validateDoc({ type: "doc", content: [{ type: "script", text: "x" }] }), DocError);
  assert.throws(() => validateDoc({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:x" } }] }] }] }), DocError);
  assert.throws(() => validateDoc({ type: "doc", content: [{ type: "bullet_list", content: [{ type: "paragraph" }] }] }), DocError);
  assert.throws(() => validateDoc({ type: "doc", content: [{ type: "heading", attrs: { level: 9 } }] }), DocError);
  let deep: DocNode = { type: "paragraph", content: [{ type: "text", text: "x" }] };
  for (let i = 0; i < 100; i++) deep = { type: "blockquote", content: [deep] };
  assert.throws(() => validateDoc({ type: "doc", content: [deep] }), /deeper/);
  assert.throws(() => validateDoc({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(500_000) }] }] }), /longer/);
  assert.equal(docText(validateDoc({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] })), "ab");
});

test("issue keys in text: the one rule, standing on their own, upper case, numbers an issue can have", () => {
  const keys = (s: string) => issueKeys(s).map((k) => (s.slice(k.from, k.to) === k.key ? k.key : `${k.key} at ${k.from}`));
  assert.deepEqual(keys("PLNR-1. (INFRA-2), LAS-3: OPTO-4! ABCDEFGHIJKL-5 and LAS-2147483647"), ["PLNR-1", "INFRA-2", "LAS-3", "OPTO-4", "ABCDEFGHIJKL-5", "LAS-2147483647"]);
  for (const s of ["a/PLNR-1", "x.PLNR-1", "PLNR-1-2", "_PLNR-1", "PLNR-1_", "ПPLNR-1", "plnr-1", "Plnr-1", "PLNR-0", "PLNR-01", "PLNR-12345678901", "ABCDEFGHIJKLM-1"])
    assert.deepEqual(keys(s), [], s);
});

test("issue keys: found on their own, linked in the reader and drawn in the editor, never in code or links", () => {
  const known = new Set(["PLNR-27", "INFRA-3"]);
  const href = (k: string) => (known.has(k) ? `/atlas/browse/${k}` : undefined);
  const keys = (s: string) => issueRefs(s, href).map((r) => s.slice(r.from, r.to));
  assert.deepEqual(keys("See PLNR-27, (INFRA-3) and PLNR-99."), ["PLNR-27", "INFRA-3"]);
  for (const s of ["xPLNR-27", "a/PLNR-27", "file.PLNR-27", "PLNR-27-2", "PLNR-27x", "plnr-27", "PLNR-027", "#PLNR-27", "@PLNR-27"]) assert.deepEqual(keys(s), [], s);

  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const md = "Fixes PLNR-27 and PLNR-99, see `PLNR-27` and [PLNR-27](https://x.y/).\n\n```\nPLNR-27\n```\n";
  const doc = fromMarkdown(md);
  const host = document.createElement("div");
  host.append(renderDoc(doc, { issueHref: href }, document as unknown as Document) as never);
  const refs = [...host.querySelectorAll("a.issue-ref")];
  assert.deepEqual(refs.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("data-issue")]), [["PLNR-27", "/atlas/browse/PLNR-27", "PLNR-27"]]);
  assert.equal(host.querySelector("p")!.textContent, "Fixes PLNR-27 and PLNR-99, see PLNR-27 and PLNR-27.");
  assert.equal(toMarkdown(doc), md, "the text is stored as typed");

  const v = fakeView("Fixes PLNR-27", { issueHref: href });
  const drawn = () => issueRefKeys(v.state);
  assert.deepEqual(drawn(), ["PLNR-27"]);
  v.dispatch(v.state.tr.setSelection(TextSelection.atEnd(v.state.doc)));
  type(v, " and INFRA-3");
  assert.deepEqual(drawn(), ["PLNR-27", "INFRA-3"]);
  type(v, "4");
  assert.deepEqual(drawn(), ["PLNR-27"], "INFRA-34 names no issue");
  v.dispatch(v.state.tr.delete(v.state.doc.content.size - 2, v.state.doc.content.size - 1));
  // Marks alone (code, a link) change no positions: the key is unlinked and linked again all the same.
  const code = TextSelection.create(v.state.doc, 7, 14);
  v.dispatch(v.state.tr.setSelection(code));
  commandFor("code")(v.state, v.dispatch);
  assert.deepEqual(drawn(), ["INFRA-3"], "code over PLNR-27");
  commandFor("code")(v.state, v.dispatch);
  assert.deepEqual(drawn(), ["PLNR-27", "INFRA-3"], "code removed");
  setLink("https://x.y/")(v.state, v.dispatch);
  assert.deepEqual(drawn(), ["INFRA-3"], "a link over PLNR-27");
  undo(v.state, v.dispatch);
  assert.deepEqual(drawn(), ["PLNR-27", "INFRA-3"], "undone");
  // Split the paragraph between the keys, then join it again.
  v.dispatch(v.state.tr.split(15));
  assert.deepEqual(drawn(), ["PLNR-27", "INFRA-3"], "split");
  v.dispatch(v.state.tr.join(16));
  assert.deepEqual(drawn(), ["PLNR-27", "INFRA-3"], "joined");
  // Select all and paste nearly the same text: the unchanged blocks keep their keys.
  v.dispatch(v.state.tr.split(15));
  const same = v.state.doc.content;
  v.dispatch(v.state.tr.replace(0, v.state.doc.content.size, new Slice(same, 0, 0)));
  assert.deepEqual(drawn(), ["PLNR-27", "INFRA-3"], "replaced with the same content");
  v.dispatch(v.state.tr.join(16));
  v.dispatch(v.state.tr.delete(7, 8));
  assert.deepEqual(drawn(), ["INFRA-3"], "LNR-27 is not a key the workspace has");
  // A key copied from the reader pastes as text, not as a link to its address.
  const { document: page } = parseHTML(`<!doctype html><html><body><p>See <a class="issue-ref" href="https://plan.example.com/a/browse/PLNR-27">PLNR-27</a></p></body></html>`);
  const pasted = plain(DOMParser.fromSchema(schema).parse(page.body as unknown as HTMLElement));
  assert.equal(toMarkdown(pasted), "See PLNR-27\n");
});

test("issue keys in the editor: a plain click opens the issue where the app can, ⌘-click a new tab (RSVA-484)", () => {
  const href = (k: string) => (k === "PLNR-27" ? `/atlas/browse/${k}` : undefined);
  const { document } = parseHTML(`<!doctype html><html><body><p>See <span class="issue-ref" data-issue="PLNR-27"><b>PLNR-27</b></span> now</p></body></html>`);
  const onKey = document.querySelector("b");
  const beside = document.querySelector("p");
  const click = (opts: Parameters<typeof plugins>[0], target: unknown, mods: Partial<MouseEvent> = {}) => {
    const v = fakeView("See PLNR-27 now", opts);
    const p = v.state.plugins.find((x) => x.props.handleClick)!;
    return p.props.handleClick!.call(p, v as never, 6, { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target, ...mods } as MouseEvent);
  };
  const opened: string[] = [];
  const open = (h: string) => opened.push(h);
  assert.equal(click({ issueHref: href, openIssue: open }, onKey), true);
  assert.deepEqual(opened, ["/atlas/browse/PLNR-27"], "a plain click opens it in place");
  assert.equal(click({ issueHref: href, openIssue: open }, beside), false, "a click beside the key places the caret");
  assert.equal(click({ issueHref: href, openIssue: open }, onKey, { shiftKey: true }), false, "Shift-click extends the selection");
  assert.equal(click({ issueHref: href }, onKey), false, "without a way to open, the click places the caret");
  const tabs: string[] = [];
  const was = globalThis.window;
  globalThis.window = { open: (u: string) => tabs.push(u) } as never;
  try {
    assert.equal(click({ issueHref: href, openIssue: open }, onKey, { metaKey: true }), true);
  } finally {
    globalThis.window = was;
  }
  assert.deepEqual([tabs, opened.length], [["/atlas/browse/PLNR-27"], 1], "⌘-click opens a new tab, not in place");
});

// ── Tables (PLNR-367) ─────────────────────────────────────────────────────────────────────────────────────────────

/** A view whose caret is in the table's cell at (row, col), with the view's line test answering yes. */
function tableView(mdText: string, row: number, col: number, opts: Parameters<typeof plugins>[0] = {}) {
  const v = Object.assign(fakeView(mdText, opts), { endOfTextblock: () => true });
  let pos = -1;
  let r = -1;
  v.state.doc.descendants((n, p) => {
    if (n.type.name === "table_row") r++;
    if (n.type.name === "table_cell" && r === row && pos < 0 && col-- === 0) pos = p + 1 + n.content.size;
    return pos < 0;
  });
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)));
  return v;
}

const TABLE = "| a | b |\n| --- | ---: |\n| 1 | 2 |\n";
const cellText = (v: ReturnType<typeof fakeView>) => v.state.selection.$from.parent.textContent;

test("tables: Tab and Shift+Tab move between cells, Tab in the last cell adds a row, Enter goes down", () => {
  const v = tableView(TABLE, 0, 0);
  assert.ok(press(v, "Tab"));
  assert.equal(cellText(v), "b");
  assert.equal(v.state.selection.empty, false, "the next cell's text is selected");
  press(v, "Tab");
  assert.equal(cellText(v), "1");
  press(v, "Tab", { shift: true });
  assert.equal(cellText(v), "b");
  press(v, "Tab", { shift: true });
  assert.ok(press(v, "Tab", { shift: true }), "the first cell keeps Shift+Tab");
  assert.equal(cellText(v), "a");

  const last = tableView(TABLE, 1, 1);
  press(last, "Tab");
  type(last, "x");
  assert.equal(md(last), "| a | b |\n| --- | ---: |\n| 1 | 2 |\n| x |  |\n", "a new row, the column's alignment kept");

  const down = tableView(TABLE, 0, 1);
  assert.ok(press(down, "Enter"));
  assert.equal(cellText(down), "2");
  press(down, "Enter");
  type(down, "y");
  assert.equal(md(down), "| a | b |\n| --- | ---: |\n| 1 | 2 |\n|  | y |\n", "Enter in the last row adds one");

  // Where Enter sends (a comment), Shift+Enter goes down: a cell has no line break.
  let sent = 0;
  const comment = tableView(TABLE, 0, 0, { submit: () => sent++, enterSends: true });
  press(comment, "Enter", { shift: true });
  assert.equal(sent, 0);
  assert.equal(cellText(comment), "1");
  const description = tableView(TABLE, 0, 0);
  press(description, "Enter", { shift: true });
  assert.equal(cellText(description), "1", "no hard break in a cell");
});

test("tables: Up and Down leave the table into the block there, or a new paragraph when there is none", () => {
  const v = tableView(TABLE, 1, 0);
  assert.ok(press(v, "ArrowDown"));
  type(v, "after");
  assert.equal(md(v), TABLE + "\nafter\n");
  const up = tableView("before\n\n" + TABLE, 0, 1);
  press(up, "ArrowUp");
  assert.equal(up.state.selection.$from.parent.textContent, "before");
  const top = tableView(TABLE, 0, 1);
  press(top, "ArrowUp");
  type(top, "above");
  assert.equal(md(top), "above\n\n" + TABLE);
  const inside = tableView(TABLE, 1, 1);
  press(inside, "ArrowUp");
  assert.equal(cellText(inside), "b", "the cell above, the same column");
});

test("tables: rows and columns added and deleted from /, the last one takes the table", () => {
  const run = (v: ReturnType<typeof fakeView>, c: Parameters<typeof commandFor>[0]) => assert.ok(commandFor(c)(v.state, v.dispatch), c);
  const v = tableView(TABLE, 1, 1);
  run(v, "row_above");
  type(v, "r");
  run(v, "col_left");
  type(v, "c");
  assert.equal(md(v), "| a |  | b |\n| --- | --- | ---: |\n|  | c | r |\n| 1 |  | 2 |\n");
  run(v, "delete_col");
  run(v, "delete_row");
  assert.equal(md(v), TABLE);
  run(v, "delete_table");
  assert.deepEqual(plain(v.state.doc), { type: "doc", content: [{ type: "paragraph" }] });
  const one = tableView("| a |\n| --- |\n", 0, 0);
  run(one, "delete_col");
  assert.equal(one.state.doc.firstChild!.type.name, "paragraph", "the last column takes the table");
  // Outside a table these do nothing; a table does not go into a cell.
  const p = fakeView("text");
  assert.equal(commandFor("row_below")(p.state, p.dispatch), false);
  assert.equal(commandFor("table")(v.state, v.dispatch), true, "after the paragraph that replaced the table");
  assert.equal(commandFor("table")(tableView(TABLE, 0, 0).state), false);
});

test("tables: |-- makes one, from the Markdown header row typed above it when there is one", () => {
  const empty = fakeView();
  type(empty, "|--");
  type(empty, "x");
  assert.equal(md(empty), "| x |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n");
  const typed = fakeView("| Name | Status |\n\n");
  typed.dispatch(typed.state.tr.insert(typed.state.doc.content.size, schema.nodes.paragraph!.create()));
  typed.dispatch(typed.state.tr.setSelection(TextSelection.atEnd(typed.state.doc)));
  type(typed, "|--");
  type(typed, "Ann");
  assert.equal(md(typed), "| Name | Status |\n| --- | --- |\n| Ann |  |\n");
  const mid = fakeView("text");
  mid.dispatch(mid.state.tr.setSelection(TextSelection.atEnd(mid.state.doc)));
  type(mid, " |--");
  assert.equal(md(mid), "text |--\n", "only in an empty paragraph");
});

test("tables: pasted Markdown and HTML tables, blocks in a pasted cell keep their text", () => {
  const md2 = markdownSlice("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.equal(md2?.content.firstChild?.type.name, "table");
  const { document } = parseHTML("<html><body></body></html>");
  const host = document.createElement("div");
  host.innerHTML = '<table><tr><th style="text-align:right"><p>Head <b>bold</b></p><p>more</p></th></tr><tr><td><ul><li>x</li></ul><br></td></tr></table>';
  const doc = DOMParser.fromSchema(schema).parse(host as never);
  doc.check();
  assert.equal(toMarkdown(plain(doc)), "| Head **bold** more |\n| ---: |\n| x |\n");
});

test("tables: drawn as the editor draws them, checked on the server", () => {
  const { document } = parseHTML("<html><body></body></html>");
  const host = document.createElement("div");
  host.append(renderDoc(fromMarkdown(TABLE), {}, document as unknown as Document) as never);
  assert.equal(host.innerHTML, '<div class="table-wrap"><table><tbody><tr><td>a</td><td data-align="right">b</td></tr><tr><td>1</td><td data-align="right">2</td></tr></tbody></table></div>');
  assert.deepEqual(validateDoc(fromMarkdown(TABLE)), fromMarkdown(TABLE));
  const cell = (content: DocNode[], align = "") => ({ type: "doc", content: [{ type: "table", content: [{ type: "table_row", content: [{ type: "table_cell", attrs: { align }, content }] }] }] });
  assert.throws(() => validateDoc(cell([{ type: "hard_break" }])), DocError, "no break in a cell");
  assert.throws(() => validateDoc(cell([{ type: "text", text: "x" }], "justify")), DocError, "alignments are GitHub's");
  assert.throws(() => validateDoc({ type: "doc", content: [{ type: "table", content: [] }] }), DocError, "a table has a row");
  assert.equal(docText(fromMarkdown(TABLE)), "a | b\n1 | 2");
});

test("a drop takes files from outside the page; an image the page drags goes to ProseMirror (PLNR-386)", () => {
  const taken: File[][] = [];
  const plugin = uploadPlugin((files) => (taken.push(files), files.map(() => Promise.resolve(null))));
  const v = { ...fakeView("Text"), posAtCoords: () => ({ pos: 1, inside: -1 }), isDestroyed: false };
  v.state = EditorState.create({ doc: v.state.doc, plugins: [plugin] });
  const image = new File([new Uint8Array(4)], "image.png", { type: "image/png" });
  const drop = (types: string[]) =>
    plugin.props.handleDrop!.call(plugin, v as never, { dataTransfer: { types, files: [image] }, clientX: 0, clientY: 0 } as never, Slice.empty, false);
  // Chrome's drop of an <img> dragged from another editor (measured in PLNR-352): the file is there beside the page's mark.
  assert.equal(drop(["text/plain", "text/html", PAGE_DRAG, "Files"]), false);
  assert.equal(taken.length, 0);
  assert.equal(drop(["Files"]), true);
  assert.deepEqual(taken, [[image]]);
});
