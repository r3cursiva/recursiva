// The screens' key tables (PLNR-424): the keys lines are the artboards', every key a line says is one the screen takes,
// chords wait for their second key, and the lists' cursors move alike.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { App } from "./app.ts";
import { cursorKey, helpOf, hintsOf, ISSUE_KEYS, LIST_KEYS, press, type Binding } from "./keys.ts";
import { QUEUE_HINTS, QUEUE_KEYS } from "./queue.ts";

const on = (from: "list" | "queue" | null) => ({ reading: () => (from ? { from } : null) }) as unknown as App;

test("the keys lines: the list's (the artboard's and . more), the issue screen's with the issue's actions (PLNR-439)", () => {
  assert.deepEqual(hintsOf(LIST_KEYS, false, on(null)), [
    ["j/k", "move"],
    ["↵", "open"],
    ["f", "filter"],
    ["s", "state"],
    ["d", "dispatch"],
    [".", "more"],
    ["g q", "queue"],
    ["o", "browser"],
    ["q", "quit"],
  ]);
  assert.deepEqual(hintsOf(LIST_KEYS, true, on(null)), hintsOf(LIST_KEYS, false, on(null)).slice(0, 6));
  assert.deepEqual(
    hintsOf(ISSUE_KEYS, false, on("list")).map(([k]) => k),
    ["↑↓", "j/k ←→", "s", "p", "a", "r", "d", ".", "Esc"],
  );
  // At 80 columns p and a go: the menu and the sheet have them.
  assert.deepEqual(
    hintsOf(ISSUE_KEYS, true, on("list")).map(([k]) => k),
    ["↑↓", "j/k ←→", "s", "r", "d", ".", "Esc"],
  );
  // From the queue j, k, ← and → are the queue's: the line does not offer them.
  assert.deepEqual(
    hintsOf(ISSUE_KEYS, false, on("queue")).map(([k]) => k),
    ["↑↓", "s", "p", "a", "r", "d", ".", "Esc"],
  );
  assert.deepEqual(
    QUEUE_HINTS.map(([k]) => k),
    ["↵", "d", "→", "←", "c", "o", "u", "Esc"],
  );
});

test("every key a line or the sheet names is one its screen takes, and every key it takes is in its sheet", () => {
  for (const table of [LIST_KEYS, ISSUE_KEYS, QUEUE_KEYS] as unknown as Binding<unknown>[][]) {
    // An entry with a line of its own runs, or says a key taken before the screen's (q, ⌃K, the mouse).
    for (const b of table) if (b.hint || b.help) assert.ok(b.run || b.keys.length === 0, `${b.help?.[0] ?? b.hint?.[0]} does nothing`);
    // A key taken with no line of its own is the pair of the entry right before it (k of j, end of home), which names both.
    table.forEach((b, i) => {
      if (b.run && !b.help) assert.ok(table[i - 1]?.help, `${b.keys.join(" ")} is in no sheet`);
    });
  }
  assert.equal(helpOf(LIST_KEYS).at(-1)?.[0], "q  ⌃C");
});

test("a chord waits for its second key; a second key that ends none is dropped", () => {
  const ran: string[] = [];
  const table: Binding<null>[] = [
    { keys: ["g q"], run: () => ran.push("queue") },
    { keys: ["q"], run: () => ran.push("q") },
  ];
  const held = { chord: "" };
  assert.equal(press(table, null, "g", held), true);
  assert.equal(held.chord, "g");
  assert.equal(press(table, null, "q", held), true);
  assert.deepEqual(ran, ["queue"]);
  press(table, null, "g", held);
  assert.equal(press(table, null, "x", held), true, "taken by the chord");
  assert.equal(held.chord, "");
  assert.equal(press(table, null, "x", held), false);
  assert.deepEqual(ran, ["queue"]);
});

test("an entry not there now takes nothing: j and k on the issue screen opened from the queue", () => {
  let stepped = 0;
  const app = { ...on("queue"), step: () => stepped++ } as unknown as App;
  assert.equal(press(ISSUE_KEYS, app, "j", { chord: "" }), false);
  assert.equal(press(ISSUE_KEYS, { ...on("list"), step: () => stepped++ } as unknown as App, "j", { chord: "" }), true);
  assert.equal(stepped, 1);
});

test("a list's cursor: a click on a row, the arrows, j and k only where they are not letters, never past the ends", () => {
  assert.equal(cursorKey(0, "at:7", 5), 4);
  assert.equal(cursorKey(0, "down", 5), 1);
  assert.equal(cursorKey(4, "down", 5), 4);
  assert.equal(cursorKey(0, "up", 5), 0);
  assert.equal(cursorKey(0, "j", 5), null);
  assert.equal(cursorKey(0, "j", 5, true), 1);
  assert.equal(cursorKey(0, "down", 0), 0);
  assert.equal(cursorKey(2, "x", 5), null);
});

test("a key does one thing on a screen; A is free (the web's assignees, archive is in the menu)", () => {
  for (const table of [LIST_KEYS, ISSUE_KEYS]) {
    const keys = table.flatMap((b) => b.keys);
    assert.deepEqual(
      keys.filter((k, i) => keys.indexOf(k) !== i),
      [],
    );
    assert.ok(!keys.includes("A"));
  }
});
