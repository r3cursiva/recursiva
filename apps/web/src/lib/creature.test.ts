import { CREATURE } from "@rsva/schema/models";
import { avatarTone } from "@rsva/display/avatar";
import { CREATURE_FIELDS, creatureOfName, creatureShape, decodeCreature, encodeCreature, randomCreature, type Creature } from "@rsva/ui/lib/creature";
import { seeded } from "@rsva/schema/util";
import assert from "node:assert/strict";
import { test } from "node:test";

// The generated avatar (PLNR-366) lives in packages/ui; this checks it against the form the server keeps.

const many = (n: number): Creature[] => Array.from({ length: n }, (_, i) => randomCreature(seeded(i * 977 + 1), "sage"));

test("what the editor saves, the server takes, and it reads back the same", () => {
  for (const c of many(500)) {
    const s = encodeCreature(c);
    assert.match(s, CREATURE);
    assert.deepEqual(decodeCreature(s), c);
  }
});

test("a string out of range is brought into it; anything else is no creature", () => {
  const c = decodeCreature("c1:99,-5,50,0,10,7,50,0,0,9")!;
  assert.deepEqual([c.petals, c.spike, c.size, c.eyes, c.tone], [12, 0, 55, 3, "iris"]);
  for (const bad of ["", "c1:1,2,3", "c2:1,2,3,4,5,6,7,8,9,0", "c1:1,2,3,4,5,6,7,8,9,x", "c1:1.5,2,3,4,5,6,7,8,9,0"]) assert.equal(decodeCreature(bad), null, bad);
});

test("the tones keep their indexes: a saved creature keeps its tone, and the four added ones follow", () => {
  assert.deepEqual(["0", "3", "4", "7"].map((i) => decodeCreature(`c1:5,40,60,-12,82,2,40,30,50,${i}`)!.tone), ["sand", "slate", "clay", "iris"]);
  for (const tone of ["clay", "moss", "teal", "iris"] as const) assert.equal(decodeCreature(encodeCreature({ ...many(1)[0]!, tone }))!.tone, tone);
});

test("a name gives the same creature every time, two-eyed, on the tone it had before", () => {
  assert.deepEqual(creatureOfName("Robin Vale"), creatureOfName("Robin Vale"));
  assert.notDeepEqual(creatureOfName("Robin Vale"), creatureOfName("Mira Holt"));
  assert.equal(creatureOfName("Robin Vale").tone, avatarTone("Robin Vale"));
  for (const n of ["Robin Vale", "Mira Holt", "Teo Park", "Owner", "Ада Лавлейс"]) assert.equal(creatureOfName(n).eyes, 2, n);
});

test("every mood has a mouth: a straight line at 0, a curve either way", () => {
  const c = many(1)[0]!;
  const sag = (mood: number) => { const n = creatureShape({ ...c, mood }).mouth.d.match(/-?[\d.]+/g)!.map(Number); return n[3]! - n[1]!; };
  assert.deepEqual([-10, 0, 10].map((m) => Math.sign(sag(m))), [-1, 0, 1]);
});

test("every slider's ends draw a shape that fits the box", () => {
  const ends = many(50).flatMap((c, i) => CREATURE_FIELDS.map((f, j) => ({ ...c, [f.key]: (i + j) % 2 ? f.max : f.min })));
  for (const c of [...ends, ...many(300)]) {
    const { body, eyes, mouth } = creatureShape(c);
    const numbers = [...body.matchAll(/-?[\d.]+/g)].map((m) => Number(m[0]));
    assert.ok(numbers.every((v) => Number.isFinite(v) && v >= -1 && v <= 101), encodeCreature(c));
    assert.ok(eyes.every((e) => Object.values(e).every(Number.isFinite)));
    assert.ok(!mouth.d.includes("NaN"));
  }
});
