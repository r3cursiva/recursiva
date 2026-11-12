// `rsva tui`: see apps/tui/src/app.ts and docs/research/agent-dispatch-tui-2026-11-05.md. The TUI is the owner's
// console: it goes as the person. First the terminal's session (`rsva login`, PLNR-323), which opens every workspace
// they are in and switches between them from the palette; else their own token (Keychain service RSVA_OWN_KEYCHAIN,
// default "rsva-own"), one workspace; else the agents' token ("rsva-bot"), and the head says so. Todo and Approved are
// refused to an agent. RSVA_SESSION, RSVA_TOKEN and RSVA_KEYCHAIN choose one, as they do for the CLI.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AGENT_SERVICE, ApiError, Client, failure, NetworkError, UsageError } from "@rsva/terminal/client";
import { credentialFolder } from "@rsva/terminal/copies";
import { open } from "@rsva/terminal/open";
import { plain } from "@rsva/terminal/text";
import { runTui } from "./app.ts";
import { agentsCommand, dispatchCommand } from "./commands.ts";
import { fileDisks } from "./disk.ts";
import { remembered } from "./state.ts";
import type { WorkspaceListItem } from "@rsva/protocol";

const OWN = process.env.RSVA_OWN_KEYCHAIN || "rsva-own";
/** How long the start waits for the server to say whether the Keychain's session lives: slower, it is taken as it is. */
const PROBE_MS = 2_000;

/**
 * The first credential there is: one set or named explicitly is used as is. The Keychain's session is asked of the
 * server first (its workspaces, which the start needs anyway): one the server ended (Settings › Security, or by time)
 * falls through to the tokens instead of opening a screen that only says so. Offline, slow (PROBE_MS) or with any other
 * refusal (busy, limited), it is taken as it is: the screen opens from the copy, as it does without a server.
 */
async function credential(): Promise<{ api: Client; workspaces?: WorkspaceListItem[] }> {
  const env = process.env;
  const explicit = env.RSVA_SESSION ? new Client(env, { session: true }) : env.RSVA_TOKEN || env.RSVA_KEYCHAIN ? new Client(env) : null;
  const tried = explicit ? [explicit] : [new Client(env, { session: true }), new Client({ ...env, RSVA_KEYCHAIN: OWN }), new Client({ ...env, RSVA_KEYCHAIN: AGENT_SERVICE })];
  for (const api of tried) {
    try {
      // The credential first: a missing one is said before the screen is taken.
      await api.authorization();
      if (!explicit && api.session) {
        const probe = api.workspaces();
        // An answer after PROBE_MS goes unread.
        probe.catch(() => undefined);
        try {
          const workspaces = await Promise.race([probe, sleep(PROBE_MS, undefined, { ref: false })]);
          return workspaces ? { api, workspaces } : { api };
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) continue;
          if (!(e instanceof ApiError || e instanceof NetworkError)) throw e;
        }
      }
      return { api };
    } catch (e) {
      if (explicit || !(e instanceof UsageError) || api === tried.at(-1)) throw e;
    }
  }
  throw new UsageError("no credential: rsva login");
}

/** The folder of a credential's copies, named by its hash: a copy per person, as a browser keeps one. */
async function folderOf(api: Client): Promise<string> {
  // The owner's and an agent's copies of a workspace differ (My work, the inbox), and the engine refuses a copy saved by
  // someone else. The folder is named by the credential's hash, not the credential (copies.ts; rsva logout removes it).
  const folder = credentialFolder(await api.authorization());
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return folder;
}

/** No server to say which workspace: offline, the copy opens only with RSVA_WS. */
const offline = (e: unknown): never => {
  throw e instanceof NetworkError ? new UsageError(`${e.message}: offline, the workspace is not known; set RSVA_WS to start from the copy`) : e;
};

/**
 * The credential in its workspace: RSVA_WS; for a session, the one the TUI was last in while it still opens it, else the
 * first it opens; for a token, its own, which only the server knows.
 */
async function client(): Promise<Client> {
  const { api, workspaces } = await credential();
  if (api.session && !process.env.RSVA_WS) {
    const last = remembered(join(await folderOf(api), "tui.json")).workspace;
    // The list, when the server gave one, also says whether the person is still in the last workspace.
    if (last && (!workspaces || workspaces.some((w) => w.slug === last))) return api.in(last);
    const list = workspaces ?? (await api.workspaces().catch(offline));
    if (!list.length) throw new UsageError("you are in no workspace yet");
    return api.in(list[0]!.slug);
  }
  await api.workspaceSlug().catch(offline);
  return api;
}

const [command, ...rest] = process.argv.slice(2);
const out = (s: string) => process.stdout.write(`${s}\n`);
if (!command && (!process.stdout.isTTY || !process.stdin.isTTY)) {
  process.stderr.write("rsva tui: needs a terminal\n");
  process.exit(2);
}
try {
  if (command === "agents") await agentsCommand(out);
  else if (command === "dispatch") await dispatchCommand(await client(), rest, out);
  else if (command) throw new UsageError(`no command ${command}: dispatch, agents, or none for the screen`);
  else await screen();
} catch (e) {
  // As the CLI says it (failure); anything else by its message too, with 1: the person sees the screen's end, not a stack.
  const f = failure(e) ?? { code: 1, text: plain((e as Error).message) };
  process.stderr.write(`rsva tui: ${f.text}\n`);
  process.exitCode = f.code;
}

async function screen() {
  let api = await client();
  const folder = await folderOf(api);
  const reports: string[] = [];
  // Each workspace is a run of its own, from its own copy; one chosen in the palette opens next. A workspace that went
  // away (removed from it) is the server's to say: the run shows it as it does any refusal.
  let since: number | undefined;
  for (;;) {
    const end = await runTui(api, { env: process.env, disk: process.env.RSVA_TUI_NO_DISK ? null : fileDisks(folder), state: join(folder, "tui.json"), open, workspaces: () => api.workspaces(), ...(since === undefined ? {} : { since }) });
    reports.push(end.next || reports.length ? `${api.workspace}${since === undefined ? "" : " (from the switch)"}:\n${end.report}` : end.report);
    if (!end.next) break;
    since = performance.now();
    api = api.in(end.next);
  }
  process.stdout.write(`${reports.join("\n")}\n`);
}
