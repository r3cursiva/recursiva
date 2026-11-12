// node apps/web/src/lib/search.bench.ts: the palette search on 10 000 synthetic issues (see @rsva/display search.ts for the comparison).
import { buildIndex, search } from "@rsva/display/search";

const WORDS = "beacon caddy deploy backup postgres tailscale review security owner rotate key plane board list sync server client".split(" ");
let seed = 1;
const rnd = (n: number) => (seed = (seed * 16807) % 2147483647) % n;
const issues = Array.from({ length: 10_000 }, (_, i) => ({
  key: `${["INFRA", "LAS", "PLANE", "OPTO"][i % 4]}-${i + 1}`,
  title: Array.from({ length: 5 + rnd(8) }, () => WORDS[rnd(WORDS.length)]).join(" "),
}));

const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1]!;
const builds: number[] = [];
let docs = buildIndex(issues, (i) => i.key, (i) => i.title);
for (let r = 0; r < 20; r++) {
  const t = performance.now();
  docs = buildIndex(issues, (i) => i.key, (i) => i.title);
  builds.push(performance.now() - t);
}
const queries = ["infra-1", "caddy", "postgres backup", "zzz", "rev", "plane-4242", "s", "security owner rotate"];
const times: number[] = [];
for (let r = 0; r < 50; r++)
  for (const q of queries) {
    const t = performance.now();
    search(docs, q);
    times.push(performance.now() - t);
  }

// The alternative: one joined string, indexOf, offsets mapped back to issues (one word, first 50 hits).
const joined = docs.map((d) => d.hay).join("\n");
const starts: number[] = [];
for (let i = 0, at = 0; i < docs.length; i++) {
  starts.push(at);
  at += docs[i]!.hay.length + 1;
}
const joinedTimes: number[] = [];
for (let r = 0; r < 50; r++)
  for (const q of ["caddy", "rev", "zzz", "infra-1"]) {
    const t = performance.now();
    const out: number[] = [];
    for (let at = joined.indexOf(q); at >= 0 && out.length < 50; at = joined.indexOf(q, at + 1)) {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if (starts[m]! <= at) lo = m;
        else hi = m - 1;
      }
      if (out.at(-1) !== lo) out.push(lo);
    }
    joinedTimes.push(performance.now() - t);
  }
console.log(
  `build index: ${median(builds).toFixed(2)} ms; array search: median ${median(times).toFixed(3)} ms, max ${Math.max(...times).toFixed(3)} ms; ` +
    `joined string indexOf (one word, first 50): median ${median(joinedTimes).toFixed(3)} ms`,
);
