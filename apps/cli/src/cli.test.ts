import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer, type Server } from "node:http";
import { brotliCompressSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { DATE_PRESETS, formatValue, ORDER_BY_OPTIONS, ORDER_KEYS, ORDER_WORDS as QUERY_ORDER_WORDS, parseQuery, PRIORITY_KEYWORDS, QUERY_KEYS, type QueryContext } from "@rsva/query";
import { run, type Io } from "./commands.ts";
import * as schema from "@rsva/schema/models";
import { ORDER_WORDS, PRIORITY_WORDS, QUERY_VALUES, QUERY_WORDS, RELATION_WORDS } from "./completion.ts";
import { cut } from "./style.ts";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  /** JSON as sent; a file's bytes as they came. */
  body: unknown;
  type: string | undefined;
}

const seen: Seen[] = [];
/** The Accept-Encoding of the last request. */
let acceptEncoding: string | undefined;
/** An answer of the fake server: the first one whose `path` the request's address contains, or the first without a path. */
interface Answer {
  status?: number;
  body?: unknown;
  raw?: Buffer;
  headers?: Record<string, string>;
  path?: string;
}
let answers: Answer[] = [];
let server: Server;
let url: string;

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const data = Buffer.concat(chunks);
      const type = req.headers["content-type"];
      const body = !data.length ? undefined : type === "application/json" ? JSON.parse(data.toString()) : data;
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body, type });
      acceptEncoding = req.headers["accept-encoding"];
      const i = answers.findIndex((x) => !x.path || req.url!.includes(x.path));
      const a: Answer = i < 0 ? {} : answers.splice(i, 1)[0]!;
      res.writeHead(a.status ?? 200, { "content-type": "application/json", ...a.headers });
      res.end(a.raw ?? (a.body === undefined ? "" : JSON.stringify(a.body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  seen.length = 0;
  answers = [];
});

const cli = async (argv: string[], stdin = "", io: Partial<Io> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    stdin: async () => stdin,
    ...io,
    env: { RSVA_URL: url, RSVA_WS: "acme", RSVA_TOKEN: "rsva_secret", ...io.env },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
};
/** A comment's id as the server makes them, ending in `n`. */
const commentId = (n: number) => `0192a1b2-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
/** A page of an issue's comments, for `show`: it asks for them alongside the issue. */
const page = (comments: unknown[] = [], older: string | null = null): Answer => ({ path: "/comments", body: { comments, older } });
/** `show`'s card without the comments under it, in plain text or as a person sees it. */
const card = (out: string) => out.split(/\n\n(?:comments:|Comments)\n\n/)[0]!;
/** A person's clock to the minute, as the CLI shows it in colour. */
const localMinute = (at: string) => new Date(at).toLocaleString("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const row = { key: "CORE-1", title: "First", state: "In Review", priority: "high", labels: ["bug"], assignees: [], delegate: null, parent: null, cycle: "Sprint", startDate: null, dueDate: null };

test("issues: the query goes as q, the answer as columns, a cut list says so; --json is the answer as it came", async () => {
  answers = [{ body: { total: 7, issues: [row, { ...row, key: "CORE-12", state: "Todo", priority: "none", labels: [], cycle: null }] } }];
  const r = await cli(["issues", "state:Todo", "bug", "-p", "CORE", "--limit", "2"]);
  assert.equal(r.code, 0);
  assert.deepEqual(seen[0], { method: "GET", url: "/api/v1/workspaces/acme/issues?project=CORE&q=state%3ATodo+bug&limit=2", auth: "Bearer rsva_secret", body: undefined, type: undefined });
  assert.equal(r.out, "CORE-1   In Review  high  Sprint  First [bug]\nCORE-12  Todo                     First\n2 of 7");
  answers = [{ body: { total: 0, issues: [] } }];
  assert.deepEqual(JSON.parse((await cli(["issues", "--json"])).out), { total: 0, issues: [] });
});

test("create and update send names; none clears a field, - reads stdin, a lower-case key is fine", async () => {
  answers = [{ status: 201, body: { ok: true, key: "CORE-9" } }, { body: { ok: true } }];
  assert.equal((await cli(["create", "A title", "-p", "CORE", "-s", "Todo", "--label", "bug", "--label", "ui", "-d", "-"], "From stdin\n")).out, "CORE-9");
  assert.deepEqual(seen[0]!.body, { state: "Todo", labels: ["bug", "ui"], description: "From stdin", project: "CORE", title: "A title" });
  assert.equal((await cli(["update", "core-9", "--cycle", "none", "--priority", "low"])).out, "updated CORE-9");
  assert.deepEqual([seen[1]!.url, seen[1]!.body], ["/api/v1/workspaces/acme/issues/CORE-9", { priority: "low", cycle: null }]);
});

test("move: many keys to one project in one call, sub-issues on request; update -p moves one, RSVA_PROJECT does not (PLNR-448)", async () => {
  answers = [{ body: { ok: true, moved: [{ key: "SITE-1", was: "CORE-3" }, { key: "SITE-2", was: "CORE-4" }] } }];
  assert.equal((await cli(["move", "core-3", "CORE-4", "--to", "site", "--sub-issues"])).out, "CORE-3 → SITE-1\nCORE-4 → SITE-2");
  assert.deepEqual([seen[0]!.method, seen[0]!.url, seen[0]!.body], ["POST", "/api/v1/workspaces/acme/issues/move", { issues: ["CORE-3", "CORE-4"], project: "site", subIssues: true }]);
  answers = [{ body: { ok: true, moved: [] } }];
  assert.equal((await cli(["move", "SITE-1", "--to", "site"])).out, "nothing to move: already in SITE");
  assert.equal((await cli(["move", "CORE-1"])).code, 2, "--to is required");

  answers = [{ body: { ok: true, key: "SITE-3", was: "CORE-5" } }];
  assert.equal((await cli(["update", "CORE-5", "-p", "SITE", "-s", "Done"])).out, "moved CORE-5 to SITE-3");
  assert.deepEqual(seen.at(-1)!.body, { state: "Done", project: "SITE" });
  answers = [{ body: { ok: true } }];
  await cli(["update", "CORE-5", "--priority", "low"], "", { env: { RSVA_PROJECT: "SITE" } });
  assert.deepEqual(seen.at(-1)!.body, { priority: "low" });
});

test("update many: several keys or --add-/--remove- go in one PATCH of the list, -p is refused (RSVA-303)", async () => {
  answers = [{ body: { ok: true, changed: 2 } }];
  assert.equal((await cli(["update", "core-1", "CORE-2", "-s", "Done", "--add-label", "bug", "--remove-label", "ui", "--add-assignee", "me", "--remove-assignee", "a@x.dev"])).out, "updated 2 issues");
  assert.deepEqual([seen[0]!.method, seen[0]!.url, seen[0]!.body], [
    "PATCH",
    "/api/v1/workspaces/acme/issues",
    { keys: ["CORE-1", "CORE-2"], state: "Done", addLabels: ["bug"], removeLabels: ["ui"], addAssignees: ["me"], removeAssignees: ["a@x.dev"] },
  ]);
  answers = [{ body: { ok: true, changed: 0 } }];
  assert.equal((await cli(["update", "CORE-1", "--add-label", "bug"])).out, "nothing to change: the issues have it already");
  assert.deepEqual(seen[1]!.body, { keys: ["CORE-1"], addLabels: ["bug"] });
  assert.equal((await cli(["update", "CORE-1", "CORE-2", "-p", "SITE"])).code, 2);
  assert.equal((await cli(["update", "CORE-1", "CORE-2"])).code, 2, "nothing to change");
  assert.equal(seen.length, 2);
});

test("create: stdout is the key, the similar issues go to stderr; --force is sent as force: true (PLNR-295)", async () => {
  const similar = [{ key: "CORE-3", title: "Fix the login redirect", state: "Todo", score: 0.71 }, { key: "CORE-4", title: "Redirect after\nlogin", state: "Backlog", score: 0.4 }];
  answers = [{ status: 201, body: { ok: true, key: "CORE-9", similar } }];
  const r = await cli(["create", "Fix login redirect", "-p", "CORE"]);
  assert.deepEqual([r.code, r.out, r.err], [0, "CORE-9", "similar: CORE-3  Fix the login redirect  (0.71)\nsimilar: CORE-4  Redirect after login  (0.40)"]);
  assert.equal("force" in (seen[0]!.body as object), false, "force is sent only when asked");

  answers = [{ status: 201, body: { ok: true, key: "CORE-10", similar: [] } }];
  assert.deepEqual(await cli(["create", "Unrelated", "-p", "CORE"]), { code: 0, out: "CORE-10", err: "" });

  answers = [{ status: 201, body: { ok: true, key: "CORE-11" } }];
  assert.equal((await cli(["create", "Against an older server", "-p", "CORE"])).err, "", "no similar field, nothing to print");

  answers = [{ status: 201, body: { ok: true, key: "CORE-12", similar } }];
  const json = await cli(["create", "Fix login redirect", "-p", "CORE", "--json"]);
  assert.deepEqual([json.err, JSON.parse(json.out).similar.length], ["", 2], "--json carries them in the answer");

  answers = [{ status: 201, body: { ok: true, key: "CORE-13", similar } }];
  await cli(["create", "Fix login redirect", "-p", "CORE", "--force"]);
  assert.equal((seen.at(-1)!.body as { force?: boolean }).force, true);
});

test("create: a strong match is a refusal that names the issues and the way around it; exit 1, nothing on stdout", async () => {
  const similar = [{ key: "CORE-3", title: "Fix the login redirect", state: "Todo", score: 0.91 }];
  answers = [{ status: 409, body: { error: "similar", message: 'looks like CORE-3 "Fix the login redirect" (0.91); send force: true to create it anyway', similar } }];
  const r = await cli(["create", "Fix the login redirect!", "-p", "CORE"]);
  assert.deepEqual(r, { code: 1, out: "", err: "rsva: not created: it looks like an open issue\nsimilar: CORE-3  Fix the login redirect  (0.91)\nRerun with --force to create it anyway." });
  // Any other 409 is the server's own words.
  answers = [{ status: 409, body: { error: "conflict", message: "the key is taken" } }];
  assert.deepEqual(await cli(["create", "x", "-p", "CORE"]), { code: 1, out: "", err: "rsva: the key is taken" });
  assert.match((await cli(["help", "create"])).out, /\[--force\]/);
  assert.match((await cli(["completion", "zsh"])).out, /--force/);
});

test("show and comments read as text", async () => {
  answers = [
    page([{ id: commentId(0xc0f2), author: "owner@x.dev", body: "Drop the second criterion", createdAt: "2026-10-31 09:00:00+00" }], "2026-10-30"),
    {
      body: {
        ...row,
        createdBy: "bot@x.dev",
        description: "Body",
        relations: { blockedBy: ["CORE-2"], blocks: [], related: [], duplicateOf: null, duplicates: [] },
        links: [{ url: "https://x.dev/1", title: "" }],
        files: [],
      },
    },
    { body: { comments: [{ id: commentId(0xc0f1), author: "bot@x.dev", body: "Hi", createdAt: "2026-10-30 02:07:52+00" }], older: null } },
  ];
  answers[1]!.body = { ...(answers[1]!.body as object), startDate: "2026-11-02", dueDate: "2026-11-09" };
  assert.equal(
    (await cli(["show", "CORE-1"])).out,
    "CORE-1  First\nIn Review · high · Sprint\nlabels: bug\nstart: 2026-11-02\ndue: 2026-11-09\ncreated by: bot@x.dev\nblocked by: CORE-2\nlink: https://x.dev/1\n\nBody\n\n" +
      "comments:\n\nowner@x.dev, 2026-10-31 09:00 · 00c0f2\n  Drop the second criterion\n\nolder: rsva comments CORE-1 --until '2026-10-30'",
    "the comments come with the issue: one there can change what the description asks",
  );
  assert.equal((await cli(["comments", "CORE-1"])).out, "bot@x.dev, 2026-10-30 02:07 · 00c0f1\n  Hi");
  answers = [{ body: { comments: [], older: "2026-10-30" } }];
  assert.equal((await cli(["comments", "CORE-1"])).out, "no comments\n\nolder: rsva comments CORE-1 --until '2026-10-30'");
  answers = [page([], "2026-10-30"), described("")];
  const json = JSON.parse((await cli(["show", "CORE-1", "--json"])).out) as Record<string, unknown>;
  assert.deepEqual([json.key, json.comments, json.olderComments], ["CORE-1", [], "2026-10-30"], "--json has the comments too");
});

test("cycles: list, create, a name in the path, complete with where the open issues go", async () => {
  const cycle = { name: "Sprint one", short: "C1", status: "active", startDate: "2026-11-02", endDate: "2026-11-08", description: "The goal", lead: null, issues: 4, done: 1, open: 3 };
  answers = [{ body: [cycle, { ...cycle, name: "Later", short: "C2", status: "draft", startDate: null, endDate: null, issues: 0, done: 0 }] }];
  assert.equal((await cli(["cycles", "-p", "CORE"])).out, "C1  active  2026-11-02 – 2026-11-08  1/4 done  Sprint one\nC2  draft   no dates                 0/0 done  Later");
  answers = [{ status: 201, body: { ok: true, short: "C3", name: "Next" } }];
  assert.equal((await cli(["cycle", "create", "Next", "-p", "CORE", "--start", "2026-11-09", "--end", "2026-11-15"])).out, "C3  Next");
  assert.deepEqual(seen.at(-1)!.body, { startDate: "2026-11-09", endDate: "2026-11-15", project: "CORE", name: "Next" });
  answers = [
    { path: "/cycles/", body: cycle },
    { path: "/issues", body: { total: 1, issues: [row] } },
  ];
  const shown = await cli(["cycle", "show", "Sprint one", "-p", "CORE"]);
  assert.ok(seen.some((s) => s.url === "/api/v1/workspaces/acme/cycles/Sprint%20one?project=CORE"));
  assert.match(seen.at(-1)!.url, /q=cycle%3AC1/);
  assert.match(shown.out, /^C1 {2}Sprint one\nactive · 2026-11-02 – 2026-11-08 · 1\/4 done · 3 open\nThe goal\n\nCORE-1 /);
  assert.equal((await cli(["cycle", "complete", "C1", "-p", "CORE"])).code, 2, "where the open issues go is required");
  answers = [{ body: { ok: true, moved: 2, kept: 1 } }];
  assert.equal((await cli(["cycle", "complete", "C1", "-p", "CORE", "--move-to", "none", "--keep", "core-1"])).out, "completed C1: 2 moved, 1 kept");
  assert.deepEqual([seen.at(-1)!.url, seen.at(-1)!.body], ["/api/v1/workspaces/acme/cycles/C1/complete?project=CORE", { moveTo: null, keep: ["CORE-1"] }]);
});

test("mistakes: the server's words and exit 1, a bad call exit 2, nothing is sent", async () => {
  answers = [{ status: 400, body: { error: "invalid_query", message: "no state Progres", errors: [{ suggestions: ["state:Progress"] }] } }];
  assert.deepEqual(await cli(["issues", "state:Progres"]), { code: 1, out: "", err: "rsva: no state Progres\ntry: state:Progress" });
  answers = [page(), { status: 429, body: { error: "rate_limited", message: "too many changes" }, headers: { "retry-after": "7" } }];
  assert.equal((await cli(["show", "CORE-1"])).err, "rsva: too many changes (retry after 7 s)");
  seen.length = 0;
  assert.equal((await cli(["show"])).code, 2);
  assert.equal((await cli(["nope"])).code, 2);
  assert.equal((await cli(["issues", "--nope"])).code, 2);
  assert.equal((await cli(["show", "CORE-1", "--due"])).code, 2, "another command's flag");
  assert.equal((await cli(["issues", "-s", "Todo"])).code, 2, "a filter that would be dropped is refused, not ignored");
  assert.equal((await cli(["cycle", "update", "C1", "--title", "x", "-p", "CORE"])).code, 2);
  assert.equal((await cli(["create", "Fix", "the", "bug", "-p", "CORE"])).code, 2, "a title without quotes is not cut to its first word");
  assert.equal((await cli(["comment", "CORE-1", "hello", "world"])).code, 2);
  assert.equal((await cli(["update", "CORE-1", "--title"])).code, 2, "a flag without a value");
  for (const typo of [["issues", "-s=Todo"], ["issues", "--State=Todo"], ["issues", "--Limit", "5"], ["issues", "--limit2"], ["create", "--Title", "-p", "CORE"], ["comment", "CORE-1", "--Foo"]])
    assert.equal((await cli(typo)).code, 2, `${typo.join(" ")}: a typo is not text`);
  for (const name of ["constructor", "__proto__", "toString"]) {
    assert.equal((await cli([name])).code, 2, name);
    assert.equal((await cli(["cycle", name])).code, 2, `cycle ${name}`);
  }
  assert.match((await cli(["cycle", "--help"])).out, /cycle complete/);
  assert.equal((await cli(["cycles"])).code, 2, "cycles need a project");
  assert.equal(seen.length, 0);
  assert.match((await cli([])).out, /cycle complete <cycle> --move-to/);
});

test("a word with a dash is an argument: the query's negation, a list item in a comment, a value after a flag", async () => {
  answers = [{ body: { total: 0, issues: [] } }, { body: { total: 0, issues: [] } }, { status: 201, body: { ok: true } }, { status: 201, body: { ok: true } }, { body: { ok: true } }];
  await cli(["issues", "label:bug", "-label:security", "-state:Done", "-p", "CORE"]);
  assert.equal(new URL(seen[0]!.url, url).searchParams.get("q"), "label:bug -label:security -state:Done");
  assert.equal(new URL(seen[0]!.url, url).searchParams.get("project"), "CORE");
  await cli(["issues", "-priority:urgent"]);
  assert.equal(new URL(seen[1]!.url, url).searchParams.get("project"), null, "not -p riority:urgent");
  await cli(["comment", "CORE-1", "- item"]);
  await cli(["comment", "CORE-1", "--", "-x"]);
  assert.deepEqual([seen[2]!.body, seen[3]!.body], [{ body: "- item" }, { body: "-x" }]);
  await cli(["update", "CORE-1", "-d", "-5 degrees", "--title=a=b", "--label", "none", "--assignee", "none", "-s=Done", "--start", "2026-11-02", "--due", "none"]);
  assert.deepEqual(seen[4]!.body, { title: "a=b", state: "Done", labels: [], assignees: [], startDate: "2026-11-02", dueDate: null, description: "-5 degrees" });
});

test("every write: the method, the path and the body", async () => {
  const issue = "/api/v1/workspaces/acme/issues/CORE-1";
  const cycle = "/api/v1/workspaces/acme/cycles/C1";
  const cases: [string[], string, string, unknown][] = [
    [["archive", "CORE-1"], "PATCH", issue, { archived: true }],
    [["delete", "CORE-1"], "DELETE", issue, undefined],
    [["restore", "CORE-1"], "PATCH", issue, { deleted: false }],
    [["comment", "CORE-1", "Hi"], "POST", `${issue}/comments`, { body: "Hi" }],
    [["link", "CORE-1", "https://x.dev", "--title", "A"], "POST", `${issue}/links`, { url: "https://x.dev", title: "A" }],
    [["relate", "CORE-1", "blocks", "core-2"], "POST", `${issue}/relations`, { type: "blocks", issue: "CORE-2" }],
    [["unrelate", "CORE-1", "core-2"], "DELETE", `${issue}/relations/CORE-2`, undefined],
    [["cycle", "update", "C1", "-p", "CORE", "--name", "N", "--start", "none", "--end", "none", "--lead", "me", "-d", "none"], "PATCH", `${cycle}?project=CORE`, { name: "N", startDate: null, endDate: null, lead: "me", description: "" }],
    [["cycle", "delete", "C1", "-p", "CORE"], "DELETE", `${cycle}?project=CORE`, undefined],
  ];
  for (const [argv, method, path, body] of cases) {
    answers = [{ body: { ok: true, moved: 0 } }];
    const r = await cli(argv);
    assert.equal(r.code, 0, `${argv.join(" ")}: ${r.err}`);
    assert.deepEqual([seen.at(-1)!.method, seen.at(-1)!.url, seen.at(-1)!.body], [method, path, body]);
  }
});

test("show lists the branch, pull requests and commits when the server sends them", async () => {
  answers = [
    page(),
    {
      body: {
        ...row,
        createdBy: null,
        description: "",
        relations: { blockedBy: [], blocks: [], related: [], duplicateOf: null, duplicates: [] },
        links: [],
        files: [],
        branch: "core-1-first",
        pullRequests: [{ repo: "o/r", number: 12, title: "Fix", state: "open", head: "core-1-first", base: "main", review: "approved", checks: "pass", url: "https://github.com/o/r/pull/12", closing: true }, { repo: "o/r", number: 11, title: "Old", state: "merged", head: "core-1-old", base: "main", review: "approved", checks: "pass", url: "https://github.com/o/r/pull/11", closing: true }],
        commits: [{ repo: "o/r", sha: "a4c19e2f00", title: "Refs CORE-1", url: "https://github.com/o/r/commit/a4c19e2f00", closing: false }],
      },
    },
  ];
  const { out } = await cli(["show", "CORE-1"]);
  assert.ok(out.includes("branch: core-1-first\npr: o/r#12 open core-1-first → main review approved checks pass Fix\npr: o/r#11 merged core-1-old → main Old\ncommit: o/r@a4c19e2 (linked) Refs CORE-1"), out);
});

test("--json of cycle show keeps both answers whole", async () => {
  const cycle = { name: "S", short: "C1", status: "active", startDate: null, endDate: null, description: "", lead: null, issues: 1, done: 0, open: 1 };
  answers = [
    { path: "/cycles/", body: cycle },
    { path: "/issues", body: { total: 900, issues: [row] } },
  ];
  assert.deepEqual(JSON.parse((await cli(["cycle", "show", "C1", "-p", "CORE", "--json"])).out), { cycle, issues: { total: 900, issues: [row] } });
});

test("what others wrote cannot drive the terminal or fake a row", async () => {
  const evil = "\u001b]0;pwned\u0007Text\u009b31m \u202E\u061Cgnp.exe\r";
  answers = [{ body: { total: 1, issues: [{ ...row, title: `One\nCORE-9  Done  fake`, cycle: null, labels: [] }] } }, { body: { comments: [{ id: commentId(1), author: null, body: evil, createdAt: "2026-10-30 02:07" }], older: null } }, { body: { comments: [{ id: commentId(1), author: null, body: evil, createdAt: "x" }] } }];
  assert.equal((await cli(["issues"])).out, "CORE-1  In Review  high    One CORE-9 Done fake\n1 issue");
  const text = (await cli(["comments", "CORE-1"])).out;
  assert.equal(text.split("\n")[1], "  ]0;pwnedText31m gnp.exe");
  const json = (await cli(["comments", "CORE-1", "--json"])).out;
  assert.doesNotMatch(json, /[\u001b\u0007\u009b\u202e\u061c\r]/);
  assert.equal((JSON.parse(json) as { comments: { body: string }[] }).comments[0]!.body, evil, "--json keeps the data");
  answers = [page(), { status: 400, body: { message: "no \u001b[2Jstate" } }];
  assert.equal((await cli(["show", "CORE-1"])).err, "rsva: no [2Jstate");
});

test("an answer that is not the server's, a token no header can carry, a closed port", async () => {
  const html = createServer((_, res) => res.writeHead(502).end("<html>Bad gateway</html>"));
  await new Promise<void>((resolve) => html.listen(0, "127.0.0.1", resolve));
  const at = (port: number, token = "rsva_secret") => ({ env: { RSVA_URL: `http://127.0.0.1:${port}`, RSVA_TOKEN: token }, out: () => {}, err: (s: string) => errors.push(s), stdin: async () => "" });
  const errors: string[] = [];
  const port = (html.address() as AddressInfo).port;
  assert.equal(await run(["show", "CORE-1"], at(port)), 1);
  assert.match(errors.at(-1)!, /^rsva: 502 Bad Gateway: the answer is not JSON$/);
  assert.equal(await run(["show", "CORE-1"], at(port, "rsva_SEC\nRET")), 2);
  assert.doesNotMatch(errors.at(-1)!, /rsva_|SEC/);
  await new Promise((resolve) => html.close(resolve));
  assert.equal(await run(["show", "CORE-1"], at(port)), 1);
  assert.match(errors.at(-1)!, /^rsva: fetch failed: ECONNREFUSED$/);
});

test("no redirect is followed: the body does not go past the https check", async () => {
  const elsewhere: string[] = [];
  const target = createServer((req, res) => {
    elsewhere.push(req.url!);
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const to = `http://127.0.0.1:${(target.address() as AddressInfo).port}/x`;
  for (const status of [301, 307]) {
    answers = [{ status, headers: { location: to } }];
    const r = await cli(["comment", "CORE-1", "Secret"]);
    assert.equal(r.code, 1, `${status}: ${r.err}`);
    assert.equal(r.out, "", "and it does not say the comment was made");
  }
  assert.deepEqual(elsewhere, []);
  await new Promise((resolve) => target.close(resolve));
});

test("the token goes only to https or this machine", async () => {
  const err: string[] = [];
  const code = await run(["issues"], { env: { RSVA_URL: "http://plan.example.com", RSVA_TOKEN: "rsva_secret" }, out: () => {}, err: (s) => err.push(s), stdin: async () => "" });
  assert.equal(code, 2);
  assert.match(err[0]!, /https only/);
  assert.equal(seen.length, 0);
  assert.equal(await run(["issues"], { env: { RSVA_URL: "not a url", RSVA_TOKEN: "rsva_secret" }, out: () => {}, err: (s) => err.push(s), stdin: async () => "" }), 2);
  assert.match(err[1]!, /RSVA_URL: not a URL/);
});

// A person at a terminal (style.ts). Control characters are built with fromCharCode: the bytes are the point here.
const E = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI = String.fromCharCode(0x9b);
const RLO = String.fromCharCode(0x202e);
/** What a person sees: the text without our colour and links. */
const seenText = (s: string) => s.replace(new RegExp(`${E}\\]8;;[^${E}]*${E}\\\\`, "g"), "").replace(new RegExp(`${E}\\[[0-9;]*m`, "g"), "");
const person: Partial<Io> = { terminal: { columns: 60, rows: 100 }, errTerminal: true };
const three = {
  total: 3,
  issues: [
    { ...row, stateGroup: "started", title: "A title long enough to be cut at the window edge" },
    { ...row, key: "CORE-2", state: "Done", stateGroup: "completed", priority: "none", cycle: null, labels: [], title: "Second" },
    { ...row, key: "CORE-3", state: "Backlog", stateGroup: "backlog", priority: "urgent", labels: [] },
  ],
};

test("a person at a terminal: the list by state in the app's order, cut to the window, keys that open the issue", async () => {
  answers = [{ body: three }];
  const r = await cli(["issues"], "", person);
  assert.equal(
    seenText(r.out),
    [
      "◌ Backlog 1",
      "  CORE-3  urgent  Sprint  First",
      "",
      "◐ In Review 1",
      "  CORE-1  high    Sprint  A title long enough to be cu…  bug",
      "",
      "● Done 1",
      "  CORE-2                  Second",
      "",
      "3 issues",
    ].join("\n"),
  );
  assert.ok(r.out.includes(`${E}]8;;${url}/acme/browse/CORE-1${E}\\`), "the key opens the issue in the app");
  assert.ok(r.out.includes(`${E}[31m`), "in colour");
  answers = [{ body: { ...three, total: 9 } }];
  assert.match(seenText((await cli(["issues"], "", person)).out), /\n3 of 9 · more with --limit$/);
});

test("an agent, a pipe, NO_COLOR, --plain, TERM=dumb: the same bytes as before, even at a terminal", async () => {
  answers = [{ body: three }];
  const before = (await cli(["issues"])).out;
  assert.ok(!before.includes(E));
  assert.equal(before, "CORE-1  In Review  high    Sprint  A title long enough to be cut at the window edge [bug]\nCORE-2  Done                       Second\nCORE-3  Backlog    urgent  Sprint  First\n3 issues");
  const plainAtTerminal: [string[], Partial<Io>][] = [
    [[], { ...person, env: { CLAUDECODE: "1" } }],
    [[], { ...person, env: { CLAUDECODE: "1", FORCE_COLOR: "1" } }],
    [[], { ...person, env: { NO_COLOR: "1" } }],
    [[], { ...person, env: { TERM: "dumb" } }],
    [["--plain"], person],
    [["--plain"], { env: { FORCE_COLOR: "1" } }],
  ];
  for (const [flags, io] of plainAtTerminal) {
    answers = [{ body: three }];
    assert.equal((await cli(["issues", ...flags], "", io)).out, before, JSON.stringify([flags, io.env]));
  }
  for (const [flags, io] of [[["--color"], {}], [[], { env: { FORCE_COLOR: "1" } }], [["--color"], { env: { CLAUDECODE: "1" } }]] as [string[], Partial<Io>][]) {
    answers = [{ body: three }];
    assert.ok((await cli(["issues", ...flags], "", io)).out.includes(E), `${flags.join(" ")} ${JSON.stringify(io.env)}: colour`);
  }
  answers = [{ body: three }];
  assert.equal(seenText((await cli(["issues", "--", "--color"], "", {})).out), before, "after -- it is a word of the query");
});

test("help, a write and a mistake for a person: the same words, in colour; the call's words are cleaned", async () => {
  assert.equal(seenText((await cli(["help"], "", person)).out), (await cli(["help"])).out);
  answers = [{ body: { ok: true } }];
  assert.equal(seenText((await cli(["update", `core-1${E}[2J`, "--priority", "low"], "", person)).out), "✓ updated CORE-1[2J");
  answers = [{ status: 201, body: { ok: true, key: "CORE-9" } }];
  assert.equal(seenText((await cli(["create", `A ${E}]0;x${BEL}title`, "-p", "CORE"], "", person)).out), "✓ created CORE-9  A ]0;xtitle");
  const mistake = await cli(["nope"], "", person);
  assert.ok(mistake.err.startsWith(`${E}[31mrsva:`));
  assert.equal(seenText(mistake.err), (await cli(["nope"])).err);
});

test("a person's card: labels line up, the description's Markdown is drawn, a long pull request fits the window", async () => {
  answers = [
    page(),
    {
      body: {
        ...row,
        stateGroup: "started",
        createdBy: "bot@x.dev",
        description: "## Goal\nKeep `pnpm check` green\n- [x] done",
        relations: { blockedBy: ["CORE-2"], blocks: [], related: [], duplicateOf: null, duplicates: [] },
        links: [],
        files: [{ name: "shot.png", size: 20480 }],
        pullRequests: [{ repo: "o/r", number: 12, title: "A pull request title that does not fit", state: "open", head: "core-1-first", base: "main", review: "approved", checks: "pass", url: "https://github.com/o/r/pull/12", closing: true }],
      },
    },
  ];
  const { out } = await cli(["show", "CORE-1"], "", person);
  assert.equal(
    seenText(out),
    [
      "CORE-1  First",
      "◐ In Review · high · Sprint",
      "",
      "labels      bug",
      "created by  bot@x.dev",
      "blocked by  CORE-2",
      "file        shot.png  20 KB",
      "pr          o/r#12 open review approved checks pass  A pull…",
      "",
      "Goal",
      "Keep pnpm check green",
      "☑ done",
      "",
      "Comments",
      "",
      "no comments",
    ].join("\n"),
  );
  assert.ok(out.includes(`${E}]8;;${url}/acme/browse/CORE-2${E}\\`), "a related key opens it");
});

test("what others wrote stays data in colour too: only our colour and links reach the terminal", async () => {
  const evil = `${E}]0;pwned${BEL}Text${CSI}31m ${RLO}x`;
  const card = { ...row, title: evil, labels: [evil], createdBy: evil, description: evil, relations: { blockedBy: [], blocks: [], related: [], duplicateOf: null, duplicates: [] }, links: [{ url: `https://x.dev/${E}]8;;https://evil${E}\\`, title: evil }], files: [{ name: evil, size: 1 }] };
  answers = [
    { body: { total: 1, issues: [{ ...row, title: evil, labels: [evil], cycle: evil, state: evil }] } },
    page([{ id: commentId(1), author: evil, body: evil, createdAt: "2026-10-30 02:07" }]),
    { body: card },
    { body: { comments: [{ id: commentId(1), author: evil, body: evil, createdAt: "2026-10-30 02:07" }], older: null } },
    { body: [{ name: evil, short: "C1", status: evil, startDate: null, endDate: null, description: evil, lead: evil, issues: 1, done: 0, open: 1 }] },
  ];
  for (const argv of [["issues"], ["show", "CORE-1"], ["comments", "CORE-1"], ["cycles", "-p", "CORE"]]) {
    const name = argv.join(" ");
    const { out } = await cli(argv, "", person);
    assert.ok(out.includes(E), `${name}: in colour`);
    assert.doesNotMatch(seenText(out), new RegExp(`[${E}${BEL}${CSI}${RLO}]`), name);
    for (const [, target] of out.matchAll(new RegExp(`${E}\\]8;;([^${E}]*)${E}\\\\`, "g"))) assert.match(target!, /^(https?:\/\/[\x21-\x7e]+)?$/, `${name}: a link's target is printable`);
  }
});

test("long output goes to the pager for a person, never for an agent or a pipe", async () => {
  const pages: string[] = [];
  const io: Partial<Io> = { terminal: { columns: 80, rows: 4 }, page: async (t) => void pages.push(t) };
  answers = [{ body: three }];
  const r = await cli(["issues"], "", io);
  assert.deepEqual([r.out, pages.length], ["", 1]);
  answers = [{ body: three }, { body: three }];
  assert.ok((await cli(["issues"], "", { ...io, env: { CLAUDECODE: "1" } })).out);
  assert.ok((await cli(["issues"], "", { page: io.page! })).out);
  assert.equal(pages.length, 1);
});

test("cut: a cut ends in an ellipsis and keeps a wide letter whole", () => {
  assert.deepEqual([cut("Hello world", 6), cut("一二三", 4), cut("short", 9)], ["Hello…", "一…", "short"]);
});

test("my: the token's person's open issues in every project; -p narrows, RSVA_PROJECT does not", async () => {
  answers = [{ body: { total: 0, issues: [] } }, { body: { total: 0, issues: [] } }];
  await cli(["my", "state:Todo"], "", { env: { RSVA_PROJECT: "CORE" } });
  const first = new URL(seen[0]!.url, url).searchParams;
  assert.deepEqual([first.get("q"), first.get("project")], ["assignee:me -group:completed,cancelled state:Todo", null]);
  await cli(["my", "-p", "CORE"]);
  assert.equal(new URL(seen[1]!.url, url).searchParams.get("project"), "CORE");
});

test("issues: the short forms go to the server as typed, which reads them (RSVA-368)", async () => {
  answers = [{ body: { total: 0, issues: [] } }];
  await cli(["issues", "#plnr", "!high", "@me", "+bug", "fix"], "", { env: {} });
  assert.equal(new URL(seen[0]!.url, url).searchParams.get("q"), "#plnr !high @me +bug fix");
});

test("open: the issue's address; a person's browser opens it when it can", async () => {
  const opened: string[] = [];
  const browser = (ok: boolean): Partial<Io> => ({ ...person, open: async (u) => (opened.push(u), ok) });
  assert.equal((await cli(["open", "core-1"], "", { open: browser(true).open! })).out, `${url}/acme/browse/CORE-1`, "plain: the address, nothing opened");
  assert.deepEqual(opened, []);
  assert.equal(seenText((await cli(["open", "core-1"], "", browser(true))).out), "✓ opened CORE-1");
  assert.equal((await cli(["open", "CORE-1"], "", browser(false))).out, `${url}/acme/browse/CORE-1`, "nothing could open it");
  assert.deepEqual(opened, [`${url}/acme/browse/CORE-1`, `${url}/acme/browse/CORE-1`]);
  assert.equal(seen.length, 0, "no request");
});

const described = (description: string) => ({ body: { ...row, description, createdBy: null, relations: { blockedBy: [], blocks: [], related: [], duplicateOf: null, duplicates: [] }, links: [], files: [] } });

test("edit: the description in the editor, saved when it changed; an edit made meanwhile is not overwritten", async () => {
  const files: string[] = [];
  const cache = await mkdtemp(join(tmpdir(), "rsva-cache-"));
  const editor = (write: ((text: string) => string) | null, code = 0): Partial<Io> => ({
    ...person,
    env: { XDG_CACHE_HOME: cache },
    edit: async (file) => {
      files.push(file);
      assert.equal(dirname(file), join(cache, "rsva"), "in the terminal's own cache folder, not /tmp");
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      if (write) await writeFile(file, write(await readFile(file, "utf8")));
      return code;
    },
  });
  answers = [described("Old"), described("Old"), { body: { ok: true } }];
  assert.equal(seenText((await cli(["edit", "core-1"], "", editor((t) => `${t}More\n`))).out), "✓ updated the description of CORE-1");
  assert.equal(await readFile(files[0]!, "utf8").catch(() => "gone"), "gone", "the file is removed once saved");
  assert.deepEqual([seen.at(-1)!.method, seen.at(-1)!.body], ["PATCH", { description: "Old\nMore" }]);

  seen.length = 0;
  answers = [described("Old")];
  assert.equal(seenText((await cli(["edit", "CORE-1"], "", editor(null))).out), "✓ no change to CORE-1");
  assert.deepEqual(seen.map((s) => s.method), ["GET"]);

  seen.length = 0;
  answers = [described("Old"), described("Changed in the app")];
  const raced = await cli(["edit", "CORE-1"], "", editor(() => "Mine"));
  assert.equal(raced.code, 1);
  assert.match(raced.err, /changed while you edited: nothing saved, your text is in /);
  assert.equal(await readFile(files.at(-1)!, "utf8"), "Mine", "the person's text is kept");
  assert.deepEqual(seen.map((s) => s.method), ["GET", "GET"]);

  answers = [described("Old")];
  assert.equal((await cli(["edit", "CORE-1"], "", editor(() => "Half", 1))).code, 2, "the editor failed: nothing saved");
  seen.length = 0;
  assert.equal((await cli(["edit", "CORE-1"], "", { edit: editor(null).edit! })).code, 2, "no terminal: no editor");
  assert.equal(seen.length, 0);
  await rm(cache, { recursive: true, force: true });
});

test("completion zsh: every command, its flags and the query keys; the script is valid zsh", async () => {
  const { code, out } = await cli(["completion", "zsh"]);
  assert.equal(code, 0);
  assert.match(out, /^#compdef rsva\n/);
  for (const name of ["issues", "my", "show", "open", "edit", "cycles", "cycle", "completion"]) assert.match(out, new RegExp(`'${name}:`), name);
  assert.match(out, /\('cycle complete'\) flags=\('--move-to' '--keep' '--project' '-p' /);
  assert.match(out, /compadd -S '' -- project: state: group:/);
  assert.equal((await cli(["completion", "bash"])).code, 2);
  const zsh = spawnSync("zsh", ["-n"], { input: out });
  if (zsh.error) return; // no zsh here: the syntax is checked where there is one
  assert.equal(zsh.status, 0, zsh.stderr.toString());
});

test("the CLI's query keys are the query language's", () => {
  assert.deepEqual([...QUERY_WORDS], [...Object.values(QUERY_KEYS).map((names) => names[0]), ORDER_KEYS[0]]);
});

test("inbox: a line per issue, newest first; read, unread and archive by key or --all", async () => {
  const lines = [
    { key: "CORE-7", title: "Asked for review", state: "In Review", stateGroup: "started", kind: "review", by: "bot@x.dev", at: "2026-11-04T05:12:30.000Z", unread: true, snoozedUntil: null },
    { key: "CORE-3", title: "Old news", state: "Done", stateGroup: "completed", kind: "comment", by: "a@x.dev", at: "2026-11-01T09:00:00.000Z", unread: false, snoozedUntil: null },
  ];
  answers = [{ body: { unread: 1, lines } }, { body: { unread: 1, lines } }, { body: { unread: 0, lines: [] } }];
  assert.equal((await cli(["inbox"])).out, "CORE-7  unread  review   bot@x.dev  2026-11-04 05:12  Asked for review\nCORE-3          comment  a@x.dev    2026-11-01 09:00  Old news\n1 unread");
  assert.equal(seen.at(-1)!.url, "/api/v1/workspaces/acme/inbox");
  assert.equal(seenText((await cli(["inbox"], "", { ...person, terminal: { columns: 100, rows: 100 } })).out), `● CORE-7  review   bot@x.dev  ${localMinute(lines[0]!.at)}  Asked for review\n  CORE-3  comment  a@x.dev    ${localMinute(lines[1]!.at)}  Old news\n\n1 unread`);
  assert.equal((await cli(["inbox", "--all"])).out, "nothing in the inbox · 0 unread");
  assert.match(seen.at(-1)!.url, /\/inbox\?all=1$/);

  answers = [{ body: { ok: true, marked: 2 } }, { body: { ok: true, marked: 5 } }, { body: { ok: true, marked: 1 } }];
  assert.equal((await cli(["inbox", "read", "core-7", "CORE-3"])).out, "marked read: 2");
  assert.deepEqual([seen.at(-1)!.method, seen.at(-1)!.body], ["POST", { read: ["CORE-7", "CORE-3"] }]);
  assert.equal(seenText((await cli(["inbox", "archive", "--all"], "", person)).out), "✓ archived: 5");
  assert.deepEqual(seen.at(-1)!.body, { archive: "all" });
  await cli(["inbox", "unread", "CORE-7"]);
  assert.deepEqual(seen.at(-1)!.body, { unread: ["CORE-7"] });

  seen.length = 0;
  for (const argv of [["inbox", "read"], ["inbox", "read", "CORE-1", "--all"], ["inbox", "nope"], ["inbox", "--limit", "3"]]) assert.equal((await cli(argv)).code, 2, argv.join(" "));
  assert.equal(seen.length, 0);
});

test("answers come compressed: the CLI asks for brotli and reads it", async () => {
  const list = { total: 1, issues: [{ ...row, title: "Compressed ".repeat(200) }] };
  answers = [{ raw: brotliCompressSync(JSON.stringify(list)), headers: { "content-encoding": "br" } }];
  const r = await cli(["issues", "--json"]);
  assert.equal(acceptEncoding, "br, gzip");
  assert.deepEqual(JSON.parse(r.out), list);
});

test("a bug in the CLI is thrown with its stack, not printed as a failure of the network", async () => {
  answers = [{ body: { total: 1, issues: "not a list" } }];
  await assert.rejects(cli(["issues"]), TypeError);
});

test("an issue whose state is not found reads as ?", async () => {
  const lost = { total: 1, issues: [{ ...row, state: null, stateGroup: null }] };
  answers = [{ body: lost }, { body: lost }];
  assert.equal((await cli(["issues"])).out, "CORE-1  ?  high  Sprint  First [bug]\n1 issue");
  assert.match(seenText((await cli(["issues"], "", person)).out), /^○ \? 1\n/);
});

test("show: a deleted or archived issue says so", async () => {
  answers = [page(), { body: { ...described("").body, deletedAt: "2026-11-01T10:00:00.000Z" } }, page(), { body: { ...described("").body, archivedAt: "2026-10-20 08:00:00+00", deletedAt: null } }];
  assert.equal((await cli(["show", "CORE-1"])).out.split("\n")[1], "In Review · high · Sprint · deleted 2026-11-01");
  assert.equal(seenText((await cli(["show", "CORE-1"], "", person)).out).split("\n")[1], "○ In Review · high · Sprint · archived 2026-10-20");
});

test("comments: a reply under its comment, a handle to answer by, the page before by --until", async () => {
  const page = {
    comments: [
      { id: commentId(1), parentId: null, author: "a@x.dev", body: "Question?", createdAt: "2026-10-30 02:07:52.1+00", editedAt: null },
      { id: commentId(2), parentId: null, author: "b@x.dev", body: "Other", createdAt: "2026-10-30 02:30:00+00", editedAt: "2026-10-30 02:31:00+00" },
      { id: commentId(3), parentId: commentId(1), author: "b@x.dev", body: "Answer\nin two lines", createdAt: "2026-10-30 03:00:00+00", editedAt: null },
      { id: commentId(4), parentId: commentId(9), author: "a@x.dev", body: "To an older one", createdAt: "2026-10-30 04:00:00+00", editedAt: null },
    ],
    older: "2026-10-29 10:00:00.5+00",
  };
  answers = [{ body: page }, { body: page }];
  const r = await cli(["comments", "core-1", "--until", "2026-10-31 00:00:00+00"]);
  assert.equal(new URL(seen[0]!.url, url).searchParams.get("until"), "2026-10-31 00:00:00+00");
  assert.equal(
    r.out,
    [
      "a@x.dev, 2026-10-30 02:07 · 000001",
      "  Question?",
      "",
      "  ↳ b@x.dev, 2026-10-30 03:00 · 000003",
      "    Answer",
      "    in two lines",
      "",
      "b@x.dev, 2026-10-30 02:30 · 000002 · edited",
      "  Other",
      "",
      "↳ a@x.dev, 2026-10-30 04:00 · 000004",
      "  To an older one",
      "",
      "older: rsva comments CORE-1 --until '2026-10-29 10:00:00.5+00'",
    ].join("\n"),
  );
  assert.ok(seenText((await cli(["comments", "CORE-1"], "", person)).out).startsWith(`a@x.dev ${localMinute(page.comments[0]!.createdAt)} · 000001\n`), "a person reads their own clock");
});

test("comment --reply-to: a full id goes as it is, a handle is found on the newest page", async () => {
  const id = commentId(0xc0ffe);
  answers = [{ status: 201, body: { ok: true } }];
  await cli(["comment", "CORE-1", "Yes", "--reply-to", id]);
  assert.deepEqual([seen.length, seen[0]!.body], [1, { body: "Yes", parentId: id }]);
  seen.length = 0;
  const page = { comments: [{ id, author: null, body: "Q", createdAt: "x" }, { id: commentId(0xaaa), author: null, body: "R", createdAt: "x" }], older: null };
  answers = [{ path: "/comments", body: page }, { status: 201, body: { ok: true } }];
  assert.equal((await cli(["comment", "CORE-1", "Yes", "--reply-to", "0C0FFE"])).out, "commented on CORE-1");
  assert.deepEqual(
    seen.map((s) => [s.method, s.body]),
    [
      ["GET", undefined],
      ["POST", { body: "Yes", parentId: id }],
    ],
  );
  seen.length = 0;
  answers = [{ body: page }];
  assert.equal((await cli(["comment", "CORE-1", "Yes", "--reply-to", "123456"])).code, 2);
  assert.deepEqual(seen.map((s) => s.method), ["GET"], "nothing is posted");
});

test("unlink: by the address show prints, or by the id", async () => {
  const link = { id: "0192a1b2-0000-7000-8000-00000000111a", url: "https://x.dev/a", title: "" };
  answers = [{ body: { ...described("").body, links: [link] } }, { body: { ok: true } }];
  assert.equal((await cli(["unlink", "core-1", "https://x.dev/a"])).out, "unlinked CORE-1");
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), ["GET /api/v1/workspaces/acme/issues/CORE-1", `DELETE /api/v1/workspaces/acme/issues/CORE-1/links/${link.id}`]);
  seen.length = 0;
  answers = [{ body: { ok: true } }];
  await cli(["unlink", "CORE-1", link.id]);
  assert.deepEqual(seen.map((s) => s.method), ["DELETE"], "an id needs no lookup");
  seen.length = 0;
  answers = [{ body: { ...described("").body, links: [link, { ...link, id: "0192a1b2-0000-7000-8000-00000000111b" }] } }, { body: { ...described("").body, links: [] } }];
  assert.equal((await cli(["unlink", "CORE-1", "https://x.dev/a"])).code, 2, "two links to one address");
  assert.equal((await cli(["unlink", "CORE-1", "https://x.dev/b"])).code, 2, "no such link");
  assert.deepEqual(seen.map((s) => s.method), ["GET", "GET"]);
});

test("refused before a request: --limit out of range, a change with nothing in it, --json where there is no answer", async () => {
  const calls = [
    ["issues", "--limit", "0"],
    ["issues", "--limit", "501"],
    ["my", "--limit", "ten"],
    ["update", "CORE-1"],
    ["cycle", "update", "C1", "-p", "CORE"],
    ["open", "CORE-1", "--json"],
    ["edit", "CORE-1", "--json"],
    ["completion", "zsh", "--json"],
    ["help", "--json"],
    ["api", "GET", "/issues", "--json"],
  ];
  for (const argv of calls) assert.equal((await cli(argv)).code, 2, argv.join(" "));
  assert.equal(seen.length, 0);
});

test("a list at the API's most says to narrow the query; cycle show has no --limit to suggest", async () => {
  const many = { total: 900, issues: Array.from({ length: 500 }, (_, n) => ({ ...row, key: `CORE-${n + 1}` })) };
  answers = [{ body: many }];
  assert.match(seenText((await cli(["issues", "--limit", "500"], "", person)).out), /\n500 of 900 · 500 at most: narrow the query$/);
  const cycle = { name: "S", short: "C1", status: "active", startDate: null, endDate: null, description: "", lead: null, issues: 900, done: 0, open: 900 };
  answers = [
    { path: "/cycles/", body: cycle },
    { path: "/issues", body: { total: 900, issues: [row] } },
  ];
  assert.match(seenText((await cli(["cycle", "show", "C1", "-p", "CORE"], "", person)).out), /\n1 of 900$/);
});

test("help, completion and open need no server: a RSVA_URL the token may not go to does not stop them", async () => {
  assert.equal((await cli(["completion", "zsh"], "", { env: { RSVA_URL: "not a url" } })).code, 0);
  assert.equal((await cli(["help"], "", { env: { RSVA_URL: "not a url" } })).code, 0);
  assert.equal((await cli(["open", "CORE-1"], "", { env: { RSVA_URL: "http://plan.example.com" } })).out, "http://plan.example.com/acme/browse/CORE-1");
  assert.equal(seen.length, 0);
});

test("without RSVA_WS the workspace is the token's own, asked once a run", async () => {
  answers = [{ path: "/sync/workspaces", body: [{ slug: "beta" }] }, { body: { total: 0, issues: [] } }];
  assert.equal((await cli(["issues"], "", { env: { RSVA_WS: "" } })).code, 0);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url} ${s.auth}`), ["GET /sync/workspaces Bearer rsva_secret", "GET /api/v1/workspaces/beta/issues Bearer rsva_secret"]);
  seen.length = 0;
  answers = [{ path: "/sync/workspaces", body: [{ slug: "beta" }] }];
  assert.equal((await cli(["open", "CORE-1"], "", { env: { RSVA_WS: "" } })).out, `${url}/beta/browse/CORE-1`);
  answers = [{ path: "/sync/workspaces", body: [] }];
  const none = await cli(["issues"], "", { env: { RSVA_WS: "" } });
  assert.deepEqual([none.code, none.err], [2, "rsva: the token opens no workspace: set RSVA_WS"]);
  answers = [{ path: "/sync/workspaces", body: [{ slug: "beta" }, { slug: "gamma" }] }];
  const several = await cli(["issues"], "", { env: { RSVA_WS: "" } });
  assert.deepEqual([several.code, several.err], [2, "rsva: several workspaces: set RSVA_WS"]);
});

test("login: the code from Settings › Security for a session in the Keychain, unsigned; logout ends it there and here", async () => {
  const kept: string[] = [];
  const keychain = {
    read: async () => null,
    write: async (service: string, account: string, secret: string) => void kept.push(`${service} ${account} ${secret}`),
    remove: async (service: string) => (kept.push(`- ${service}`), true),
  };
  const session = { session: "sess_secret", expiresAt: "2027-11-06T00:00:00.000Z", user: { id: "u1", email: "ann@example.com", name: "Ann" } };
  answers = [{ path: "/auth/terminal", body: session }];
  const piped = await cli(["login"], "code_from_page\n", { keychain });
  assert.deepEqual([piped.code, piped.out], [0, "Signed in as ann@example.com: rsva tui opens every workspace you are in."]);
  assert.deepEqual(seen.map((s) => [s.method, s.url, s.auth, s.body]), [["POST", "/auth/terminal", undefined, { code: "code_from_page" }]]);
  // The item before goes first: the Keychain would keep two accounts under one service and hand out the first.
  assert.deepEqual(kept, ["- rsva-session", "rsva-session ann@example.com sess_secret"]);

  // Over an earlier login: that session is ended on the server and its copies here before its item goes, not left live.
  seen.length = 0;
  kept.length = 0;
  const removed: string[] = [];
  answers = [{ path: "/auth/terminal", body: session }, { path: "/auth/sign-out", status: 204 }];
  const again = await cli(["login"], "code\n", { keychain: { ...keychain, read: async () => "sess_before" }, copies: async (a) => void removed.push(a) });
  assert.equal(again.code, 0);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url} ${s.auth}`), ["POST /auth/terminal undefined", "POST /auth/sign-out Session sess_before"]);
  assert.deepEqual([removed, kept], [["Session sess_before"], ["- rsva-session", "rsva-session ann@example.com sess_secret"]]);

  // A session the Keychain did not keep is ended on the server again, not left live with nothing holding it.
  seen.length = 0;
  answers = [{ path: "/auth/terminal", body: session }, { path: "/auth/sign-out", status: 204 }];
  const unkept = await cli(["login"], "code\n", { keychain: { ...keychain, write: async () => Promise.reject(new Error("keychain: could not keep the secret under rsva-session")) } });
  assert.deepEqual([unkept.code, unkept.err], [2, "rsva: keychain: could not keep the secret under rsva-session; the session was ended again"]);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url} ${s.auth}`), ["POST /auth/terminal undefined", "POST /auth/sign-out Session sess_secret"]);

  // At a terminal: the page opens and the code is asked for.
  seen.length = 0;
  const opened: string[] = [];
  const prompts: string[] = [];
  answers = [{ path: "/auth/terminal", body: session }];
  const asked = await cli(["login"], "", { keychain, open: async (u) => (opened.push(u), true), ask: async (p) => (prompts.push(p), " pasted ") });
  assert.equal(asked.code, 0);
  assert.deepEqual([opened, prompts, seen[0]!.body], [[`${url}/settings/security`], ["Code: "], { code: "pasted" }]);

  answers = [{ path: "/auth/terminal", status: 400, body: { message: "This code no longer works" } }];
  assert.deepEqual(await cli(["login"], "old", { keychain }).then((r) => [r.code, r.err]), [1, "rsva: This code no longer works"]);
  assert.equal((await cli(["login"], "", { keychain })).code, 2);
  assert.equal((await cli(["login"], "code")).code, 2, "no Keychain, no login");

  seen.length = 0;
  kept.length = 0;
  answers = [{ path: "/auth/sign-out", status: 204 }];
  removed.length = 0;
  const out = await cli(["logout"], "", { keychain, copies: async (a) => void removed.push(a), env: { RSVA_SESSION: "sess_secret" } });
  assert.deepEqual([out.code, out.out, kept], [0, "Signed out.", ["- rsva-session"]]);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url} ${s.auth}`), ["POST /auth/sign-out Session sess_secret"]);
  // The TUI's copies made with the session go too (copies.ts).
  assert.deepEqual(removed, ["Session sess_secret"]);
  // Ended on the server already: forgotten here all the same.
  answers = [{ path: "/auth/sign-out", status: 401, body: { message: "sign in first" } }];
  assert.equal((await cli(["logout"], "", { keychain, env: { RSVA_SESSION: "sess_secret" } })).code, 0);
});

test("a session goes to https or this machine only, and a sign-in too", async () => {
  const keychain = { read: async () => null, write: async () => {}, remove: async () => true };
  const r = await cli(["login"], "code", { keychain, env: { RSVA_URL: "http://plan.example.com" } });
  assert.deepEqual([r.code, r.err, seen.length], [2, "rsva: RSVA_URL: https only, got http://plan.example.com", 0]);
});

test("help: one command, a group, or all", async () => {
  assert.equal((await cli(["help", "show"])).out, "  show <key>\n      one issue with its description and the newest page of its comments; a deleted or archived one says so");
  assert.equal((await cli(["show", "--help"])).out, (await cli(["help", "show"])).out);
  assert.match((await cli(["help", "cycle"])).out, /^ {2}cycle show <cycle> \[-p KEY\]\n/);
  assert.equal((await cli(["help", "cycle", "complete"])).out, (await cli(["cycle", "complete", "-h"])).out);
  assert.equal((await cli(["help"])).out, (await cli([])).out);
  assert.equal((await cli(["help", "nope"])).code, 2);
  assert.equal((await cli(["help", "show", "extra"])).code, 2);
});

test("--json: one line for a pipe or an agent, indented for a person", async () => {
  const data = { total: 0, issues: [] };
  answers = [{ body: data }, { body: data }];
  assert.equal((await cli(["issues", "--json"])).out, '{"total":0,"issues":[]}');
  assert.equal((await cli(["issues", "--json"], "", person)).out, JSON.stringify(data, null, 2));
});

test("a GET the server is too busy for is asked once more after its short wait; a write is not, nor a long wait", async () => {
  const busy = (message: string, wait = "0", status = 503): Answer => ({ status, body: { error: "unavailable", message }, headers: { "retry-after": wait } });
  answers = [busy("busy"), { body: { total: 0, issues: [] } }];
  assert.equal((await cli(["issues"])).code, 0);
  assert.equal(seen.length, 2);
  seen.length = 0;
  answers = [busy("busy"), busy("still busy")];
  assert.equal((await cli(["issues"])).err, "rsva: still busy (retry after 0 s)");
  assert.equal(seen.length, 2, "once, not again");
  seen.length = 0;
  answers = [busy("busy"), busy("too many", "60", 429)];
  assert.equal((await cli(["comment", "CORE-1", "Hi"])).code, 1);
  assert.equal((await cli(["issues"])).code, 1);
  assert.equal(seen.length, 2, "neither the write nor the long wait is asked again");
});

test("api: any call, the query as name=value, a JSON body or - for stdin, the answer as JSON", async () => {
  answers = [{ body: { total: 0, issues: [] } }, { status: 201, body: { ok: true, key: "CORE-9" } }, { body: { ok: true } }, { status: 204 }];
  assert.equal((await cli(["api", "get", "/issues", "project=CORE", 'q=state:"In Review"'])).out, '{"total":0,"issues":[]}');
  assert.equal(new URL(seen[0]!.url, url).searchParams.get("q"), 'state:"In Review"');
  assert.equal((await cli(["api", "POST", "/issues", '{"project":"CORE","title":"a=b"}'])).out, '{"ok":true,"key":"CORE-9"}');
  assert.deepEqual([seen[1]!.method, seen[1]!.body], ["POST", { project: "CORE", title: "a=b" }]);
  await cli(["api", "PATCH", "/cycles/C1?project=CORE", "-"], '{"name":"N"}');
  assert.deepEqual([seen[2]!.url, seen[2]!.body], ["/api/v1/workspaces/acme/cycles/C1?project=CORE", { name: "N" }]);
  assert.equal((await cli(["api", "DELETE", "/tokens/x"])).out, "");
  for (const argv of [["api", "FETCH", "/issues"], ["api", "GET", "issues"], ["api", "POST", "/issues", "{nope"], ["api", "POST", "/issues", "{}", "[]"]]) assert.equal((await cli(argv)).code, 2, argv.join(" "));
  assert.equal(seen.length, 4);
});

test("a person's Markdown: a mention reads as the name, a link and a file open, code keeps its brackets", async () => {
  answers = [page(), described("Ask [@Robin](mention:01a19ea4-5caf-7756-9c27-3f2872c0f875) about [the spec](https://x.dev/spec)\n![shot](/files/acme/ab12) and `[not](a link)`"), page(), described("Ask [@Robin](mention:01a1)")];
  const { out } = await cli(["show", "CORE-1"], "", person);
  assert.equal(card(seenText(out)).split("\n").slice(-2).join("\n"), "Ask @Robin about the spec\nimage shot and [not](a link)");
  assert.ok(out.includes(`${E}]8;;https://x.dev/spec${E}\\`));
  assert.ok(out.includes(`${E}]8;;${url}/files/acme/ab12${E}\\`), "a file of the server opens there");
  assert.ok(!out.includes("mention:"));
  assert.ok(card((await cli(["show", "CORE-1"])).out).endsWith("Ask [@Robin](mention:01a1)"), "plain text keeps the Markdown as written");
  // The TUI's reading (@rsva/terminal/markdown, RSVA-421): emphasis, escapes and addresses, quotes and fences.
  answers = [page(), described("_it_ ~~gone~~ \\*not\\* see https://x.dev/a.\n> said\n~~~\n**raw**\n~~~")];
  const rich = (await cli(["show", "CORE-1"], "", person)).out;
  assert.equal(card(seenText(rich)).split("\n").slice(-5).join("\n"), "it gone *not* see https://x.dev/a.\n│ said\n~~~\n**raw**\n~~~");
  assert.ok(rich.includes(`${E}[3mit${E}[23m`) && rich.includes(`${E}[9mgone${E}[29m`), "italic and struck");
  assert.ok(rich.includes(`${E}]8;;https://x.dev/a${E}\\`), "an address opens");
});

test("completion's fixed values are the packages' own, and the query takes every one", () => {
  assert.deepEqual([...PRIORITY_WORDS].sort(), Object.values(PRIORITY_KEYWORDS).sort());
  assert.deepEqual([...ORDER_WORDS].sort(), ORDER_BY_OPTIONS.map((o) => o.value).sort());
  assert.deepEqual([...RELATION_WORDS], [...schema.RELATION_TYPES]);
  assert.deepEqual([...QUERY_VALUES.updated!], [...DATE_PRESETS]);
  assert.deepEqual([...QUERY_VALUES.order!], Object.values(QUERY_ORDER_WORDS));
  const ctx = { states: new Map(), labels: new Map(), users: new Map(), me: null, issueKey: () => "", today: "2026-11-04" } as QueryContext;
  for (const [k, values] of Object.entries(QUERY_VALUES)) for (const v of values) assert.deepEqual(parseQuery(`${k}:${formatValue(v)}`, ctx).errors, [], `${k}:${v}`);
  assert.notDeepEqual(parseQuery("is:nope", ctx).errors, [], "the check can fail");
});

test("completion zsh offers what fits where the cursor is", async (t) => {
  const { out } = await cli(["completion", "zsh"]);
  const sh = (w: string) => `'${w.replaceAll("'", "'\\''")}'`;
  // compadd, compset and _describe work only inside a completion widget: these print what they are given instead.
  const fakes = `compdef() { :; }
compadd() { local -a w; while (( $# )); do case $1 in (-S) shift 2 ;; (-a) w+=(\${(P)2}); shift 2 ;; (--) shift; w+=("$@"); break ;; (*) w+=("$1"); shift ;; esac; done; print -r -- "$IPREFIX|\${(j: :)w}"; }
_describe() { local -a w; local name=\${@[-1]}; w=(\${(P)name}); print -r -- "describe|\${(j: :)\${(@)w%%:*}}"; }
compset() { [[ $1 == -P ]] || return 1; local m=\${(M)PREFIX##$~2}; [[ -n $m ]] || return 1; IPREFIX+=$m; PREFIX=\${PREFIX#$m}; }
probe() { words=("$@"); CURRENT=$#; PREFIX=$words[CURRENT]; IPREFIX=; _rsva; print -r -- "--"; }`;
  const keys = QUERY_WORDS.map((w) => `${w}:`).join(" ");
  const cases: [string[], string][] = [
    [[""], "describe|issues my show open edit create update move archive delete restore comments comment uncomment link unlink attach detach relate unrelate inbox cycles cycle projects project states state labels label members views workspace tui login logout completion api help"],
    [["relate", "CORE-1", ""], "|blockedBy blocks related duplicateOf duplicates"],
    [["issues", "--order", ""], "|updatedAt createdAt priority dueDate startDate manual"],
    [["update", "CORE-1", "--priority", ""], "|urgent high medium low none"],
    [["create", "x", "-p", ""], ""],
    [["issues", "is:"], "is:|blocked blocking duplicate"],
    [["my", "-group:completed,c"], "-group:completed,|backlog unstarted started completed cancelled"],
    [["issues", "-la"], `-|${keys}`],
    [["issues", "-p", "PLNR", "st"], `|${keys}`],
    [["cycle", ""], "describe|show create update complete delete"],
    [["cycle", "complete", "C1", "--move-to", ""], "|next none"],
    [["label", ""], "describe|create update delete"],
    [["state", "create", "Review", "--group", ""], "|backlog unstarted started completed cancelled"],
    [["cycle", "show", "--"], "|--project -p --help -h --plain --color --json"],
    [["inbox", ""], "|read unread archive"],
    [["help", ""], "|issues my show open edit create update move archive delete restore comments comment uncomment link unlink attach detach relate unrelate inbox cycles cycle projects project states state labels label members views workspace tui login logout completion api help"],
  ];
  const script = [fakes, out, ...cases.map(([w]) => `probe rsva ${w.map(sh).join(" ")}`)].join("\n");
  const zsh = spawnSync("zsh", ["-f"], { input: script });
  if (zsh.error) return t.skip("no zsh here");
  assert.equal(zsh.stderr.toString(), "");
  const got = zsh.stdout.toString().split("--\n").slice(0, -1).map((s) => s.trimEnd());
  assert.deepEqual(got, cases.map(([, want]) => want));
});

test("bin/rsva.js starts the CLI with Node's compile cache in the person's cache folder", async () => {
  const cache = await mkdtemp(join(tmpdir(), "rsva-cache-"));
  const env = { ...process.env, XDG_CACHE_HOME: cache, RSVA_URL: url, RSVA_WS: "acme", RSVA_TOKEN: "rsva_secret" };
  const bin = new URL("../bin/rsva.js", import.meta.url).pathname;
  assert.equal((await promisify(execFile)(process.execPath, [bin, "help"], { env })).stdout.trimEnd(), (await cli(["help"])).out);
  assert.ok((await readdir(join(cache, "rsva", "node-compile-cache"))).length, "the cache is filled");
  answers = [{ body: { total: 0, issues: [] } }];
  const api = await promisify(execFile)(process.execPath, [bin, "api", "GET", "/issues", "project=CORE"], { env });
  assert.equal(api.stdout, '{"total":0,"issues":[]}\n');
  assert.equal(seen.at(-1)!.url, "/api/v1/workspaces/acme/issues?project=CORE");
  await rm(cache, { recursive: true });
});

test("the command for the page before is built from the cleaned answer and quoted for the shell", async () => {
  const older = `2026-10-29 10:00'; rm -rf ~ #${E}]0;pwned${BEL}`;
  answers = [{ body: { comments: [], older } }, { body: { comments: [], older } }];
  const shown = (await cli(["comments", "CORE-1"], "", person)).out;
  assert.doesNotMatch(seenText(shown), new RegExp(`[${E}${BEL}]`), "nothing of the answer drives the terminal");
  assert.ok(seenText(shown).endsWith(`older: rsva comments CORE-1 --until '2026-10-29 10:00'\\''; rm -rf ~ #]0;pwned'`));
  assert.ok((await cli(["comments", "CORE-1"])).out.endsWith(`--until '2026-10-29 10:00'\\''; rm -rf ~ #]0;pwned'`));
});

test("settings: the workspace, members, views, projects, states and labels as columns; a project with its states and labels", async () => {
  answers = [{ body: { slug: "acme", name: "Acme", color: null, me: { email: "bot@x.dev", name: "Bot", kind: "agent", role: "member", scope: "write" } } }];
  assert.equal((await cli(["workspace", "show"])).out, "Acme  acme\nbot@x.dev  member · agent · write token");
  // What the token may change now (PLNR-271); a read token says it changes nothing.
  answers = [{ body: { slug: "acme", name: "Acme", color: null, memberRights: ["labels.write"], me: { email: "bot@x.dev", name: "Bot", kind: "agent", role: "member", scope: "custom", grants: ["issues.write", "labels.write"] } } }];
  assert.equal((await cli(["workspace", "show"])).out, "Acme  acme\nbot@x.dev  member · agent · custom token\nmay change  issues.write, labels.write\nmembers may also change  labels.write");
  answers = [{ body: { slug: "acme", name: "Acme", color: null, me: { email: "bot@x.dev", name: "Bot", kind: "agent", role: "member", scope: "read", grants: [] } } }];
  assert.equal((await cli(["workspace", "show"])).out, "Acme  acme\nbot@x.dev  member · agent · read token\nmay change  nothing, reads only");
  answers = [{ body: [{ email: "a@x.dev", name: "Ann", kind: "human", role: "owner" }, { email: "bot@x.dev", name: "Bot", kind: "agent", role: "member" }] }];
  assert.equal((await cli(["members"])).out, "a@x.dev    Ann  owner\nbot@x.dev  Bot  member  agent");
  answers = [{ body: [{ name: "Mine", query: "assignee:me", shared: false, mine: true }] }];
  assert.equal((await cli(["views"])).out, "Mine  mine  assignee:me");
  answers = [{ body: [{ key: "CORE", name: "Core", color: null, formerKeys: [], archivedAt: null }, { key: "OLD", name: "Old", color: "teal", formerKeys: ["OL"], archivedAt: "2026-11-01" }] }];
  assert.equal((await cli(["projects"])).out, "CORE  Core\nOLD   Old   archived · was OL");
  const states = [
    { name: "Backlog", group: "backlog", default: true, issues: 3 },
    { name: "In Progress", group: "started", default: false, issues: 1 },
  ];
  answers = [{ body: states }];
  assert.equal((await cli(["states", "-p", "core"])).out, "◌  Backlog      backlog  default  3 issues\n◐  In Progress  started           1 issue");
  assert.equal(seen.at(-1)!.url, "/api/v1/workspaces/acme/states?project=core");
  const labels = [
    { name: "area", color: "#E5484D", parent: null, depth: 0, workspace: false, issues: 0 },
    { name: "ui", color: "#0090FF", parent: "area", depth: 1, workspace: false, issues: 2 },
    { name: "bug", color: "#46A758", parent: null, depth: 0, workspace: true, issues: 1 },
  ];
  answers = [{ body: labels }];
  assert.equal((await cli(["labels", "-p", "CORE"])).out, "area  #E5484D             0 issues\n· ui  #0090FF             2 issues\nbug   #46A758  workspace  1 issue");
  answers = [{ body: { key: "CORE", name: "Core", color: "teal", formerKeys: [], archivedAt: null, rollover: true, states, labels: [] } }];
  assert.equal((await cli(["project", "show", "core"])).out, "CORE  Core\nteal · cycle rollover\n\nStates\n◌  Backlog      backlog  default  3 issues\n◐  In Progress  started           1 issue\n\nLabels\nno labels");
  assert.equal(seen.at(-1)!.url, "/api/v1/workspaces/acme/projects/CORE");
});

test("settings writes: the method, the path and the body; a change with nothing in it is not sent", async () => {
  const cases: [string[], string, string, unknown][] = [
    [["project", "create", "web", "Website", "--hue", "teal"], "POST", "/projects", { key: "web", name: "Website", color: "teal" }],
    [["project", "update", "web", "--key", "SITE", "--hue", "none"], "PATCH", "/projects/WEB", { key: "SITE", color: null }],
    [["project", "archive", "web"], "PATCH", "/projects/WEB", { archived: true }],
    [["project", "unarchive", "web"], "PATCH", "/projects/WEB", { archived: false }],
    [["project", "update", "web", "--rollover", "on"], "PATCH", "/projects/WEB", { rollover: true }],
    [["project", "update", "web", "--rollover", "off"], "PATCH", "/projects/WEB", { rollover: false }],
    [["state", "create", "In Review", "-p", "CORE", "--group", "started", "--after", "In Progress"], "POST", "/states", { project: "CORE", name: "In Review", group: "started", after: "In Progress" }],
    [["state", "update", "In Review", "-p", "CORE", "--name", "Review", "--default"], "PATCH", "/states/In%20Review?project=CORE", { name: "Review", default: true }],
    [["state", "delete", "Review", "-p", "CORE", "--move-to", "Todo"], "DELETE", "/states/Review?project=CORE&moveTo=Todo", undefined],
    [["label", "create", "ui", "-p", "CORE", "--hue", "blue", "--parent", "area"], "POST", "/labels", { project: "CORE", name: "ui", color: "blue", parent: "area" }],
    [["label", "update", "ui", "-p", "CORE", "--parent", "none"], "PATCH", "/labels/ui?project=CORE", { parent: null }],
    [["label", "delete", "ui", "-p", "CORE"], "DELETE", "/labels/ui?project=CORE", undefined],
    [["workspace", "update", "--name", "Acme"], "PATCH", "/workspace", { name: "Acme" }],
  ];
  for (const [argv, method, path, body] of cases) {
    answers = [{ body: { ok: true, key: "WEB", name: "ui", color: "#0090FF", moved: 0, removedFrom: 0 } }];
    const r = await cli(argv);
    assert.equal(r.code, 0, `${argv.join(" ")}: ${r.err}`);
    assert.deepEqual([seen.at(-1)!.method, seen.at(-1)!.url, seen.at(-1)!.body], [method, `/api/v1/workspaces/acme${path}`, body]);
  }
  answers = [{ status: 201, body: { ok: true, name: "area", color: "#E5484D" } }];
  assert.equal((await cli(["label", "create", "area", "-p", "CORE"])).out, "created area #E5484D", "the color the server chose");
  seen.length = 0;
  for (const argv of [["state", "update", "Todo", "-p", "CORE"], ["state", "create", "X", "-p", "CORE"], ["workspace", "update"], ["project", "update", "web", "--rollover", "yes"]])
    assert.equal((await cli(argv)).code, 2, argv.join(" "));
  assert.equal(seen.length, 0);
  answers = [{ status: 403, body: { error: "forbidden", message: "a member cannot change Label" } }];
  const refused = await cli(["label", "create", "x", "-p", "CORE"]);
  assert.deepEqual([refused.code, refused.err], [1, "rsva: a member cannot change Label"]);
});

test("comment --edit and uncomment by handle; attach uploads the bytes under their SHA-256, detach by name", async () => {
  const id = commentId(0xc0ffe);
  const page = { comments: [{ id, author: null, body: "Q", createdAt: "x" }], older: null };
  answers = [{ path: "/comments", body: page }, { body: { ok: true } }];
  assert.equal((await cli(["comment", "CORE-1", "Better", "--edit", "0c0ffe"])).out, "edited the comment on CORE-1");
  assert.deepEqual(seen.at(-1)!.url, `/api/v1/workspaces/acme/issues/CORE-1/comments/${id}`);
  assert.deepEqual([seen.at(-1)!.method, seen.at(-1)!.body], ["PATCH", { body: "Better" }]);
  assert.equal((await cli(["comment", "CORE-1", "x", "--edit", id, "--reply-to", id])).code, 2);
  answers = [{ body: { ok: true } }];
  assert.equal((await cli(["uncomment", "CORE-1", id])).out, "deleted the comment on CORE-1");
  assert.deepEqual([seen.at(-1)!.method, seen.at(-1)!.url], ["DELETE", `/api/v1/workspaces/acme/issues/CORE-1/comments/${id}`]);

  const dir = await mkdtemp(join(tmpdir(), "rsva-attach-"));
  const file = join(dir, "notes.md");
  await writeFile(file, "# Notes\n");
  const want = createHash("sha256").update("# Notes\n").digest("hex");
  seen.length = 0;
  answers = [{ status: 201, body: { ok: true, sha256: want, size: 8, mime: "text/markdown" } }, { status: 201, body: { ok: true } }];
  assert.equal((await cli(["attach", "core-1", file])).out, "attached notes.md to CORE-1");
  const [put, post] = seen;
  assert.deepEqual([put!.method, put!.url, put!.type, String(put!.body)], ["PUT", `/files/acme/${want}`, "text/markdown", "# Notes\n"]);
  assert.deepEqual([post!.method, post!.url, post!.body], ["POST", "/api/v1/workspaces/acme/issues/CORE-1/files", { sha256: want, name: "notes.md" }]);
  assert.equal((await cli(["attach", "CORE-1", join(dir, "missing.pdf")])).code, 2);
  await rm(dir, { recursive: true });

  const fileRow = { id: "0192a1b2-0000-7000-8000-00000000222a", name: "notes.md", size: 8 };
  seen.length = 0;
  answers = [{ body: { ...described("").body, files: [fileRow] } }, { body: { ok: true } }];
  assert.equal((await cli(["detach", "CORE-1", "notes.md"])).out, "detached notes.md from CORE-1");
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), ["GET /api/v1/workspaces/acme/issues/CORE-1", `DELETE /api/v1/workspaces/acme/issues/CORE-1/files/${fileRow.id}`]);
});
