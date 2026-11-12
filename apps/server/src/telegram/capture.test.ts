import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { albumWait, joinAlbum } from "./capture.ts";
import { chatHarness } from "./test-chat.ts";

const { issue, attachment } = schema;
const { files, f, newIssue, say, post, buttons, person } = chatHarness();

const KEY = () => f.refs.project.key;
const FORWARD = { forward_origin: { type: "user", date: Date.UTC(2026, 10, 5, 12) / 1000, sender_user: { first_name: "Boris", last_name: "Ivanov" } } };
const DRAFT = (title: string, key = KEY()) => `New issue from this message?\n${title}\nProject: ${key}`;

/** A button pressed under a draft that replies to `source`. */
const pressDraft = (chatId: number, data: string, text: string, source?: Record<string, unknown>) =>
  post({
    update_id: 3,
    callback_query: {
      id: `q${data}`,
      from: { id: chatId },
      data,
      message: { message_id: 41, text, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private" }, ...(source ? { reply_to_message: { message_id: 8, ...source } } : {}) },
    },
  });

const made = async (userId: string, title: string) => (await db.select().from(issue).where(and(eq(issue.createdById, userId), eq(issue.title, title))))[0];
const bodyOf = async (id: string) => JSON.stringify((await db.select().from(schema.document).where(eq(schema.document.id, id)))[0]?.doc);

test("a forwarded message answers with a draft; Create makes the issue, with the text, the source and the file", async () => {
  const { me, chatId } = await person();
  await newIssue(me.id, { title: "Mine" });

  const draft = await say(chatId, { text: "Server is down since noon\nlogs attached", ...FORWARD });
  assert.equal(draft.text, DRAFT("Server is down since noon"));
  assert.deepEqual(buttons(draft).map((b) => b.callback_data), ["fw:c", "fw:pick", "fw:x"]);
  assert.equal((draft as unknown as { reply_parameters: { message_id: number } }).reply_parameters.message_id, 7, "under the forwarded message");

  files.set("fw-doc", Buffer.from("%PDF-1.4 not really"));
  const source = { caption: "Server is down since noon\nlogs attached", document: { file_id: "fw-doc", file_name: "logs.pdf", mime_type: "application/pdf", file_size: 20 }, ...FORWARD };
  const done = await pressDraft(chatId, "fw:c", DRAFT("Server is down since noon"), source);
  assert.equal(done.method, "editMessageText");
  assert.match(done.text, /Created, with the file attached/);
  const row = (await made(me.id, "Server is down since noon"))!;
  assert.match(await bodyOf(row.id), /logs attached/);
  assert.match(await bodyOf(row.id), /Forwarded from Boris Ivanov, 2026-11-05/);
  const [att] = await db.select().from(attachment).where(eq(attachment.issueId, row.id));
  assert.equal(att!.title, "logs.pdf");
});

test("a forward with nothing in it, in a chat nobody linked, and a deleted source", async () => {
  const { me, chatId } = await person();
  await newIssue(me.id, { title: "Mine" });
  assert.equal((await say(chatId, { sticker: {}, ...FORWARD })).text, "Nothing to make an issue of.");
  assert.deepEqual(await say(515_151, { text: "hello", ...FORWARD }), {}, "a stranger's chat gets nothing");
  const gone = await pressDraft(chatId, "fw:c", DRAFT("Hello"));
  assert.match(gone.text, /Not created: the forwarded message was deleted/);
  assert.deepEqual(buttons(gone), []);
});

test("Project ▾ lists the projects, the choice goes into the draft, Cancel closes it", async () => {
  const { me, chatId } = await person();
  await newIssue(me.id, { title: "Mine" });
  const text = DRAFT("Pick me", "ZZZ");
  const pick = await pressDraft(chatId, "fw:pick", text, { text: "Pick me", ...FORWARD });
  assert.ok(buttons(pick).some((b) => b.callback_data === `fw:p:${KEY()}`));
  // The draft comes back as plain text; it is drawn again escaped, not as markup.
  const marked = await pressDraft(chatId, "fw:pick", DRAFT("<b>bold</b> & co", "ZZZ"), { text: "<b>bold</b> & co", ...FORWARD });
  assert.match(marked.text, /&lt;b&gt;bold&lt;\/b&gt; &amp; co/);
  const chosen = await pressDraft(chatId, `fw:p:${KEY()}`, text, { text: "Pick me", ...FORWARD });
  assert.equal(chosen.text, DRAFT("Pick me"));
  assert.deepEqual(buttons(chosen).map((b) => b.callback_data), ["fw:c", "fw:pick", "fw:x"]);

  // The title is plain text: #tags and @names in it are not read as fields.
  const created = await pressDraft(chatId, "fw:c", chosen.text, { text: "Fix #nope @nobody", ...FORWARD });
  assert.match(created.text, /Created/);
  assert.ok(await made(me.id, "Fix #nope @nobody"));

  const cancelled = await pressDraft(chatId, "fw:x", chosen.text, { text: "Pick me", ...FORWARD });
  assert.equal(cancelled.text, "Not created.");
  assert.deepEqual(buttons(cancelled), []);
});

test("/new in a reply to the person's own message takes its text and file; a reply to the bot's card still makes a sub-issue", async () => {
  const { me, chatId } = await person();
  const parent = await newIssue(me.id, { title: "Parent" });
  files.set("note-ph", Buffer.from("\x89PNG\r\n\x1a\n note"));
  await say(chatId, { text: "/new Ticket from a note\nMy own line", reply_to_message: { message_id: 3, text: "What the note said", photo: [{ file_id: "note-ph", file_size: 20 }], from: { is_bot: false } } });
  const row = (await made(me.id, "Ticket from a note"))!;
  const body = await bodyOf(row.id);
  assert.ok(body.indexOf("My own line") < body.indexOf("What the note said"), "the command's lines first");
  assert.equal((await db.select().from(attachment).where(eq(attachment.issueId, row.id))).length, 1);

  const sub = await say(chatId, { text: "/new A step", reply_to_message: { message_id: 4, text: `${parent} · Parent`, from: { is_bot: true } } });
  assert.doesNotMatch(sub.text, /Nothing/);
});

test("an album with one /new caption becomes one issue with every photo", async () => {
  const { me, chatId } = await person();
  await newIssue(me.id, { title: "Mine" });
  albumWait.ms = 150;
  for (const id of ["al-1", "al-2", "al-3"]) files.set(id, Buffer.from(`\x89PNG\r\n\x1a\n ${id}`));
  const photo = (id: string) => [{ file_id: id, file_size: 20 }];
  const first = say(chatId, { caption: "/new Three photos", photo: photo("al-1"), media_group_id: "g1" });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(await say(chatId, { photo: photo("al-2"), media_group_id: "g1" }), {}, "the rest of the album is taken quietly");
  assert.deepEqual(await say(chatId, { photo: photo("al-3"), media_group_id: "g1" }), {});
  assert.match((await first).text, /with 3 files attached/);
  const row = (await made(me.id, "Three photos"))!;
  assert.equal((await db.select().from(attachment).where(eq(attachment.issueId, row.id))).length, 3);
});

test("the draft's project is its own Project line, not a line of the forwarded text that reads the same", async () => {
  const { me, chatId } = await person();
  await newIssue(me.id, { title: "Mine" });
  const created = await pressDraft(chatId, "fw:c", `New issue from this message?\nProject: NOPE\nProject: ${KEY()}`, { text: "Project: NOPE\nbody", ...FORWARD });
  assert.match(created.text, /Created/);
});

test("an album whose photos come before its /new still becomes one issue with every photo (review of PLNR-358)", async () => {
  const { me, chatId } = await person();
  await newIssue(me.id, { title: "Mine" });
  albumWait.ms = 150;
  for (const id of ["ob-1", "ob-2", "ob-3"]) files.set(id, Buffer.from(`\x89PNG\r\n\x1a\n ${id}`));
  const photo = (id: string) => [{ file_id: id, file_size: 20 }];
  assert.deepEqual(await say(chatId, { photo: photo("ob-2"), media_group_id: "g2" }), {}, "taken quietly before its /new");
  assert.deepEqual(await say(chatId, { photo: photo("ob-3"), media_group_id: "g2" }), {});
  assert.match((await say(chatId, { caption: "/new Out of order", photo: photo("ob-1"), media_group_id: "g2" })).text, /with 3 files attached/);
  const row = (await made(me.id, "Out of order"))!;
  assert.equal((await db.select().from(attachment).where(eq(attachment.issueId, row.id))).length, 3);
});

test("a stranger's album is not kept: only a linked chat's photos wait for its /new", async () => {
  const { chatId } = await person();
  const photo = { photo: [{ file_id: "st-1", file_size: 20 }], media_group_id: "g-stranger", message_id: 1 };
  assert.equal(await joinAlbum({ ...photo, chat: { id: 919_191, type: "private" } }), false);
  assert.deepEqual(await say(919_191, photo), {}, "and the bot says nothing to it");
  assert.equal(await joinAlbum({ ...photo, chat: { id: chatId, type: "private" } }), true);
});
