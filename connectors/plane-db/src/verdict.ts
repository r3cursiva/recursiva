// Whether an import matches Plane's copy: the gate before the live planner (tools/release/src/plane-sync.ts), so pure and tested.

/** Members are shown, not judged: people join here on their own, and a member deactivated in Plane is still a row there. */
const SHOWN_ONLY = new Set(["members"]);

export interface Comparison {
  rows: { model: string; ok: string }[];
  fieldDiffs: Record<string, number>;
  commentsMissing: number;
  imagesWithoutFile: number;
  planeLinks: number;
  /** Documents with a difference, per document set and kind. */
  formatDiffs: number[];
}

/** What is wrong, in words; empty when the import is right. */
export function failures(c: Comparison): string[] {
  const out = c.rows.filter((r) => r.ok && !SHOWN_ONLY.has(r.model)).map((r) => `${r.model} differ`);
  for (const [field, n] of Object.entries(c.fieldDiffs)) if (n > 0) out.push(`${n} issues differ in ${field}`);
  if (c.commentsMissing > 0) out.push(`${c.commentsMissing} comments missing`);
  if (c.imagesWithoutFile > 0) out.push(`${c.imagesWithoutFile} images without an image file`);
  if (c.planeLinks > 0) out.push(`${c.planeLinks} texts still link to Plane's assets`);
  const formats = c.formatDiffs.reduce((a, b) => a + b, 0);
  if (formats > 0) out.push(`formatting differs in ${formats} places`);
  return out;
}
