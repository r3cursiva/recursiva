import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { addMember, asToken, asUser, fetchAs, importFixture, issueWithRefs, startServer, type Fixture } from "../test/helpers.ts";
import { dispositionName } from "./routes.ts";
import { fileType, imageSize, sniffImage } from "./sniff.ts";
import { avif, gif, jpeg, png, u24le, webp } from "../test/images.ts";
import { DiskBlobStore } from "./store.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let dir: string;
let ws: Fixture;
let other: Fixture;
let owner: typeof fetch;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "rsva-files-"));
  [server, ws, other] = await Promise.all([startServer({ blobs: new DiskBlobStore(dir) }), importFixture(), importFixture()]);
  owner = fetchAs(await asUser(ws.ownerId));
});
after(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const PNG = png(64, 64, "rest of a png");
const fileUrl = (slug: string, hash: string) => `${server.url}/files/${slug}/${hash}`;
const put = (f: typeof fetch, slug: string, body: Buffer, type = "application/octet-stream", hash = sha(body)) =>
  f(fileUrl(slug, hash), { method: "PUT", body, headers: { "content-type": type } });

test("upload, then read: the bytes back, cached forever, an image inline", async () => {
  const h = sha(PNG);
  assert.equal((await owner(fileUrl(ws.slug, h), { method: "HEAD" })).status, 404, "nothing yet");
  const up = await put(owner, ws.slug, PNG, "image/png");
  assert.equal(up.status, 201, await up.clone().text());
  assert.deepEqual(await up.json(), { ok: true, sha256: h, size: PNG.length, mime: "image/png" });

  const head = await owner(fileUrl(ws.slug, h), { method: "HEAD" });
  assert.equal(head.status, 200);
  const r = await owner(fileUrl(ws.slug, h));
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.match(r.headers.get("content-disposition")!, /^inline;/);
  assert.match(r.headers.get("cache-control")!, /immutable/);
  assert.match(r.headers.get("content-security-policy")!, /^sandbox;/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await owner(fileUrl(ws.slug, h), { headers: { "if-none-match": `"${h}"` } })).status, 304);

  const part = await owner(fileUrl(ws.slug, h), { headers: { range: "bytes=1-3" } });
  assert.equal(part.status, 206);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), PNG.subarray(1, 4));
  assert.equal(part.headers.get("content-range"), `bytes 1-3/${PNG.length}`);
  assert.equal((await owner(fileUrl(ws.slug, h), { headers: { range: "bytes=99-" } })).status, 416);
});

test("a second upload of the same file sends nothing: HEAD says it is there, PUT answers 200", async () => {
  const body = Buffer.from("same bytes twice");
  assert.equal((await put(owner, ws.slug, body)).status, 201);
  assert.equal((await owner(fileUrl(ws.slug, sha(body)), { method: "HEAD" })).status, 200);
  assert.equal((await put(owner, ws.slug, body)).status, 200);
});

test("bytes that do not hash to the address are refused and not kept", async () => {
  const r = await put(owner, ws.slug, Buffer.from("these bytes"), "text/plain", sha(Buffer.from("other bytes")));
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { error: string }).error, "hash_mismatch");
  assert.equal((await owner(fileUrl(ws.slug, sha(Buffer.from("other bytes"))), { method: "HEAD" })).status, 404);
});

test("only members: another workspace's member and a signed-out request get 404, a read-only token cannot upload", async () => {
  const body = Buffer.from("members only");
  await put(owner, ws.slug, body);
  const stranger = fetchAs(await asUser(other.ownerId));
  assert.equal((await stranger(fileUrl(ws.slug, sha(body)))).status, 404);
  assert.equal((await fetch(fileUrl(ws.slug, sha(body)))).status, 404);
  // Dedupe stays inside a workspace: the other workspace does not see the file, and uploads its own copy.
  assert.equal((await stranger(fileUrl(other.slug, sha(body)), { method: "HEAD" })).status, 404);
  assert.equal((await put(stranger, other.slug, body)).status, 201);
  assert.equal((await put(fetch, ws.slug, Buffer.from("anon"))).status, 404);

  const reader = fetchAs(await asToken(ws.workspaceId, ws.agentId, "read"));
  assert.equal((await reader(fileUrl(ws.slug, sha(body)))).status, 200);
  assert.equal((await put(reader, ws.slug, Buffer.from("from a read token"))).status, 403);
  const guest = await addMember(ws.workspaceId, "guest");
  assert.equal((await fetchAs(await asUser(guest.id))(fileUrl(ws.slug, sha(body)))).status, 404);
});

test("HTML and SVG download and do not run; a fake PNG is not an image", async () => {
  const html = Buffer.from("<script>alert(1)</script>");
  await put(owner, ws.slug, html, "text/html");
  const r = await owner(`${fileUrl(ws.slug, sha(html))}?name=${encodeURIComponent("page.html")}`);
  assert.equal(r.headers.get("content-type"), "application/octet-stream");
  assert.match(r.headers.get("content-disposition")!, /^attachment; filename="page.html"/);
  assert.match(r.headers.get("content-security-policy")!, /^sandbox;/);

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  await put(owner, ws.slug, svg, "image/svg+xml");
  const s = await owner(fileUrl(ws.slug, sha(svg)));
  assert.equal(s.headers.get("content-type"), "application/octet-stream");
  assert.match(s.headers.get("content-disposition")!, /^attachment;/);

  const fake = Buffer.from("<html>not a png</html>");
  const up = await put(owner, ws.slug, fake, "image/png");
  assert.equal(((await up.json()) as { mime: string }).mime, "application/octet-stream");
});

test("nothing uploaded is served as a type a browser runs or applies: scripts and styles come back as downloads (RSVA-610)", async () => {
  for (const type of ["text/javascript", "application/javascript", "text/css", "application/wasm", "application/x-ecmascript"]) {
    const body = Buffer.from(`/* ${type} */ fetch("/sync")`);
    const up = await put(owner, ws.slug, body, type);
    assert.equal(up.status, 201);
    for (const method of ["GET", "HEAD"]) {
      const r = await owner(fileUrl(ws.slug, sha(body)), { method });
      assert.equal(r.headers.get("content-type"), "application/octet-stream", `${type} ${method}`);
      assert.match(r.headers.get("content-disposition")!, /^attachment;/);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.match(r.headers.get("content-security-policy")!, /^sandbox;/);
    }
  }
  // The declared type stays as the file's name for it, for the list of files and the agent API.
  const pdf = Buffer.from("%PDF-1.7 kept");
  assert.equal(((await (await put(owner, ws.slug, pdf, "application/pdf")).json()) as { mime: string }).mime, "application/pdf");
  assert.equal((await owner(fileUrl(ws.slug, sha(pdf)))).headers.get("content-type"), "application/octet-stream");
});

test("an image that says it has too many pixels is stored as a download, one that fits stays inline (RSVA-604)", async () => {
  const cases: [string, Buffer, string][] = [
    ["PNG bomb, 30000 × 30000", png(30000, 30000), "application/octet-stream"],
    ["WebP bomb, 16383 × 16383", webp("VP8X", Buffer.concat([Buffer.alloc(4), u24le(16382), u24le(16382)])), "application/octet-stream"],
    ["JPEG bomb, 65535 × 65535", jpeg(65535, 65535), "application/octet-stream"],
    ["GIF bomb, 65535 × 65535", gif(65535, 65535), "application/octet-stream"],
    ["no size to read", Buffer.concat([png(1, 1).subarray(0, 20)]), "application/octet-stream"],
    ["8K screen, 7680 × 4320", png(7680, 4320), "image/png"],
    ["full-page screenshot, 1440 × 60000", png(1440, 60000), "image/png"],
    ["50 MP phone photo, 8160 × 6120", jpeg(8160, 6120, Buffer.concat(Array.from({ length: 5 }, () => Buffer.concat([Buffer.from([0xff, 0xe1, 0xea, 0x62]), Buffer.alloc(60_000)])))), "image/jpeg"],
    ["GIF, 800 × 600", gif(800, 600), "image/gif"],
    ["animated-style GIF with an extension block and a local colour table", gif(800, 600, [10, 10, 500, 400], true), "image/gif"],
    ["GIF with a 1 × 1 screen and a 65535 × 65535 first frame", gif(1, 1, [0, 0, 65535, 65535]), "application/octet-stream"],
    ["GIF with a frame pushed out by its offset", gif(100, 100, [60000, 60000, 100, 100]), "application/octet-stream"],
    ["GIF cut off before any frame", gif(800, 600).subarray(0, 14), "application/octet-stream"],
    ["AVIF, 4000 × 3000", avif([4000, 3000]), "image/avif"],
    ["AVIF with a thumbnail and tiles before the canvas", avif([160, 120], [512, 512], [8000, 6000]), "image/avif"],
    ["AVIF bomb, 30000 × 30000", avif([30000, 30000]), "application/octet-stream"],
    ["AVIF bomb behind a small first ispe", avif([160, 120], [30000, 30000]), "application/octet-stream"],
    ["AVIF with no ispe", avif(), "application/octet-stream"],
  ];
  for (const [name, body, mime] of cases) {
    const salted = Buffer.concat([body, Buffer.from(name)]);
    const up = await put(owner, ws.slug, salted, "image/png");
    assert.equal(((await up.json()) as { mime: string }).mime, mime, name);
    const r = await owner(fileUrl(ws.slug, sha(salted)));
    assert.equal(r.headers.get("content-type"), mime, name);
    assert.match(r.headers.get("content-disposition")!, mime === "application/octet-stream" ? /^attachment;/ : /^inline;/, name);
  }
});

test("size: a file over the limit is refused from its Content-Length, before its bytes", async () => {
  const { request } = await import("node:http");
  const headers = { ...(await asUser(ws.ownerId)), "content-length": String(26 * 2 ** 20) };
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(fileUrl(ws.slug, "a".repeat(64)), { method: "PUT", headers }, (res) => {
      resolve(res.statusCode!);
      // The body never comes: left open, this connection holds the server's close for over a minute (PLNR-158).
      req.destroy();
    });
    req.on("error", reject);
    req.write(Buffer.alloc(1024)); // a start of the body; the answer comes without the rest
  });
  assert.equal(status, 413);
});

test("a file on an issue: through the sync pipeline and the agent API, by its hash; its bytes must be uploaded first", async () => {
  const body = Buffer.from("%PDF-1.7 a report");
  const h = sha(body);
  const { issue, project } = await issueWithRefs(ws.workspaceId);
  const agent = fetchAs({ ...(await asToken(ws.workspaceId, ws.agentId)), "content-type": "application/json" });
  const api = (p: string) => `${server.url}/api/v1/workspaces/${ws.slug}/issues/${project.key}-${issue.number}${p}`;

  const early = await agent(api("/files"), { method: "POST", body: JSON.stringify({ sha256: h, name: "report.pdf" }) });
  assert.equal(early.status, 400);
  assert.equal(((await early.json()) as { error: string }).error, "bad_ref");

  assert.equal((await put(agent, ws.slug, body, "application/pdf")).status, 201);
  const made = await agent(api("/files"), { method: "POST", body: JSON.stringify({ sha256: h, name: "report.pdf" }) });
  assert.equal(made.status, 201, await made.clone().text());
  const { id } = (await made.json()) as { id: string };
  const view = (await (await agent(api(""))).json()) as { files: { id: string; name: string; size: number; mime: string; url: string }[]; links: unknown[] };
  assert.deepEqual(
    view.files.map(({ id, name, size, mime, url }) => ({ id, name, size, mime, url })),
    [{ id, name: "report.pdf", size: body.length, mime: "application/pdf", url: `/files/${ws.slug}/${h}` }],
  );
  assert.ok(!view.links.some((l) => (l as { id: string }).id === id), "files are not links");

  assert.equal((await agent(api(`/links/${id}`), { method: "DELETE" })).status, 404, "not a link");
  assert.equal((await agent(api(`/files/${id}`), { method: "DELETE" })).status, 200);
  const after = (await (await agent(api(""))).json()) as { files: unknown[] };
  assert.equal(after.files.length, 0);
  // The bytes stay: an image in a description may still show them.
  assert.equal((await agent(fileUrl(ws.slug, h), { method: "HEAD" })).status, 200);
});

test("sniffing: images by their first bytes only", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImage(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffImage(Buffer.from("<svg")), null);
  assert.equal(fileType(Buffer.from("x"), "Application/PDF; charset=x"), "application/pdf");
  assert.equal(fileType(Buffer.from("x"), "image/jpeg"), "application/octet-stream");
  assert.equal(fileType(Buffer.from("x"), "not a type"), "application/octet-stream");
});

test("download names: ASCII fallback and the UTF-8 name, no quotes or path", () => {
  assert.equal(dispositionName('a"b;/c.txt'), `filename="a_b_c.txt"; filename*=UTF-8''a%22b%3Bc.txt`);
  assert.equal(dispositionName("отчёт.pdf"), `filename="_____.pdf"; filename*=UTF-8''${encodeURIComponent("отчёт.pdf")}`);
  assert.equal(dispositionName(""), `filename="file"; filename*=UTF-8''file`);
});

test("the disk store keeps nothing of a refused upload", async () => {
  const s = new DiskBlobStore(dir);
  const { Readable } = await import("node:stream");
  await assert.rejects(s.put("x", sha(Buffer.from("big")), Readable.from([Buffer.from("big")]), 2), /at most 2 bytes/);
  assert.equal(await s.has("x", sha(Buffer.from("big"))), false);
});

test("imageSize reads PNG, JPEG and the three kinds of WebP from their headers", () => {
  assert.deepEqual(imageSize(png(256, 128)), { width: 256, height: 128 });
  assert.deepEqual(imageSize(jpeg(640, 480)), { width: 640, height: 480 });
  // Lossy: a frame tag, the start code, then 14-bit sizes.
  assert.deepEqual(imageSize(webp("VP8 ", Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 0, 1, 0x80, 0]))), { width: 256, height: 128 });
  // Lossless: the signature, then width-1 and height-1 in 14 bits each.
  const bits = 255 | (127 << 14);
  assert.deepEqual(imageSize(webp("VP8L", Buffer.from([0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, bits >>> 24, 0, 0, 0, 0, 0]))), { width: 256, height: 128 });
  // Extended: flags, then width-1 and height-1 in 24 bits each; a bomb is just as short.
  assert.deepEqual(imageSize(webp("VP8X", Buffer.concat([Buffer.alloc(4), u24le(16382), u24le(16382)]))), { width: 16383, height: 16383 });
  assert.deepEqual(imageSize(gif(800, 600)), { width: 800, height: 600 });
  assert.deepEqual(imageSize(gif(1, 1, [0, 0, 640, 480], true)), { width: 640, height: 480 });
  assert.deepEqual(imageSize(avif([160, 120], [4000, 3000], [512, 512])), { width: 4000, height: 3000 });
  // An image sequence (brand avis, major or compatible) plays its track, whose size no ispe states: no size, a download.
  for (const at of [8, 20]) {
    const sequence = avif([160, 120]);
    sequence.write("avis", at, "latin1");
    assert.equal(imageSize(sequence), null);
    assert.equal(fileType(sequence, "image/avif"), "application/octet-stream");
  }
  assert.equal(imageSize(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(imageSize(png(1, 1).subarray(0, 20)), null);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3])), null);
  // The JPEG walk refuses what a decoder would read differently: a marker without a length shifting it onto a fake SOF
  // inside an APP segment (the security review's file: 16 × 16 here, 4096 × 4096 to libjpeg), a second SOF, no scan.
  const fakeSof = Buffer.concat([Buffer.from([0xff, 0xc0, 0, 19, 8, 0, 16, 0, 16]), Buffer.alloc(12)]);
  const app12 = Buffer.concat([Buffer.from([0xff, 0xec, 0, 2 + fakeSof.length + 4]), Buffer.alloc(4), fakeSof]);
  assert.equal(imageSize(jpeg(4096, 4096, Buffer.concat([Buffer.from([0xff, 0xd0]), app12]))), null);
  assert.deepEqual(imageSize(jpeg(4096, 4096, app12)), { width: 4096, height: 4096 });
  assert.equal(imageSize(jpeg(64, 64, fakeSof)), null);
  assert.equal(imageSize(jpeg(64, 64).subarray(0, 40)), null);
  assert.equal(imageSize(jpeg(64, 0)), null);
});
