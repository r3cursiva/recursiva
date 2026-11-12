// The GitHub integration from the server's shell: everything about it is set here, settings only show it.
//
//   node apps/server/src/cli/github.ts sync                       installations and repositories as GitHub lists them
//   node apps/server/src/cli/github.ts list
//   node apps/server/src/cli/github.ts bind <owner/repo> <ws> [--projects LAS,OPTO]
//   node apps/server/src/cli/github.ts unbind <owner/repo>
//   node apps/server/src/cli/github.ts on|off <owner/repo>        off: its webhooks are received and ignored
//   node apps/server/src/cli/github.ts backfill [--dry-run]       links imported from Plane become Pull requests rows
//
// A repository removed from the App, or whose installation was deleted, turns off and stays off until `on`.
import { parseArgs } from "node:util";
import { projectsByKey } from "@rsva/schema/models";
import { eq } from "drizzle-orm";
import { githubFromEnv } from "../github/api.ts";
import { backfillLinks, saveInstallation, saveRepo } from "../github/events.ts";
import { db, migrateDb, schema, sql } from "../db.ts";

const { positionals, values } = parseArgs({ allowPositionals: true, options: { projects: { type: "string" }, "dry-run": { type: "boolean" } } });
const [command, name, slug] = positionals;
const { githubInstallation, githubRepo, project, workspace } = schema;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function sync(): Promise<void> {
  const api = githubFromEnv();
  if (!api) fail("GITHUB_APP_ID and the private key are not set");
  for (const i of await api.installations()) {
    await saveInstallation(i);
    const repos = await api.repositories(i.id);
    for (const r of repos) await saveRepo(r, i.id);
    console.log(`${i.account}: ${repos.length} repositories`);
  }
}

async function repoNamed(full: string | undefined) {
  if (!full) fail("name the repository: owner/name");
  const [r] = await db.select().from(githubRepo).where(eq(githubRepo.fullName, full));
  return r ?? fail(`no repository ${full}: install the App on it, then run sync`);
}

await migrateDb();
switch (command) {
  case "sync":
    await sync();
    break;
  case "list": {
    const rows = await db
      .select({ repo: githubRepo, slug: workspace.slug, account: githubInstallation.account })
      .from(githubRepo)
      .leftJoin(workspace, eq(workspace.id, githubRepo.workspaceId))
      .leftJoin(githubInstallation, eq(githubInstallation.id, githubRepo.installationId))
      .orderBy(githubRepo.fullName);
    // Bound by id (PLNR-454): shown by the keys the projects have now.
    const keyOf = new Map((await db.select({ id: project.id, key: project.key }).from(project)).map((p) => [p.id, p.key]));
    const projects = (ids: string[]) => ids.map((id) => keyOf.get(id) ?? "(no project)").join(",") || "all projects";
    for (const r of rows) console.log([r.repo.fullName, r.slug ?? "(not bound)", r.repo.enabled ? "on" : "off", r.repo.defaultBranch, projects(r.repo.projectIds), r.account ?? "(no installation)"].join("\t"));
    break;
  }
  case "bind": {
    const r = await repoNamed(name);
    if (!slug) fail("name the workspace");
    const [w] = await db.select({ id: workspace.id }).from(workspace).where(eq(workspace.slug, slug));
    if (!w) fail(`no workspace ${slug}`);
    // A key, a former one too, names its project; the binding keeps the project through any later rename (PLNR-454).
    const byKey = projectsByKey(await db.select({ id: project.id, key: project.key, formerKeys: project.formerKeys }).from(project).where(eq(project.workspaceId, w.id)));
    const keys = values.projects?.split(",").map((k) => k.trim().toUpperCase()).filter(Boolean) ?? [];
    const unknown = keys.filter((k) => !byKey.has(k));
    if (unknown.length) fail(`no project ${unknown.join(", ")} in ${slug}`);
    const bound = [...new Set(keys.map((k) => byKey.get(k)!))];
    await db.update(githubRepo).set({ workspaceId: w.id, projectIds: bound.map((p) => p.id), enabled: true }).where(eq(githubRepo.id, r.id));
    console.log(`${r.fullName} → ${slug}${bound.length ? ` (${bound.map((p) => p.key).join(",")})` : ""}`);
    if (!bound.length) console.log("Every project of the workspace: the repository's collaborators can read issue titles in the bot's comment. Limit it with --projects.");
    break;
  }
  case "unbind": {
    const r = await repoNamed(name);
    await db.update(githubRepo).set({ workspaceId: null }).where(eq(githubRepo.id, r.id));
    break;
  }
  case "on":
  case "off": {
    const r = await repoNamed(name);
    await db.update(githubRepo).set({ enabled: command === "on" }).where(eq(githubRepo.id, r.id));
    break;
  }
  case "backfill": {
    const api = githubFromEnv();
    if (!api) fail("GITHUB_APP_ID and the private key are not set");
    const dryRun = values["dry-run"] ?? false;
    const lines = await backfillLinks(api, dryRun);
    for (const l of lines) console.log([l.result, l.key, l.ref, l.why ?? ""].join("\t"));
    const count = (result: string) => lines.filter((l) => l.result === result).length;
    console.log(`${dryRun ? "dry run: " : ""}${count("moved")} moved, ${count("kept")} kept, ${count("failed")} failed`);
    break;
  }
  default:
    fail("usage: github.ts sync | list | bind <owner/repo> <ws> [--projects A,B] | unbind <owner/repo> | on|off <owner/repo> | backfill [--dry-run]");
}
await sql.end();
