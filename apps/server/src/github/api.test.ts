import assert from "node:assert/strict";
import { createPrivateKey, createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { appJwt, githubApi, githubConfig } from "./api.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

type Call = { url: string; method: string; auth: string; body?: string };

function fakeGithub(answer: (c: Call) => unknown) {
  const calls: Call[] = [];
  const f: typeof fetch = async (url, init) => {
    const c: Call = { url: String(url), method: init?.method ?? "GET", auth: (init?.headers as Record<string, string>).authorization!, ...(init?.body ? { body: String(init.body) } : {}) };
    calls.push(c);
    const a = answer(c);
    return a instanceof Response ? a : Response.json(a);
  };
  return { calls, f };
}

const tokenAnswer = { token: "ghs_1", expires_at: "2099-01-01T00:00:00Z" };

test("the App's JWT is signed with its key and lasts under ten minutes", () => {
  const now = 1_800_000_000_000;
  const [h, p, s] = appJwt("42", createPrivateKey(privateKey), now).split(".") as [string, string, string];
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, s, "base64url"));
  const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as { iat: number; exp: number; iss: string };
  assert.equal(claims.iss, "42");
  assert.ok(claims.iat < now / 1000 && claims.exp - claims.iat <= 600);
});

test("an installation's token is asked for once; lists are read to their end", async () => {
  const { calls, f } = fakeGithub((c) => {
    if (c.url.endsWith("/access_tokens")) return tokenAnswer;
    const page = Number(new URL(c.url).searchParams.get("page"));
    return Array.from({ length: page === 1 ? 100 : 7 }, () => ({ commit: { message: "m" } }));
  });
  const api = githubApi({ appId: "1", privateKey }, f);
  assert.equal((await api.pullCommits(9, "a/b", 3)).length, 107);
  await api.pullCommits(9, "a/b", 4);
  assert.equal(calls.filter((c) => c.url.endsWith("/access_tokens")).length, 1);
  const read = calls.find((c) => c.url.includes("/repos/a/b/pulls/3/commits"))!;
  assert.equal(read.auth, "Bearer ghs_1");
});

test("the comment is created once, then edited in place", async () => {
  const { calls, f } = fakeGithub((c) => (c.url.endsWith("/access_tokens") ? tokenAnswer : { id: 5 }));
  const api = githubApi({ appId: "1", privateKey }, f);
  assert.equal(await api.writeComment(9, "a/b", 3, null, "text"), 5);
  await api.writeComment(9, "a/b", 3, 5, "text");
  assert.deepEqual(
    calls.slice(1).map((c) => [c.method, new URL(c.url).pathname]),
    [["POST", "/repos/a/b/issues/3/comments"], ["PATCH", "/repos/a/b/issues/comments/5"]],
  );
});

test("a refused request fails that call, naming no secret", async () => {
  const { f } = fakeGithub(() => new Response("nope", { status: 401 }));
  await assert.rejects(githubApi({ appId: "1", privateKey }, f).appSlug(), /401 to GET \/app/);
});

test("a damaged key fails the call, not the start", async () => {
  const api = githubApi({ appId: "1", privateKey: "not a key" }, fakeGithub(() => ({})).f);
  await assert.rejects(api.appSlug());
});

test("the environment: line breaks as \\n", () => {
  assert.equal(githubConfig({ GITHUB_APP_PRIVATE_KEY: "a\\nb" }).privateKey, "a\nb");
  assert.deepEqual(githubConfig({}), { appId: null, privateKey: null, webhookSecret: null });
});
