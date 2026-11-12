import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsPath, cyclePath, issuePath } from "../src/models.ts";

// The addresses emails, chat cards, the terminal and the web router all build: links already sent must keep opening.
test("app paths are built byte for byte as before", () => {
  assert.equal(issuePath("arsen", "PLNR-418"), "/arsen/browse/PLNR-418");
  assert.equal(cyclePath("arsen", "PLNR", 12), "/arsen/projects/PLNR/cycles/12");
  assert.equal(settingsPath("arsen", "notifications"), "/arsen/settings/notifications");
  assert.equal(settingsPath("arsen", "notifications/email"), "/arsen/settings/notifications/email");
  assert.equal(settingsPath("arsen", "notifications/telegram"), "/arsen/settings/notifications/telegram");
});
