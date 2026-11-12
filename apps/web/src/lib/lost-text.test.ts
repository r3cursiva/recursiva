import assert from "node:assert/strict";
import { test } from "node:test";
import type { LostWork } from "@rsva/sync";
import { lostText } from "./lost-text.ts";

test("a refused description keeps its mention and hard break", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Ask " }, { type: "mention", attrs: { id: "u1", label: "Ann" } }, { type: "hard_break" }, { type: "text", text: "today" }] },
      { type: "paragraph", content: [{ type: "text", text: "Second" }] },
    ],
  };
  assert.equal(lostText([{ text: "Title", doc } as unknown as LostWork]), "Title\nAsk @Ann\ntoday\nSecond");
});
