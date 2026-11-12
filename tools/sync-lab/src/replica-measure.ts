// What a replica in the CLI would cost (PLNR-233, docs/research/cli-replica-2026-11-04.md): the real engine in Node
// against a live server, cold from a snapshot and warm from its copy, and the query `rsva my` runs, on the copy.
// node tools/sync-lab/src/replica-measure.ts [--url https://app.rsva.dev] --ws <slug>; the token is the CLI's
// (RSVA_TOKEN, else the Keychain service RSVA_KEYCHAIN, default rsva-bot) and is printed nowhere.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { until } from "@rsva/test-kit";

const ms = (t: number) => Math.round(performance.now() - t);
const t0 = performance.now();
const { authorizedTransport, createSyncStore } = await import("@rsva/sync");
const tSync = ms(t0);
const { default: WebSocket } = await import("ws");
const { IDBFactory } = await import("fake-indexeddb");
const t1 = performance.now();
const q = await import("@rsva/query");
const tQuery = ms(t1);

const { values } = parseArgs({ options: { url: { type: "string", default: "https://app.rsva.dev" }, ws: { type: "string" } } });
const ws = values.ws ?? "";
if (!ws) throw new Error("--ws <slug> is required");
const token = process.env.RSVA_TOKEN || execFileSync("security", ["find-generic-password", "-s", process.env.RSVA_KEYCHAIN ?? "rsva-bot", "-w"]).toString().trim();
const net = { http: 0, httpWire: 0, ws: 0, requests: [] as string[] };
const link = authorizedTransport(`Bearer ${token}`, WebSocket);
const fetchAs = async (input: RequestInfo | URL, init?: RequestInit) => {
  const r = await link.fetch(input, init);
  const buf = await r.arrayBuffer();
  net.http += buf.byteLength;
  net.httpWire += Number(r.headers.get("content-length") ?? 0);
  net.requests.push(`${new URL(String(input)).pathname} ${r.status} ${buf.byteLength} B (wire ${r.headers.get("content-length") ?? "?"}, ${r.headers.get("content-encoding") ?? "identity"})`);
  return new Response(buf, { status: r.status, headers: r.headers });
};
let wsOpenMs = 0;
class Socket extends link.WebSocket {
  constructor(address: string) {
    const t = performance.now();
    super(address);
    this.on("open", () => (wsOpenMs ||= ms(t)));
    this.on("message", (d: Buffer) => (net.ws += d.length));
  }
}
const idb = new IDBFactory();
const open = () => createSyncStore({ workspace: ws, baseUrl: values.url, indexedDB: idb, WebSocket: Socket as never, fetch: fetchAs, reload: () => {} });

// Cold: nothing on disk.
let t = performance.now();
let store = open();
await store.start();
const cold = ms(t);
await until(() => store.connection === "online", 20_000, "online", 5);
const coldOnline = ms(t);
const heap = Math.round(process.memoryUsage().heapUsed / 2 ** 20);
const counts = { issues: store.issues.size, projects: store.projects.size, users: store.users.size, labels: store.labels.size, states: store.states.size, cycles: store.cycles.size };
const coldNet = { ...net, requests: [...net.requests] };
const stats = { ...store.stats };

// The query the API runs for `planner my`, on the copy.
const me = store.me!.id;
const ctx = { states: store.states, labels: store.labels, users: store.users, cycles: store.cycles, projects: store.projects, me, issueKey: (i: { projectId: string; number: number }) => `${store.projects.get(i.projectId)?.key}-${i.number}` };
const live = [...store.issues.values()].filter((i) => !i.archivedAt && !i.deletedAt);
const times: number[] = [];
let found = 0;
for (let k = 0; k < 21; k++) {
  const tq = performance.now();
  const parsed = q.parseQuery("assignee:me -group:completed,cancelled", ctx as never);
  found = q.runQueryRows(live, parsed.filter, q.DEFAULT_DISPLAY, ctx as never).length;
  times.push(performance.now() - tq);
}
times.sort((a, b) => a - b);

// What the disk copy holds.
await store.persist();
const raw = await new Promise<{ key: string; bytes: number; type: string }[]>((resolve, reject) => {
  const r = idb.open(`rsva:${ws}`, 1);
  r.onsuccess = () => {
    const tx = r.result.transaction("kv", "readonly");
    const out: { key: string; bytes: number; type: string }[] = [];
    const cur = tx.objectStore("kv").openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve(out);
      const v = c.value as unknown;
      const bytes = typeof v === "string" ? Buffer.byteLength(v) : v instanceof ArrayBuffer ? v.byteLength : ArrayBuffer.isView(v) ? v.byteLength : Buffer.byteLength(JSON.stringify(v));
      out.push({ key: String(c.key), bytes, type: typeof v === "string" ? "string" : v?.constructor?.name ?? typeof v });
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  };
  r.onerror = () => reject(r.error);
});
store.dispose();

// Warm: the copy is there, only the changes since it come over the socket.
net.http = net.httpWire = net.ws = 0;
net.requests = [];
wsOpenMs = 0;
t = performance.now();
store = open();
await store.start();
const warm = ms(t);
await until(() => store.connection === "online", 20_000, "online", 5);
const warmOnline = ms(t);
const warmNet = { ...net };
store.dispose();

const snapshotJson = JSON.stringify([...live]);
console.log(
  JSON.stringify(
    {
      imports: { syncMs: tSync, queryMs: tQuery },
      counts,
      cold: { readyMs: cold, onlineMs: coldOnline, stats, net: coldNet, heapMB: heap },
      warm: { readyMs: warm, onlineMs: warmOnline, wsOpenMs, net: warmNet },
      query: { found, medianMs: times[10]!.toFixed(2), maxMs: times.at(-1)!.toFixed(2) },
      disk: raw.filter((r) => !r.key.startsWith("feed:")).concat([{ key: "feed:* count", bytes: raw.filter((r) => r.key.startsWith("feed:")).length, type: "" }]),
      issuesJson: { bytes: snapshotJson.length, gzip: gzipSync(snapshotJson).length },
    },
    null,
    2,
  ),
);
process.exit(0);
