// Pure pieces of the project settings screen and New project: a key from a name and whether it is free. Where a moved
// state lands, the label tree and the label colors are in @rsva/schema/settings: the agent API places and lists them too.
import { PROJECT_KEY, type Project } from "@rsva/schema/models";

/** Why `key` cannot become the project's key (`project` null: a new one), or null if it can (the server checks the same). */
export function keyProblem(key: string, project: Pick<Project, "id"> | null, projects: Iterable<Project>): string | null {
  if (!key) return "Enter a key";
  if (!PROJECT_KEY.test(key)) return "A letter, then up to 11 letters or digits";
  for (const p of projects) {
    if (p.id === project?.id) continue;
    if (p.key === key) return `${p.name} has this key`;
    if (p.formerKeys.includes(key)) return `Old links of ${p.name} use ${key}`;
  }
  return null;
}

const RU: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** A name in lower-case Latin letters, Cyrillic spelled out: "Мой отдел" → "moy otdel". Keys and addresses start here. */
export const latin = (name: string) => [...name.toLowerCase()].map((c) => RU[c] ?? c).join("");

/**
 * A key from a name: its first three letters or digits, from the first letter ("Engineering" → "ENG", "Сайт" → "SAY").
 * Given the workspace's projects, the first free one: one more letter of the name ("INF" taken → "INFR"), then a
 * number ("INF2"). Empty when the name has no letter.
 */
export function keyFrom(name: string, projects: Iterable<Project> = []): string {
  const all = latin(name).replace(/[^a-z0-9]/g, "").replace(/^[0-9]+/, "").toUpperCase().slice(0, 12);
  const base = all.slice(0, 3);
  if (!base) return "";
  const taken = new Set<string>();
  for (const p of projects) for (const k of [p.key, ...p.formerKeys]) taken.add(k);
  for (let n = 3; n <= Math.min(all.length, 5); n++) if (!taken.has(all.slice(0, n))) return all.slice(0, n);
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}
