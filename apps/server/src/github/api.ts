// GitHub's REST API as the App: a short JWT signed with the App's key, exchanged for an installation's token.
// `fetch` and the clock are parameters, so tests answer as GitHub would and no test reaches the network.
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import type { PullPayload } from "./events.ts";

/** What the server holds; null until the variable is set. */
export interface GithubConfig {
  appId: string | null;
  privateKey: string | null;
  webhookSecret: string | null;
}

/** GITHUB_APP_PRIVATE_KEY's line breaks may be written `\n`: an env file holds one line. */
export function githubConfig(env: NodeJS.ProcessEnv = process.env): GithubConfig {
  const key = env.GITHUB_APP_PRIVATE_KEY?.replaceAll("\\n", "\n");
  return { appId: env.GITHUB_APP_ID || null, privateKey: key?.trim() || null, webhookSecret: env.GITHUB_WEBHOOK_SECRET || null };
}

interface GithubRepoInfo {
  id: number;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
}

interface GithubInstallationInfo {
  id: number;
  account: string;
  accountType: string;
  suspended: boolean;
}

interface GithubCommit {
  sha: string;
  message: string;
  author: string;
  at: string;
}

/** What the integration asks GitHub. Tests pass their own. */
export interface GithubApi {
  appSlug(): Promise<string>;
  installations(): Promise<GithubInstallationInfo[]>;
  repositories(installationId: number): Promise<GithubRepoInfo[]>;
  /** The messages of a pull request's commits, its first 250 as GitHub lists them. */
  pullCommits(installationId: number, repo: string, number: number): Promise<string[]>;
  /** A pull request as a webhook carries it, and its reviews and head's check runs: for one no webhook told us about. */
  pull(installationId: number, repo: string, number: number): Promise<PullPayload>;
  pullReviews(installationId: number, repo: string, number: number): Promise<{ state: string; user: { login: string } | null; author_association?: string }[]>;
  checkRuns(installationId: number, repo: string, sha: string): Promise<{ name: string; status: string; conclusion: string | null }[]>;
  commit(installationId: number, repo: string, sha: string): Promise<GithubCommit>;
  /** Writes the App's comment on a pull request, the existing one when `commentId` is given, and returns its id. */
  writeComment(installationId: number, repo: string, number: number, commentId: number | null, body: string): Promise<number>;
}

const API = "https://api.github.com";
const PAGE = 100;
/** A webhook is answered within GitHub's ten seconds, so one request may not take them all. */
const TIMEOUT_MS = 5000;

const base64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

export function appJwt(appId: string, key: KeyObject, now = Date.now()): string {
  const s = Math.floor(now / 1000);
  // A minute back for clock drift; GitHub takes ten minutes at most.
  const unsigned = `${base64url('{"alg":"RS256","typ":"JWT"}')}.${base64url(JSON.stringify({ iat: s - 60, exp: s + 540, iss: appId }))}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key, "base64url")}`;
}

export function githubApi(cfg: { appId: string; privateKey: string }, fetchFn: typeof fetch = fetch): GithubApi {
  // Parsed on first use: a damaged key fails that call, which reports it, and never the server's start.
  let parsed: KeyObject | undefined;
  const jwt = () => appJwt(cfg.appId, (parsed ??= createPrivateKey(cfg.privateKey)));
  const tokens = new Map<number, { token: string; until: number }>();

  async function request(path: string, auth: string, init?: { method: string; body: unknown }): Promise<unknown> {
    const r = await fetchFn(`${API}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${auth}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "rsva",
        ...(init ? { "content-type": "application/json" } : {}),
      },
      ...(init ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`GitHub answered ${r.status} to ${init?.method ?? "GET"} ${path}`);
    return r.json();
  }

  const asApp = (path: string) => request(path, jwt());

  async function token(installationId: number): Promise<string> {
    const had = tokens.get(installationId);
    if (had && had.until > Date.now()) return had.token;
    const t = (await request(`/app/installations/${installationId}/access_tokens`, jwt(), { method: "POST", body: {} })) as { token: string; expires_at: string };
    tokens.set(installationId, { token: t.token, until: Date.parse(t.expires_at) - 60_000 });
    return t.token;
  }

  async function pages<T>(path: string, auth: string, list: (page: unknown) => T[], max: number): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; out.length < max; page++) {
      const got = list(await request(`${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE}&page=${page}`, auth));
      out.push(...got);
      if (got.length < PAGE) break;
    }
    return out.slice(0, max);
  }

  return {
    appSlug: async () => ((await asApp("/app")) as { slug: string }).slug,
    installations: () =>
      pages(
        "/app/installations",
        jwt(),
        (page) =>
          (page as { id: number; account: { login: string; type: string }; suspended_at: string | null }[]).map((i) => ({
            id: i.id,
            account: i.account.login,
            accountType: i.account.type,
            suspended: !!i.suspended_at,
          })),
        1000,
      ),
    repositories: async (installationId) =>
      pages(
        "/installation/repositories",
        await token(installationId),
        (page) =>
          (page as { repositories: { id: number; full_name: string; default_branch: string; private: boolean }[] }).repositories.map((r) => ({
            id: r.id,
            fullName: r.full_name,
            defaultBranch: r.default_branch,
            isPrivate: r.private,
          })),
        5000,
      ),
    pullCommits: async (installationId, repo, number) =>
      pages(`/repos/${repo}/pulls/${number}/commits`, await token(installationId), (page) => (page as { commit: { message: string } }[]).map((c) => c.commit.message), 250),
    pull: async (installationId, repo, number) => (await request(`/repos/${repo}/pulls/${number}`, await token(installationId))) as PullPayload,
    pullReviews: async (installationId, repo, number) => pages(`/repos/${repo}/pulls/${number}/reviews`, await token(installationId), (page) => page as { state: string; user: { login: string } | null }[], 1000),
    checkRuns: async (installationId, repo, sha) =>
      pages(`/repos/${repo}/commits/${sha}/check-runs`, await token(installationId), (page) => (page as { check_runs: { name: string; status: string; conclusion: string | null }[] }).check_runs, 1000),
    commit: async (installationId, repo, sha) => {
      const c = (await request(`/repos/${repo}/commits/${sha}`, await token(installationId))) as { sha: string; author: { login: string } | null; commit: { message: string; author: { name: string; date: string } } };
      return { sha: c.sha, message: c.commit.message, author: c.author?.login ?? c.commit.author.name, at: c.commit.author.date };
    },
    writeComment: async (installationId, repo, number, commentId, body) => {
      const auth = await token(installationId);
      const c = commentId
        ? await request(`/repos/${repo}/issues/comments/${commentId}`, auth, { method: "PATCH", body: { body } })
        : await request(`/repos/${repo}/issues/${number}/comments`, auth, { method: "POST", body: { body } });
      return (c as { id: number }).id;
    },
  };
}

export const githubFromEnv = (cfg: GithubConfig = githubConfig()): GithubApi | null =>
  cfg.appId && cfg.privateKey ? githubApi({ appId: cfg.appId, privateKey: cfg.privateKey }) : null;
