// Archive and delete times, of a project or an issue: the client sends any time to archive or delete and null to
// restore, the server writes its own time. Setting one that is set (or clearing a clear one) is not a change.
import { sql as dsql, type SQL } from "drizzle-orm";
import { z } from "zod";

export const moment = z.iso.datetime({ offset: true }).nullable();

/** The columns to write for the moments that flip between set and clear; their old values go into `prev` for the log. */
export function momentChanges<K extends string>(
  row: NoInfer<Record<K, string | null>>,
  set: { [P in K]?: string | null | undefined },
  prev: Record<string, unknown>,
): Partial<Record<K, SQL | null>> {
  const out: Partial<Record<K, SQL | null>> = {};
  for (const k of Object.keys(set) as K[]) {
    const v = set[k];
    if (v === undefined || (v === null) === (row[k] === null)) continue;
    out[k] = v === null ? null : dsql`now()`;
    prev[k] = row[k];
  }
  return out;
}
