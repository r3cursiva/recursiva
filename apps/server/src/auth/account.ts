// Settings › Profile (PLNR-194): the person's name and their own settings, the same in every workspace.
//
// The name lives in `user`, which every workspace's snapshot carries, so a new one is a User action in the log of each
// workspace the person is a member of: open tabs there redraw it at once, as they do a role change. The row and every
// workspace's action are one transaction (applyServerChangeIn): local copies catch up from the log, not from a snapshot,
// so a workspace left without its action would keep the old name for good. The address (email-change.ts) and the
// picture (picture.ts) change the same way, through changeOwnRow, and so does the creature drawn without a picture
// (PLNR-366): a short string the browser makes, which the server only checks the form of.
//
// Each such change is an action in every workspace of the person, sent to every open tab there, and none of them pays
// into the person's write budget (sync/limits.ts counts what clients send, not server changes). So changeOwnRow keeps
// its own budget, per person (PLNR-259): OWN_ROW_CHANGES a minute across name, creature and picture; past it 429 and
// nothing written. A change to what the row already holds costs nothing. The address is left out (email-change.ts):
// sign-in codes already allow it a few times an hour, and a refusal there would waste a used code or block taking back
// a stolen account.
//
// The time zone, the first day of the week, the color theme and the interface choice are in `account_settings`, which no snapshot carries:
// nobody else needs them, and the server will (quiet hours and digests are in the person's time).
import { ACCOUNT_DEFAULTS, DARK_THEMES, DENSITIES, isThemeChoice, LIGHT_THEMES, PANE_STYLES, PROJECT_PAGES, QUIET_CHOICES, START_PAGES, THEME_MODES, uiFrom, WEEK_STARTS, type AccountSettings, type WeekStart } from "@rsva/protocol";
import { CREATURE } from "@rsva/schema/models";
import { GROUPS, myWorkFolds, type GroupId } from "@rsva/protocol/my-work";
import { eq, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { db, schema, type Tx } from "../db.ts";
import { name } from "../http.ts";
import { applyServerChangeIn } from "../sync/write.ts";
import { Limiter, RateLimited } from "./limits.ts";

const { accountSettings, member, user } = schema;

/** The zone as this server's Intl spells it (`europe/sofia` → `Europe/Sofia`), or null if it does not know it. */
export function canonicalZone(tz: string): string | null {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export const accountPatch = z
  .object({
    name,
    avatar: z.string().regex(CREATURE).nullable(),
    timeZone: z
      .string()
      .max(64)
      .transform((tz, ctx) => canonicalZone(tz) ?? (ctx.addIssue({ code: "custom", message: "not a time zone" }), z.NEVER)),
    weekStart: z.union(WEEK_STARTS.map((d) => z.literal(d)) as [z.ZodLiteral<WeekStart>, ...z.ZodLiteral<WeekStart>[]]),
    theme: z.object({ mode: z.enum(THEME_MODES), light: z.enum(LIGHT_THEMES), dark: z.enum(DARK_THEMES) }).strict(),
    ui: z.object({ panes: z.enum(PANE_STYLES), density: z.enum(DENSITIES), start: z.enum(START_PAGES), project: z.enum(PROJECT_PAGES), quiet: z.union(QUIET_CHOICES.map((d) => z.literal(d))).optional() }).strict(),
    // The folded groups, whole: an id that is no group is refused, so the client learns of it.
    myWork: z
      .array(z.enum(GROUPS.map((g) => g.id) as [GroupId, ...GroupId[]]))
      .max(GROUPS.length)
      .transform((list) => myWorkFolds(list))
      .nullable(),
  })
  .partial()
  .strict();

export async function readSettings(userId: string): Promise<AccountSettings> {
  const [row] = await db
    .select({ timeZone: accountSettings.timeZone, weekStart: accountSettings.weekStart, theme: accountSettings.theme, ui: accountSettings.ui, myWork: accountSettings.myWork })
    .from(accountSettings)
    .where(eq(accountSettings.userId, userId));
  // A theme or a choice this server no longer has (one taken out) reads as none: the device keeps its own.
  return row
    ? { timeZone: row.timeZone, weekStart: row.weekStart as WeekStart, theme: isThemeChoice(row.theme) ? row.theme : null, ui: uiFrom(row.ui), myWork: row.myWork ? myWorkFolds(row.myWork) : null }
    : ACCOUNT_DEFAULTS;
}

export async function updateAccount(userId: string, patch: z.infer<typeof accountPatch>): Promise<AccountSettings> {
  const { name: newName, avatar, ...settings } = patch;
  // The row first: past its limit nothing of the patch is written.
  const own = { ...(newName !== undefined && { name: newName }), ...(avatar !== undefined && { avatar }) };
  if (Object.keys(own).length) await setOwn(userId, own);
  if (Object.keys(settings).length) {
    await db
      .insert(accountSettings)
      .values({ userId, ...settings })
      .onConflictDoUpdate({ target: accountSettings.userId, set: { ...settings, updatedAt: dsql`now()` } });
  }
  return readSettings(userId);
}

/** What changeOwnRow's `change` returns: the User action's new and previous values. */
export interface RowChange {
  d: Record<string, unknown>;
  p: Record<string, unknown>;
}

/** Changes of one's own row a person may make a minute: far more than anyone makes by hand. */
export const OWN_ROW_CHANGES = 30;
const ownRowChanges = new Limiter(OWN_ROW_CHANGES, 60_000);

function tooMany(userId: string): RateLimited {
  return new RateLimited(ownRowChanges.retryAfter(userId), "Too many changes to your profile. Try again in a minute.");
}

/**
 * A change of the person's own `user` row, as a User U action in the log of every workspace they are a member of, all
 * in one transaction. `change` locks the row and writes it first; it returns null when nothing changed. Then the
 * memberships are read: a join running now waits on that lock (addMember, FOR SHARE) and reads the new row.
 *
 * A change counts against the person's limit (`limited: false` leaves it out); past it, RateLimited and the
 * transaction rolls back. A spent limit is refused before the transaction starts.
 */
export async function changeOwnRow(userId: string, change: (tx: Tx) => Promise<RowChange | null>, { limited = true } = {}): Promise<void> {
  if (limited && ownRowChanges.exhausted(userId)) throw tooMany(userId);
  const workspaces = (await db.select({ id: member.workspaceId }).from(member).where(eq(member.userId, userId))).map((r) => r.id);
  let counted = false;
  await applyServerChangeIn(workspaces, userId, async (tx) => {
    const c = await change(tx);
    if (!c) return new Map();
    // Once, though a deadlock runs the transaction again.
    if (limited && !counted) {
      counted = true;
      if (!ownRowChanges.take(userId)) throw tooMany(userId);
    }
    const now = await tx.select({ id: member.workspaceId }).from(member).where(eq(member.userId, userId));
    return new Map(now.map((w) => [w.id, [{ m: "User", mid: userId, a: "U", ...c }]]));
  });
}

/** A new name, creature or both in every workspace of the person: one action, one change against the limit. */
async function setOwn(userId: string, to: Partial<Pick<typeof user.$inferSelect, "name" | "avatar">>): Promise<void> {
  await changeOwnRow(userId, async (tx) => {
    // NO KEY UPDATE leaves alone the inserts that only reference the person (comments, sessions) in every workspace.
    const [was] = await tx.select({ name: user.name, avatar: user.avatar }).from(user).where(eq(user.id, userId)).for("no key update");
    const fields = (Object.keys(to) as (keyof typeof to)[]).filter((f) => was![f] !== to[f]);
    if (!fields.length) return null;
    const d = Object.fromEntries(fields.map((f) => [f, to[f]]));
    await tx.update(user).set(d).where(eq(user.id, userId));
    return { d, p: Object.fromEntries(fields.map((f) => [f, was![f]])) };
  });
}
