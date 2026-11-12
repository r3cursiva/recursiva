// The webhook GitHub calls and the settings page's answer. The webhook has no session: the signature over the raw body is
// its whole authentication, checked before anything of the body is believed.
import { createHmac, timingSafeEqual } from "node:crypto";
import { can } from "@rsva/policy";
import type { GithubStatus } from "@rsva/protocol";
import { and, countDistinct, desc, eq, gte, inArray, isNotNull, lt, sql as dsql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accessBySlug, granted } from "../auth/access.ts";
import { requireActor } from "../auth/routes.ts";
import { db, schema } from "../db.ts";
import { githubConfig, githubFromEnv, type GithubApi, type GithubConfig } from "./api.ts";
import { handleEvent, type Payload } from "./events.ts";
import { rawWebhook } from "../webhook.ts";

const { githubDelivery, githubInstallation, githubLink, githubRepo, issue, project } = schema;

/** GitHub caps a payload at 25 MiB, but nothing we read is that big, and this is read before the signature is checked. */
const BODY_MAX = 8 * 2 ** 20;
const KEEP_DAYS = 30;
const APP_CHECK_MS = 5 * 60_000;

export function validSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const want = createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(header.slice(7), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface GithubRouteOptions {
  config?: GithubConfig;
  api?: GithubApi | null;
}

export function registerGithub(root: FastifyInstance, opts: GithubRouteOptions = {}): void {
  const config = opts.config ?? githubConfig();
  const api = opts.api !== undefined ? opts.api : githubFromEnv(config);

  void root.register(async (app) => {
    // Without its secret the integration is off: there is no such path, and nothing here reads a body.
    if (!config.webhookSecret) return;
    app.post("/api/github/webhook", rawWebhook(app, BODY_MAX), (req, reply) => webhook(req, reply, config.webhookSecret!, api));
  });

  let appCheck: { slug: string | null; error: string | null; checkedAt: string; until: number } | null = null;
  const checkApp = async () => {
    if (appCheck && appCheck.until > Date.now()) return appCheck;
    const now = new Date();
    let slug: string | null = null;
    let error: string | null = null;
    try {
      slug = (await api?.appSlug()) ?? null;
    } catch {
      error = "GitHub refused the App's key, or could not be reached";
    }
    appCheck = { slug, error, checkedAt: now.toISOString(), until: now.getTime() + APP_CHECK_MS };
    return appCheck;
  };

  void root.register(async (app) => {
    app.get<{ Params: { ws: string } }>("/api/v1/workspaces/:ws/github", { preHandler: requireActor({ sessionOnly: true }) }, async (req, reply) => {
      const a = granted(await accessBySlug(req.actor!, req.params.ws));
      if (!can(a.viewer, "workspace.write")) return reply.code(403).send({ error: "forbidden", message: `a ${a.role} cannot see the integration's state` });
      const { until: _, ...check } = await checkApp();
      return status(a.workspaceId, config, check);
    });
  });
}

async function webhook(req: FastifyRequest, reply: FastifyReply, secret: string, api: GithubApi | null) {
  const body = req.body as Buffer | null;
  const id = req.headers["x-github-delivery"];
  const event = req.headers["x-github-event"];
  if (!Buffer.isBuffer(body) || typeof id !== "string" || typeof event !== "string") return reply.code(400).send({ error: "invalid", message: "not a GitHub delivery" });
  const signature = req.headers["x-hub-signature-256"];
  if (!validSignature(secret, body, typeof signature === "string" ? signature : undefined)) {
    // Nothing of an unsigned body is believed, not even which repository it names: anyone can name any, and would then
    // show a false alarm to that workspace. The mismatch of secrets is for the operator, in the log (and GitHub's own
    // delivery list, which shows the 401).
    const word = /^[a-z_]{1,40}$/.test(event) ? event : "unknown";
    req.log.warn({ delivery: id.slice(0, 100), event: word }, "GitHub webhook with a bad signature");
    return reply.code(401).send({ error: "unauthorized", message: "signature does not match" });
  }
  let payload: Payload;
  try {
    payload = JSON.parse(body.toString("utf8")) as Payload;
  } catch {
    return reply.code(400).send({ error: "invalid", message: "the body is not JSON" });
  }
  if (event === "ping") return { ok: true };

  const name = payload.action ? `${event}.${payload.action}` : event;
  const repoId = payload.repository?.id ?? null;
  const repoName = payload.repository?.full_name ?? null;
  // A delivery answered well is not applied again; a failed one is, which is what GitHub's Redeliver is for, and so is
  // one a stopped server never finished.
  const [claimedRow] = await db
    .insert(githubDelivery)
    .values({ id, event: name, repoId, repoName })
    .onConflictDoUpdate({ target: githubDelivery.id, set: { status: 0, error: null, createdAt: dsql`now()` }, where: dsql`${githubDelivery.status} >= 400 or (${githubDelivery.status} = 0 and ${githubDelivery.createdAt} < now() - interval '1 minute')` })
    .returning({ id: githubDelivery.id });
  if (!claimedRow) return { ok: true, duplicate: true };

  const finish = (status: number, error: string | null, workspaceId: string | null) => db.update(githubDelivery).set({ status, error, workspaceId }).where(eq(githubDelivery.id, id));
  try {
    const { repo, ignored } = await handleEvent({ api, log: req.log }, event, payload);
    await finish(200, ignored ?? null, repo?.workspaceId ?? null);
    if (repo) await db.update(githubRepo).set({ lastDeliveryAt: dsql`now()`, lastError: ignored ?? null, lastErrorAt: ignored ? dsql`now()` : null }).where(eq(githubRepo.id, repo.id));
    await db.delete(githubDelivery).where(lt(githubDelivery.createdAt, dsql`now() - make_interval(days => ${KEEP_DAYS})`));
    return { ok: true };
  } catch (e) {
    req.log.error({ err: e, delivery: id, event: name }, "GitHub webhook failed");
    const message = "The server could not apply this delivery";
    const [r] = repoId ? await db.update(githubRepo).set({ lastError: message, lastErrorAt: dsql`now()` }).where(eq(githubRepo.id, repoId)).returning({ ws: githubRepo.workspaceId }) : [];
    await finish(500, message, r?.ws ?? null);
    return reply.code(500).send({ error: "internal", message });
  }
}

async function status(workspaceId: string, config: GithubConfig, app: { slug: string | null; error: string | null; checkedAt: string }): Promise<GithubStatus> {
  const [{ n: installs } = { n: 0 }] = await db.select({ n: countDistinct(githubInstallation.id) }).from(githubInstallation);
  const setup = { appId: !!config.appId, privateKey: !!config.privateKey, webhookSecret: !!config.webhookSecret, installed: installs > 0 };
  if (!Object.values(setup).every(Boolean)) return { setup, app: { slug: null, error: null, checkedAt: null }, installations: [], lastDelivery: null, lastError: null, repositories: [] };

  const repos = await db.select().from(githubRepo).where(eq(githubRepo.workspaceId, workspaceId)).orderBy(githubRepo.fullName);
  const ids = repos.map((r) => r.id);
  const [installations, projects, reached, last, failed] = await Promise.all([
    db
      .select()
      .from(githubInstallation)
      .where(inArray(githubInstallation.id, repos.map((r) => r.installationId).filter((i) => i !== null))),
    db.select({ id: project.id, key: project.key }).from(project).where(eq(project.workspaceId, workspaceId)),
    ids.length
      ? db
          .selectDistinct({ repoId: githubLink.repoId, key: project.key })
          .from(githubLink)
          .innerJoin(issue, eq(issue.id, githubLink.issueId))
          .innerJoin(project, eq(project.id, issue.projectId))
          .where(and(inArray(githubLink.repoId, ids), eq(githubLink.workspaceId, workspaceId)))
      : [],
    db.select().from(githubDelivery).where(and(eq(githubDelivery.workspaceId, workspaceId), gte(githubDelivery.status, 200))).orderBy(desc(githubDelivery.createdAt)).limit(1),
    db.select().from(githubDelivery).where(and(eq(githubDelivery.workspaceId, workspaceId), isNotNull(githubDelivery.error))).orderBy(desc(githubDelivery.createdAt)).limit(1),
  ]);
  const view = (d: typeof githubDelivery.$inferSelect) => ({ id: d.id, event: d.event, repo: d.repoName, at: d.createdAt, status: d.status, error: d.error });
  const keyOf = new Map(projects.map((p) => [p.id, p.key]));
  const suspended = new Set(installations.filter((i) => i.suspendedAt).map((i) => i.id));
  return {
    setup,
    app,
    installations: installations.map((i) => ({
      id: i.id,
      account: i.account,
      type: i.accountType,
      repositories: repos.filter((r) => r.installationId === i.id).length,
      installedAt: i.createdAt,
      installedBy: i.installedBy,
      suspended: !!i.suspendedAt,
    })),
    lastDelivery: last[0] ? view(last[0]) : null,
    lastError: failed[0] ? view(failed[0]) : null,
    repositories: repos.map((r) => ({
      name: r.fullName,
      projects: r.projectIds.length ? r.projectIds.flatMap((id) => keyOf.get(id) ?? []) : [...new Set(reached.filter((x) => x.repoId === r.id).map((x) => x.key))],
      defaultBranch: r.defaultBranch,
      enabled: r.enabled,
      lastDeliveryAt: r.lastDeliveryAt,
      error: r.installationId && suspended.has(r.installationId) ? "Installation suspended" : r.lastError,
    })),
  };
}
