// Changes the server signs with a bot: GitHub's (github/events.ts) and the app's own (cycle rollover, sync/rollover.ts). A bot
// is a user in no workspace's members; the snapshot finds the ones a workspace's log names (bootstrap.ts).
import type { Bot } from "@rsva/schema/models";
import { and, eq } from "drizzle-orm";
import { db, schema, type Tx } from "../db.ts";
import type { Pending } from "./tx-error.ts";
import { applyServerChange, type TxResult } from "./write.ts";

const { user, syncAction } = schema;

/** The bot's user, made the first time a change is signed with it. */
async function botId(bot: Bot): Promise<string> {
  await db.insert(user).values({ email: bot.email, name: bot.name, kind: "bot" }).onConflictDoNothing();
  const [u] = await db.select({ id: user.id }).from(user).where(eq(user.email, bot.email));
  return u!.id;
}

/**
 * A change signed by the bot. The first one in a workspace also says who the bot is: it is nobody's member, so open clients
 * learn its name from this action and new ones from the snapshot, which looks for it in the log.
 */
export async function asBot(workspaceId: string, bot: Bot, write: (tx: Tx, botId: string) => Promise<Pending[]>): Promise<TxResult> {
  const id = await botId(bot);
  return applyServerChange(workspaceId, id, async (tx) => {
    const out = await write(tx, id);
    if (!out.length) return out;
    const [known] = await tx.select({ id: syncAction.id }).from(syncAction).where(and(eq(syncAction.modelId, id), eq(syncAction.workspaceId, workspaceId), eq(syncAction.model, "User"))).limit(1);
    if (known) return out;
    return [{ m: "User", mid: id, a: "I", d: { id, email: bot.email, name: bot.name, kind: "bot", role: null } }, ...out];
  });
}
