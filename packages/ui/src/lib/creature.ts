// A generated avatar (PLNR-366): a small creature for a person without a picture. Its body is a superformula (Gielis)
// blended with a circle, so the middle stays round enough for the eyes; then eyes and a mouth. Nine numbers and a tone
// describe it; they are kept on the user as a short string (CREATURE in @rsva/schema/models checks it on the server),
// and a person who never chose one gets the one their name gives, as their tone was picked by the name before.
//
// Compared in a prototype (https://claude.ai/artifact/7JhrDCAqekzHa2vhYZ46qk) with Truchet tiles and space-filling
// curves: only the creature still tells people apart at 20 px; the patterns turn into the same texture.
import { seeded } from "@rsva/schema/util";
import { AVATAR_TONES, avatarTone, type AvatarTone } from "@rsva/display/avatar";

/** What the sliders set: whole numbers, as the string keeps them. */
export interface Creature {
  /** Lobes of the body; 0 is a circle. */
  petals: number;
  /** 0 round, 100 spiky. */
  spike: number;
  /** How far the lobes reach out of the circle, 0–100. */
  lobes: number;
  /** Uneven lobes, −100–100. */
  wobble: number;
  /** The body's radius, percent of the avatar's. */
  size: number;
  eyes: number;
  /** Between the eyes, 0–100. */
  gap: number;
  /** Where the pupils look, −100 left to 100 right. */
  look: number;
  /** The mouth: −100 sad, 0 a straight line, 100 happy. */
  mood: number;
  tone: AvatarTone;
}

type Field = Exclude<keyof Creature, "tone">;

/** The fields in the string's order, with their ranges. */
export const CREATURE_FIELDS: readonly { key: Field; min: number; max: number }[] = [
  { key: "petals", min: 0, max: 12 },
  { key: "spike", min: 0, max: 100 },
  { key: "lobes", min: 0, max: 100 },
  { key: "wobble", min: -100, max: 100 },
  { key: "size", min: 55, max: 95 },
  { key: "eyes", min: 0, max: 3 },
  { key: "gap", min: 0, max: 100 },
  { key: "look", min: -100, max: 100 },
  { key: "mood", min: -100, max: 100 },
];

const PREFIX = "c1:";

/** "c1:5,40,60,-12,82,2,40,30,50,1": the fields, then the tone's index. */
export function encodeCreature(c: Creature): string {
  return PREFIX + [...CREATURE_FIELDS.map((f) => c[f.key]), AVATAR_TONES.indexOf(c.tone)].join(",");
}

/** The creature a string keeps, each number brought into its range; null for anything else. */
export function decodeCreature(s: string): Creature | null {
  if (!s.startsWith(PREFIX)) return null;
  const n = s.slice(PREFIX.length).split(",").map(Number);
  if (n.length !== CREATURE_FIELDS.length + 1 || !n.every(Number.isInteger)) return null;
  const c = { tone: AVATAR_TONES[clamp(n.at(-1)!, 0, AVATAR_TONES.length - 1)]! } as Creature;
  CREATURE_FIELDS.forEach((f, i) => (c[f.key] = clamp(n[i]!, f.min, f.max)));
  return c;
}

/** A creature from any random source: what Shuffle draws, and, seeded by the name, a person's own. */
export function randomCreature(random: () => number, tone: AvatarTone): Creature {
  // + 0 turns -0 into 0: the string would not tell them apart.
  const between = (a: number, b: number) => Math.round(a + (b - a) * random()) + 0;
  const r = random();
  return {
    petals: between(2, 9),
    spike: between(10, 85),
    lobes: between(25, 80),
    wobble: between(-40, 40),
    size: between(72, 90),
    eyes: r < 0.6 ? 2 : r < 0.85 ? 1 : r < 0.95 ? 3 : 0,
    gap: between(20, 80),
    look: between(-100, 100),
    mood: between(-60, 80),
    tone,
  };
}

/** The creature a name gives: the same name, the same creature, on the tone the name already had; always two eyes. */
export const creatureOfName = (name: string): Creature => ({ ...randomCreature(seeded(hash(name)), avatarTone(name)), eyes: 2 });

/** FNV-1a: avatarTone's hash is too weak to seed nine numbers. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** What an avatar draws, in a 100 × 100 box. */
export interface CreatureShape {
  body: string;
  eyes: readonly { x: number; y: number; r: number; px: number; py: number; pr: number }[];
  mouth: { d: string; width: number };
}

/** Points around the body: enough for twelve sharp lobes. */
const SAMPLES = 144;
const TAU = 2 * Math.PI;
const round1 = (v: number): number => Math.round(v * 10) / 10;
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const towards = (a: number, b: number, t: number): number => a * Math.pow(b / a, t);

/** The shape of a creature. Lists draw one person many times: the last shapes are kept. */
export function creatureShape(c: Creature): CreatureShape {
  const key = encodeCreature(c);
  let s = shapes.get(key);
  if (!s) {
    if (shapes.size >= 256) shapes.delete(shapes.keys().next().value!);
    shapes.set(key, (s = draw(c)));
  }
  return s;
}
const shapes = new Map<string, CreatureShape>();

function draw(c: Creature): CreatureShape {
  const spike = c.spike / 100, lobes = c.lobes / 100, size = c.size / 100;
  const n1 = towards(12, 0.2, spike), n2 = towards(15, 1.7, spike), n3 = n2 * (1 + (c.wobble / 100) * 0.7);
  const radii: number[] = [];
  let max = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const t = (c.petals * (i / SAMPLES) * TAU) / 4;
    const a = Math.abs(Math.cos(t)) ** n2 + Math.abs(Math.sin(t)) ** n3;
    // Where the sum nears 0 the radius runs off; capped, it only makes a sharper spike.
    const r = a > 0 ? Math.min(a ** (-1 / n1), 4) : 4;
    radii.push(r);
    max = Math.max(max, r);
  }
  // A lobe points up: the creature stands on the gap between two.
  const R = 46 * size;
  let body = "";
  radii.forEach((r, i) => {
    const phi = (i / SAMPLES) * TAU - Math.PI / 2;
    const rad = R * (1 - lobes + (lobes * r) / max);
    body += `${i ? "L" : "M"}${round1(50 + rad * Math.cos(phi))} ${round1(52 + rad * Math.sin(phi))}`;
  });
  body += "Z";

  const k = size / 0.8;
  const cy = 50 - 3 * k;
  const er = (c.eyes === 3 ? 6.5 : c.eyes === 1 ? 10 : 8.2) * k;
  const gx = (7 + (c.gap / 100) * 11) * k;
  const at: [number, number][] =
    c.eyes === 1 ? [[50, cy]]
    : c.eyes === 2 ? [[50 - gx, cy], [50 + gx, cy]]
    : c.eyes === 3 ? [[50 - gx, cy + 3 * k], [50 + gx, cy + 3 * k], [50, cy - er * 1.5]]
    : [];
  const eyes = at.map(([x, y]) => ({ x: round1(x), y: round1(y), r: round1(er), px: round1(x + (c.look / 100) * er * 0.4), py: round1(y + er * 0.12), pr: round1(er * 0.52) }));

  const w = (c.eyes ? 7 : 11) * k, y = cy + (c.eyes ? er : 0) + 9 * k;
  const mouth = { d: `M${round1(50 - w)} ${round1(y)}Q50 ${round1(y + (c.mood / 100) * 12 * k)} ${round1(50 + w)} ${round1(y)}`, width: round1(2.8 * k) };
  return { body, eyes, mouth };
}
