import assert from "node:assert/strict";
import { test } from "node:test";
import type { Label, Project } from "@rsva/schema/models";
import { labelTree, positionAt } from "@rsva/schema/settings";
import { keyFrom, keyProblem } from "./project-settings.ts";

test("a dropped row lands between its neighbours, past the edges, or at 0 alone", () => {
  assert.equal(positionAt([], 0), 0);
  assert.equal(positionAt([1, 2, 3], 0), 0);
  assert.equal(positionAt([1, 2, 3], 1), 1.5);
  assert.equal(positionAt([1, 2, 3], 3), 4);
});

const project = (id: string, key: string, formerKeys: string[] = []) => ({ id, key, name: `P ${key}`, formerKeys }) as unknown as Project;

test("a key must be well formed and free of other projects' keys and old keys", () => {
  const me = project("1", "WEB", ["SITE"]);
  const all = [me, project("2", "INFRA", ["OPS"])];
  assert.equal(keyProblem("", me, all), "Enter a key");
  assert.equal(keyProblem("9AB", me, all), "A letter, then up to 11 letters or digits");
  assert.equal(keyProblem("INFRA", me, all), "P INFRA has this key");
  assert.equal(keyProblem("OPS", me, all), "Old links of P INFRA use OPS");
  assert.equal(keyProblem("SITE", me, all), null, "taking back its own old key");
  assert.equal(keyProblem("WEB2", me, all), null);
  assert.equal(keyProblem("WEB", null, all), "P WEB has this key", "a new project has no key of its own");
});

test("a key from a name: three letters from the first one, longer or numbered when taken", () => {
  assert.equal(keyFrom("Engineering"), "ENG");
  assert.equal(keyFrom("Сайт компании"), "SAY");
  assert.equal(keyFrom("2026 roadmap"), "ROA");
  assert.equal(keyFrom("  !! "), "");
  const all = [project("1", "INF", ["INFR"]), project("2", "INFRA"), project("3", "OPS")];
  assert.equal(keyFrom("Infrastructure", all), "INF2", "INF, INFR and INFRA are taken, former keys too");
  assert.equal(keyFrom("Opsgenie", all), "OPSG");
  assert.equal(keyFrom("Ops", all), "OPS2", "a short name gets a number");
});

const label = (id: string, position: number, parentId: string | null = null) => ({ id, name: id, position, parentId }) as Label;

test("labels read parent first, then the labels inside it; an unknown parent counts as none", () => {
  const tree = labelTree([label("b", 2), label("a", 1), label("a2", 2, "a"), label("a1", 1, "a"), label("x", 0, "gone")]);
  assert.deepEqual(
    tree.map((t) => `${"-".repeat(t.depth)}${t.label.id}`),
    ["x", "a", "-a1", "-a2", "b"],
  );
});
