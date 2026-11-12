import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";
import type { Change, Counts, LiveState } from "./plan.ts";
import { release, rollback, status, type Host, type Options, type Ports, type Repo, type Site } from "./release.ts";

const SHA = "cccccccccdddddddddd";
const TAG = "ccccccccc";
const COMPOSE = "compose";
const counts: Counts = { issues: 10, projects: 2, comments: 5, lastAction: 100, migrations: 18 };
const plain: Change = { commits: ["One"], files: ["apps/web/a.ts"], migrations: [], schema: 18, protocol: null };
const withMigration: Change = { ...plain, migrations: [{ file: "0018_x.sql", risky: [] }], schema: 19 };
const defaults: Options = { dryRun: false, skipChecks: false, allowDiverged: false, allowDestructive: false };

/** The calls that change something, in order: the order is what these tests are about. */
let calls: string[];
let journal: string[];
let lines: string[];

beforeEach(() => {
  calls = [];
  journal = [];
  lines = [];
});

interface World {
  repo?: Partial<Repo>;
  host?: Partial<Host>;
  site?: Partial<Site>;
  confirm?: boolean;
  change?: Change | null;
}

const liveOf = (tag: string, previous: string | null = "bbbbbbbbb"): LiveState => ({ tag, previous, healthy: true });

function world(w: World = {}): Ports {
  const change = w.change === undefined ? plain : w.change;
  let running = "aaaaaaaaa";
  const repo: Repo = {
    fetchMain: async () => SHA,
    isAncestor: async () => true,
    fileAt: async () => COMPOSE,
    changes: async () => change,
    perfStatus: async () => "ok",
    build: async (_sha, _log, checks) => void calls.push(checks ? "build" : "build unchecked"),
    ...w.repo,
  };
  const host: Host = {
    status: async () => liveOf("aaaaaaaaa"),
    hasImage: async () => false,
    file: async () => COMPOSE,
    putFile: async (path) => void calls.push(`put ${path}`),
    lock: async () => {
      calls.push("lock");
      return { release: async () => void calls.push("unlock") };
    },
    dump: async () => {
      calls.push("dump");
      return "/d.dump";
    },
    counts: async () => (change?.migrations.length && calls.includes("switch") ? { ...counts, migrations: 19 } : counts),
    now: async () => "1000",
    switchTo: async (tag) => {
      calls.push("switch");
      running = tag;
      return true;
    },
    rollback: async () => {
      calls.push("rollback");
      return true;
    },
    runningImage: async () => `rsva:${running}`,
    bundle: async () => "index-a.js",
    errorsSince: async () => [],
    ...w.host,
  };
  const site: Site = { healthy: async () => true, bundle: async () => "index-a.js", brokenNeighbours: async () => [], ...w.site };
  return {
    repo,
    host,
    site,
    log: (l) => void lines.push(l),
    confirm: async () => w.confirm ?? true,
    journal: async (entry) => {
      journal.push(entry);
      return "journal written";
    },
    sleep: async () => {},
    today: () => new Date("2026-11-01T03:25:00Z"),
  };
}

const output = () => lines.join("\n");
const SHIPPED = ["lock", "build", "switch", "unlock"];

test("a release builds, switches, writes the journal and lets go of the lock", async () => {
  assert.equal(await release(world(), defaults), 0);
  assert.deepEqual(calls, SHIPPED);
  assert.match(journal[0] as string, /планировщик обновлён/);
});

test("the live tag already on main: nothing happens", async () => {
  const code = await release(world({ host: { status: async () => liveOf(TAG) } }), defaults);
  assert.equal(code, 0);
  assert.deepEqual(calls, []);
  assert.match(output(), /already live/);
});

test("a dry run shows the plan and changes nothing", async () => {
  assert.equal(await release(world(), { ...defaults, dryRun: true }), 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(journal, []);
  assert.match(output(), /Commits \(1\)/);
});

test("a dry run still reports blockers in its exit code", async () => {
  assert.equal(await release(world({ repo: { isAncestor: async () => false } }), { ...defaults, dryRun: true }), 1);
});

test("a blocker stops before the lock", async () => {
  assert.equal(await release(world({ host: { file: async () => "other" } }), defaults), 1);
  assert.deepEqual(calls, []);
});

/** Main changed compose.yaml since the live tag; the host has the live tag's copy, or `host` once it is put. */
function composeChanged(host = COMPOSE, w: World = {}): Ports {
  const files = new Map<string, string>();
  return world({
    ...w,
    repo: { fileAt: async (ref, path) => (ref === SHA && path.endsWith("compose.yaml") ? "new" : COMPOSE), ...w.repo },
    host: {
      file: async (path) => files.get(path) ?? host,
      putFile: async (path, content, expected, backup) => {
        calls.push(`put ${path} ${backup}`);
        assert.equal(expected, createHash("sha256").update(host).digest("hex"), "replaced only while it is what the plan saw");
        files.set(path, content);
      },
      ...w.host,
    },
  });
}

test("a host file changed on main since the live tag is put after the build and the dump, before the switch", async () => {
  assert.equal(await release(composeChanged(COMPOSE, { change: withMigration }), defaults), 0);
  assert.deepEqual(calls, ["lock", "build", "dump", "put /opt/rsva/compose.yaml /opt/rsva/compose.yaml.bak-20261101-ccccccccc", "switch", "unlock"]);
  assert.match(output(), /Note: deploy\/stand\/compose\.yaml changed since the live tag/);
  assert.match(journal[0] as string, /`\/opt\/rsva\/compose\.yaml` заменён на версию из репозитория, копия `\/opt\/rsva\/compose\.yaml\.bak-20261101-ccccccccc`/);
});

test("a dry run shows the file it would put and puts nothing", async () => {
  assert.equal(await release(composeChanged(), { ...defaults, dryRun: true }), 0);
  assert.deepEqual(calls, []);
  assert.match(output(), /the release puts it on the host[\s\S]*\+ new/);
});

test("a host file edited there by hand blocks: the release does not overwrite it", async () => {
  assert.equal(await release(composeChanged("edited on the host"), defaults), 1);
  assert.deepEqual(calls, []);
  assert.match(output(), /Blocked: deploy\/stand\/compose\.yaml on the host is neither/);
});

test("a host file that changed after the plan stops the release before the switch", async () => {
  const p = composeChanged(COMPOSE, { host: { putFile: async () => { throw new Error("changed on the host since the plan"); } } });
  await assert.rejects(release(p, defaults), /since the plan/);
  assert.deepEqual(calls, ["lock", "build", "unlock"]);
  assert.deepEqual(journal, []);
});

test("saying no stops before the lock", async () => {
  assert.equal(await release(world({ confirm: false }), defaults), 1);
  assert.deepEqual(calls, []);
});

test("--skip-checks builds without the checks", async () => {
  assert.equal(await release(world(), { ...defaults, skipChecks: true }), 0);
  assert.deepEqual(calls, ["lock", "build unchecked", "switch", "unlock"]);
});

test("another release holding the lock stops this one", async () => {
  assert.equal(await release(world({ host: { lock: async () => null } }), defaults), 1);
  assert.deepEqual(calls, []);
  assert.match(output(), /Another release/);
});

test("a live tag moved after the plan stops the release and frees the lock", async () => {
  const seen = [liveOf("aaaaaaaaa"), liveOf("eeeeeeeee")];
  let i = 0;
  assert.equal(await release(world({ host: { status: async () => seen[i++] as LiveState } }), defaults), 1);
  assert.deepEqual(calls, ["lock", "unlock"]);
});

test("an image already on the host is not built again", async () => {
  assert.equal(await release(world({ host: { hasImage: async () => true } }), defaults), 0);
  assert.deepEqual(calls, ["lock", "switch", "unlock"]);
});

test("a failed build leaves the live server alone and frees the lock", async () => {
  const failing = world({ repo: { build: async () => { throw new Error("no"); } } });
  await assert.rejects(release(failing, defaults), /no/);
  assert.deepEqual(calls, ["lock", "unlock"]);
  assert.deepEqual(journal, []);
});

test("migrations: the dump comes after the build and before the switch", async () => {
  assert.equal(await release(world({ change: withMigration }), defaults), 0);
  assert.deepEqual(calls, ["lock", "build", "dump", "switch", "unlock"]);
  assert.match(journal[0] as string, /дамп `\/d\.dump`/);
});

test("a server that does not start: rsva-deploy took it back, the journal says so", async () => {
  assert.equal(await release(world({ host: { switchTo: async () => false } }), defaults), 1);
  assert.deepEqual(calls, ["lock", "build", "unlock"]);
  assert.match(journal[0] as string, /не поднялась/);
});

test("a failed verification rolls back by itself when no migrations shipped", async () => {
  assert.equal(await release(world({ site: { bundle: async () => "index-old.js" } }), defaults), 1);
  assert.deepEqual(calls, ["lock", "build", "switch", "rollback", "unlock"]);
  assert.match(journal[0] as string, /откатилась на/);
  assert.match(output(), /index-old\.js/);
});

test("a failed verification with migrations is left for a person", async () => {
  const code = await release(world({ change: withMigration, site: { healthy: async () => false } }), defaults);
  assert.equal(code, 1);
  assert.deepEqual(calls, ["lock", "build", "dump", "switch", "unlock"]);
  assert.match(journal[0] as string, /откат не запускался/);
  assert.match(output(), /Not rolled back/);
});

test("a failed rollback is reported", async () => {
  const world_ = world({ site: { healthy: async () => false }, host: { rollback: async () => false } });
  assert.equal(await release(world_, defaults), 1);
  assert.match(journal[0] as string, /rollback to aaaaaaaaa failed too/);
});

test("a run of server errors fails the release, a single one only warns", async () => {
  assert.equal(await release(world({ host: { errorsSince: async () => ["e"] } }), defaults), 0);
  assert.match(output(), /Warning: 1 errors/);
  calls = [];
  assert.equal(await release(world({ host: { errorsSince: async () => ["e", "e", "e"] } }), defaults), 1);
  assert.ok(calls.includes("rollback"));
});

test("a broken neighbour warns and does not roll back", async () => {
  assert.equal(await release(world({ site: { brokenNeighbours: async () => ["https://x 502"] } }), defaults), 0);
  assert.ok(!calls.includes("rollback"));
  assert.match(journal[0] as string, /neighbour https:\/\/x 502/);
});

test("--rollback goes to the previous tag and warns about the schema", async () => {
  const ports = world({ change: withMigration, host: { runningImage: async () => "rsva:bbbbbbbbb", counts: async () => counts } });
  assert.equal(await rollback(ports, { dryRun: false }), 0);
  assert.deepEqual(calls, ["lock", "rollback", "unlock"]);
  assert.match(output(), /schema stays/);
  assert.match(journal[0] as string, /откатан `aaaaaaaaa` → `bbbbbbbbb`/);
});

test("--rollback --dry-run changes nothing, and no previous tag stops it", async () => {
  assert.equal(await rollback(world(), { dryRun: true }), 0);
  assert.deepEqual(calls, []);
  assert.equal(await rollback(world({ host: { status: async () => liveOf("aaaaaaaaa", null) } }), { dryRun: false }), 1);
  assert.deepEqual(calls, []);
});

test("--status says how far main is ahead", async () => {
  assert.equal(await status(world()), 0);
  assert.match(output(), /1 commits ahead, 0 migrations$/m);
  assert.equal(await status(world({ host: { status: async () => ({ ...liveOf("aaaaaaaaa"), healthy: false }) } })), 1);
});
