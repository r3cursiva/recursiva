// The HTTP and WebSocket server without listening: main.ts starts it, tests drive it on a random port.
import { projectPulls } from "./github/pull.ts";
import { STATUS_CODES, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { createBrotliDecompress } from "node:zlib";
import { CLOSE_UNAUTHORIZED, FEEDS_MAX_IDS, HISTORY_LEVELS, MAX_FRAME_BYTES, VIEWER_HEADERS, isHistoryLevel, settingsHeaders, type WorkspaceListItem } from "@rsva/protocol";
import { UUID } from "@rsva/schema/models";
import { count, eq, inArray } from "drizzle-orm";
import proxyaddr from "@fastify/proxy-addr";
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { WebSocketServer } from "ws";
import { registerAgentApi } from "./api.ts";
import { registerGithub, type GithubRouteOptions } from "./github/routes.ts";
import { registerFileRoutes } from "./files/routes.ts";
import { registerPictureRoutes } from "./auth/picture.ts";
import { blobStoreFromEnv, type BlobStore } from "./files/store.ts";
import { accessById, accessBySlug, granted, workspacesOf } from "./auth/access.ts";
import { canonicalZone, readSettings } from "./auth/account.ts";
import { RateLimited } from "./auth/limits.ts";
import { authenticate, authenticateFrom, needsOrigin } from "./auth/actor.ts";
import { mailerFromEnv, PUBLIC_ORIGIN, type Mailer } from "./auth/mail.ts";
import { inboundFromEnv, registerInbound, type InboundConfig } from "./mail/inbound.ts";
import { registerNotifyRoutes } from "./notify/prefs.ts";
import { telegramFromEnv, type TelegramApi } from "./telegram/api.ts";
import { registerTelegram, type TelegramOptions } from "./telegram/routes.ts";
import { registerUnsubscribe } from "./notify/unsubscribe.ts";
import { registerWaitlist } from "./waitlist.ts";
import { WaitlistNotifier } from "./telegram/waitlist.ts";
import { registerDigestExample } from "./notify/digest.ts";
import { registerAuthRoutes, requireActor } from "./auth/routes.ts";
import { compressJsonResponses, compressStream, pickEncoding } from "./compress.ts";
import { db, schema } from "./db.ts";
import { guardConfig, rejectStatus, type GuardConfig } from "./guard.ts";
import { securityHeaders } from "./headers.ts";
import { hasNul, HttpError, redactUrl, txStatus } from "./http.ts";
import { pickVariant, type StaticFile } from "./static.ts";
import { readFeeds } from "./sync/feeds.ts";
import { readHistory, metered } from "./sync/history.ts";
import { readCycleProgress } from "./sync/cycles.ts";
import { readProjectHistory } from "./sync/project-history.ts";
import { bootstraps } from "./sync/limits.ts";
import { isServerTime } from "./sync/log.ts";
import { transient } from "./sync/retry.ts";
import { brotliSnapshot } from "./sync/snapshot-cache.ts";
import { handleSocket } from "./sync/socket.ts";
import { TxError } from "./sync/tx-error.ts";
import { registerWorkspaceApi } from "./workspaces.ts";


export interface AppOptions {
  files?: Map<string, StaticFile>;
  guard?: GuardConfig;
  logLevel?: string;
  /** Where the log goes instead of stdout: the tests read it. */
  logStream?: { write(line: string): void };
  /** Sign-in codes go out through it; by default Resend or, on a loopback-only server, the log (auth/mail.ts). */
  mailer?: Mailer;
  /** Where uploaded files go; by default RSVA_FILES_DIR (files/store.ts). */
  blobs?: BlobStore;
  /** The GitHub integration's settings; by default from the environment (github/api.ts). */
  github?: GithubRouteOptions;
  /** The Telegram bot; by default TELEGRAM_BOT_TOKEN's (telegram/api.ts), none without it. */
  telegram?: TelegramOptions | null;
  /** Sign-in codes also go to linked chats through it (PLNR-215): only the live server's bot (main.ts); none by default. */
  signInTelegram?: TelegramApi | null;
  /** Replies by email (PLNR-211); by default RSVA_REPLY_DOMAIN's with Resend's webhook secret and key, none without them. */
  inbound?: InboundConfig | null;
  /** How often a socket must answer a protocol ping, ms (sync/socket.ts). */
  socketLiveness?: number;
}

/**
 * The error handler: 5xx bodies carry no details, 4xx bodies the message without Fastify's internal code. A refusal
 * thrown by a route (HttpError) or by the write pipeline (TxError, its status by code) answers as a route's own reply.
 */
function sendError(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  // A deadlock or a lost connection that outlasted the write pipeline's retries: as a rule nothing was written (only a
  // connection lost during the commit itself leaves that open), so the caller tries again.
  if (transient(err)) {
    req.log.error({ err }, "database unavailable");
    return reply.code(503).header("retry-after", "1").send({ error: "unavailable", message: "The database is busy or restarting. Try again." });
  }
  if (err instanceof RateLimited) return reply.code(429).header("retry-after", String(err.retryAfter)).send({ error: "rate_limited", message: err.message });
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.error, message: err.message });
  if (err instanceof TxError) return reply.code(txStatus(err.code)).send({ error: err.code, message: err.message });
  const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  if (status >= 500) {
    req.log.error({ err }, "request failed");
    return reply.code(status).send({ error: "internal", message: "Something went wrong on the server." });
  }
  req.log.info({ err: { code: err.code, message: err.message } }, "request refused");
  const error = status === 400 ? "invalid" : (STATUS_CODES[status] ?? "error").toLowerCase().replace(/\W+/g, "_");
  return reply.code(status).send({ error, message: err.message });
}

export function buildApp(opts: AppOptions = {}) {
  const files = opts.files ?? new Map<string, StaticFile>();
  const guard = opts.guard ?? guardConfig();
  const headers = securityHeaders(files, guard);
  // Behind a reverse proxy (Caddy in production), RSVA_TRUST_PROXY lists its addresses so rate limits see client IPs.
  const trustProxy = process.env.RSVA_TRUST_PROXY?.split(",").map((s) => s.trim()).filter(Boolean);
  const app = Fastify({
    logger: {
      level: opts.logLevel ?? process.env.LOG_LEVEL ?? "info",
      ...(opts.logStream ? { stream: opts.logStream } : {}),
      // Fastify's own request serializer, with invite secrets cut out of the URL.
      serializers: {
        req: (req) => {
          const port = req.socket?.remotePort;
          return { method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip, ...(port ? { remotePort: port } : {}) };
        },
      },
    },
    // A URL the router cannot decode (/%E0): Fastify's own answer skips the hooks (so the headers) and quotes the URL,
    // which may hold an invite secret, in the body; neither the body nor the log repeats it here.
    frameworkErrors: (err, req, reply) => {
      req.log.info({ err: { code: err.code } }, "request refused");
      return (reply as FastifyReply).headers(headers).code(err.statusCode ?? 400).send({ error: "invalid", message: "The URL cannot be decoded or is too long." });
    },
    ...(trustProxy?.length ? { trustProxy } : {}),
  });
  const mailer = opts.mailer ?? mailerFromEnv(process.env, (msg) => app.log.warn(msg));
  // A JSON content type with no body (curl wrappers send it on every DELETE) reads as no body, not a 400. Anything else
  // goes to Fastify's own parser, with its prototype-poisoning checks.
  const json = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => (body === "" ? done(null, null) : json(req, body as string, done)));

  // Errors reach the client as { error, message } like the routes' own refusals. A 5xx says only "internal": drizzle
  // puts the query text and its parameters in the message, so the details go to the log alone. A 4xx (a body that is
  // not JSON, too large, of the wrong type) keeps Fastify's message but not its internal FST_ codes.
  app.setErrorHandler(sendError);
  // The default 404 echoes the method and URL into the body and the log; a stray POST to /join/<secret> would log it.
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found" }));

  // A route that sets its own, stricter policy keeps it (the digest example: a mail's inline styles, no scripts).
  const { "content-security-policy": _csp, ...withoutPolicy } = headers;
  app.addHook("onSend", async (_req, reply) => {
    reply.headers(reply.hasHeader("content-security-policy") ? withoutPolicy : headers);
  });

  // Answers over 1 KB compressed when the client takes it (PLNR-234). The live server was a 194 ms round trip from the reference Mac, and every
  // ~14 KB past TCP's first flight costs another one: a list of 100 issues (18–45 KB of JSON) took 0.8–0.95 s against 0.61 s
  // for one issue, and compressed it fits the first flight (2026-11-04).
  compressJsonResponses(app);

  app.addHook("onRequest", async (req, reply) => {
    if (hasNul(req.url)) return reply.code(400).send({ error: "invalid", message: "The URL contains a NUL byte." });
  });

  // Host and Origin checks (DNS rebinding, cross-site requests): guard.ts.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" && req.url === "/healthz") return;
    const status = rejectStatus(req.headers, guard, req.url);
    if (status) return reply.code(status).send({ error: "forbidden_origin" });
  });

  // Liveness only: memory and the number of open sockets would tell anyone how busy the server is. The operator reads
  // memory from the process (`docker stats`, `ps`); the perf check does the same with the server it starts.
  app.get("/healthz", async () => ({ ok: true }));

  registerAuthRoutes(app, mailer, opts.signInTelegram ?? null);
  const telegram = opts.telegram !== undefined ? opts.telegram : telegramFromEnv();
  const inbound = opts.inbound !== undefined ? opts.inbound : inboundFromEnv();
  registerNotifyRoutes(app, telegram, inbound?.domain ?? null);
  const blobs = opts.blobs ?? blobStoreFromEnv();
  registerTelegram(app, telegram, mailer, blobs);
  registerInbound(app, inbound, mailer, PUBLIC_ORIGIN ?? "");
  registerUnsubscribe(app);
  const waitlistNotifier = telegram ? new WaitlistNotifier(telegram.api, app.log) : null;
  app.addHook("onClose", async () => waitlistNotifier?.stop());
  registerWaitlist(app, guard, waitlistNotifier);
  registerDigestExample(app);
  const signedIn = { preHandler: requireActor() };

  // Workspace snapshot: NDJSON, compressed as a stream.
  app.get<{ Querystring: { ws?: string; project?: string } }>("/sync/bootstrap", signedIn, async (req, reply) => {
    // Before any read: a snapshot is the whole workspace (RSVA-608).
    const userId = req.actor!.userId;
    if (!bootstraps.take(userId, 1)) throw new RateLimited(bootstraps.retryAfter(userId, 1), "too many snapshot requests");
    // The viewer's settings (PLNR-210) are read in parallel with the access check: one row by primary key.
    const [access, settings] = await Promise.all([accessBySlug(req.actor!, req.query.ws ?? "").then(granted), readSettings(req.actor!.userId)]);
    const enc = pickEncoding(req.headers["accept-encoding"]);
    reply
      .header("content-type", "application/x-ndjson")
      .header("cache-control", "no-store")
      .header("vary", "accept-encoding")
      .header(VIEWER_HEADERS.me, req.actor!.userId)
      .header(VIEWER_HEADERS.role, access.role)
      .headers(settingsHeaders(settings));
    // Every request is served from the compressed-snapshot cache: every current browser takes brotli as it is, anything
    // else gets it decompressed as a stream (and gzipped if asked), not a new read of the workspace (RSVA-608).
    const { body, quality } = await brotliSnapshot(access.slug, req.query.project);
    if (enc === "br") {
      // The brotli level of this body (5 at once, 11 after the background recompression): for the perf checks.
      return reply.header("content-encoding", "br").header("x-snapshot-quality", String(quality)).send(body);
    }
    if (enc) reply.header("content-encoding", enc);
    return reply.send(compressStream(Readable.from([body]).pipe(createBrotliDecompress()), enc));
  });

  const badUntil = (reply: FastifyReply) => reply.code(400).send({ error: "invalid", message: "until: a time from an answer's older" });
  /** A page of history (an issue's or a project's): over the reader's budget, missing, or the page itself, never cached. */
  const sendPage = (reply: FastifyReply, h: object | null | "rate_limited") => {
    if (h === "rate_limited") return reply.code(429).header("retry-after", "60").send({ error: "rate_limited", message: "too many history requests" });
    if (!h) return reply.code(404).send();
    return reply.header("cache-control", "no-store").send(h);
  };

  // Workspaces the viewer can open, with their own role there, for the switcher and the "not found" screen. A token
  // opens its one workspace.
  app.get("/sync/workspaces", signedIn, async (req, reply) => {
    const { workspace, member } = schema;
    const actor = req.actor!;
    // Only workspaces the viewer may open: a guest's are left out until guests can open anything.
    const mine = (await workspacesOf(actor.userId, "read")).filter((w) => !actor.token || actor.token.workspaceId === w.id);
    const role = new Map(mine.map((r) => [r.id, r.role as WorkspaceListItem["role"]]));
    const rows = role.size
      ? await db
          .select({ id: workspace.id, slug: workspace.slug, name: workspace.name, color: workspace.color, members: count(member.userId) })
          .from(workspace)
          .leftJoin(member, eq(member.workspaceId, workspace.id))
          .where(inArray(workspace.id, [...role.keys()]))
          .groupBy(workspace.id)
          .orderBy(workspace.name)
      : [];
    return reply.send(rows.map(({ id, ...r }): WorkspaceListItem => ({ ...r, role: role.get(id)! })));
  });

  // Description, comments, reactions and history of an issue: loaded when it is opened, then kept live by deltas.
  // One page of it (sync/history.ts); `until` asks for the page before an answer's `older`.
  app.get<{ Params: { id: string }; Querystring: { until?: string } }>("/sync/history/:id", signedIn, async (req, reply) => {
    // Not a UUID cannot be an issue; without this check Postgres rejects the cast and the client gets a 500.
    if (!UUID.test(req.params.id)) return reply.code(404).send();
    const until = req.query.until;
    if (until !== undefined && !isServerTime(until)) return badUntil(reply);
    // Access first, from the issue's workspace; someone else's issue answers like a missing one.
    const [i] = await db.select({ ws: schema.issue.workspaceId }).from(schema.issue).where(eq(schema.issue.id, req.params.id));
    if (!i || "status" in (await accessById(req.actor!, i.ws))) return reply.code(404).send();
    return sendPage(reply, await readHistory(req.actor!.userId, req.params.id, until));
  });

  // Activity of many issues at once, for the browser to keep and open them without a request (PLNR-80). A POST: a list of
  // ids may not fit a URL.
  app.post<{ Querystring: { ws?: string }; Body: { ids?: unknown } | null }>("/sync/feeds", signedIn, async (req, reply) => {
    const access = granted(await accessBySlug(req.actor!, req.query.ws ?? ""));
    const ids = req.body?.ids;
    if (ids !== undefined && !(Array.isArray(ids) && ids.length <= FEEDS_MAX_IDS && ids.every((id) => typeof id === "string" && UUID.test(id)))) {
      return reply.code(400).send({ error: "invalid", message: `ids: up to ${FEEDS_MAX_IDS} issue ids` });
    }
    return sendPage(reply, await readFeeds(req.actor!.userId, access.workspaceId, ids as string[] | undefined));
  });

  // A project's history (PLNR-71): its issues' changes and comments at a level, newest first, a page at a time.
  app.get<{ Querystring: { project?: string; level?: string; until?: string } }>("/sync/project-history", signedIn, async (req, reply) => {
    const { project: projectId, level, until } = req.query;
    if (!projectId || !UUID.test(projectId)) return reply.code(404).send();
    if (!isHistoryLevel(level)) return reply.code(400).send({ error: "invalid", message: `level: one of ${HISTORY_LEVELS.join(", ")}` });
    if (until !== undefined && !isServerTime(until)) return badUntil(reply);
    const [p] = await db.select({ ws: schema.project.workspaceId }).from(schema.project).where(eq(schema.project.id, projectId));
    if (!p || "status" in (await accessById(req.actor!, p.ws))) return reply.code(404).send();
    return sendPage(reply, await readProjectHistory(req.actor!.userId, projectId, level, until));
  });

  // A cycle's burn-up (PLNR-63): the counts of its days that are over, in the viewer's zone (`tz`, UTC without it); the
  // client adds today from its own data.
  app.get<{ Params: { id: string }; Querystring: { tz?: string } }>("/sync/cycle-progress/:id", signedIn, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send();
    const tz = req.query.tz === undefined ? "UTC" : req.query.tz.length <= 64 ? canonicalZone(req.query.tz) : null;
    if (!tz) return reply.code(400).send({ error: "invalid", message: "tz is not a time zone" });
    const [c] = await db.select({ ws: schema.cycle.workspaceId }).from(schema.cycle).where(eq(schema.cycle.id, req.params.id));
    if (!c || "status" in (await accessById(req.actor!, c.ws))) return reply.code(404).send();
    return sendPage(reply, await readCycleProgress(req.actor!.userId, req.params.id, tz));
  });

  // A project's open pull requests (RSVA-519, RSVA-572), for its home's widget: their links are not in the snapshot.
  app.get<{ Params: { id: string } }>("/sync/project-pulls/:id", signedIn, async (req, reply) => {
    if (!UUID.test(req.params.id)) return reply.code(404).send();
    const [p] = await db.select({ ws: schema.project.workspaceId }).from(schema.project).where(eq(schema.project.id, req.params.id));
    if (!p || "status" in (await accessById(req.actor!, p.ws))) return reply.code(404).send();
    return sendPage(reply, await metered(req.actor!.userId, 4096, async () => ({ pulls: await projectPulls(db, req.params.id) })));
  });

  registerAgentApi(app, mailer);
  registerWorkspaceApi(app, mailer);
  registerFileRoutes(app, blobs);
  registerPictureRoutes(app);
  registerGithub(app, opts.github);

  app.get("/*", async (req, reply) => {
    const path = req.url.split("?", 1)[0]!;
    // Any path without an extension is an app route: serve the shell.
    const file = files.get(path) ?? (path.includes(".") ? undefined : files.get("/index.html"));
    if (!file) return reply.code(404).send();
    reply
      .header("content-type", file.type)
      .header("cache-control", file.cacheControl)
      .header("etag", file.etag)
      .header("vary", "accept-encoding");
    if (req.headers["if-none-match"] === file.etag) return reply.code(304).send();
    const v = pickVariant(file, req.headers["accept-encoding"]);
    if (v.encoding) reply.header("content-encoding", v.encoding);
    return reply.send(v.body);
  });

  // The client's address for an upgrade, as Fastify gives req.ip to a request: through the trusted proxies, if any.
  const proxies = trustProxy?.length ? proxyaddr.compile(trustProxy) : null;
  const clientIp = (req: IncomingMessage) => (proxies ? proxyaddr(req, proxies) : (req.socket.remoteAddress ?? ""));
  // WebSocket frame compression is off: frames are short, and per-connection deflate costs memory.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });
  app.server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") return socket.destroy();
    const status = rejectStatus(req.headers, guard);
    if (status) {
      socket.end(`HTTP/1.1 ${status} ${status === 421 ? "Misdirected Request" : "Forbidden"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    // Without a session the socket opens and closes at once with CLOSE_UNAUTHORIZED: a browser cannot read the status of
    // a refused upgrade, and the client must tell "sign in again" from "the network is down".
    // Behind the same failures limit as requireActor: a flood of wrong secrets here must not read the database either.
    // Refused like the guard refuses, before the upgrade: the client takes it for the network and retries later.
    authenticateFrom(req.headers, clientIp(req)).then(
      ({ actor, retryAfter }) => {
        if (retryAfter) {
          socket.end(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${retryAfter}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          // First of all, on every socket, those about to be refused too: a bad or oversized frame is an `error` event, and
          // one nobody listens to ends the process. `ws` closes the socket by itself, with 1002 or 1009.
          ws.on("error", (e) => app.log.warn({ err: e.message }, "socket error"));
          // A browser always sends Origin on a WebSocket; a cookie without one is not a page of ours.
          if (!actor || (needsOrigin(actor) && !req.headers.origin)) ws.close(CLOSE_UNAUTHORIZED, "sign in first");
          else handleSocket(ws, actor, () => authenticate(req.headers), opts.socketLiveness);
        });
      },
      (e: unknown) => {
        app.log.error(e, "socket authentication failed");
        socket.destroy();
      },
    );
  });
  // preClose, not onClose: upgraded sockets still count as the HTTP server's connections, so server.close() waits for
  // them, and onClose runs only after it. With an open tab the process never exited (node --watch hung on "Waiting
  // for graceful termination", a deploy would too). Clients reconnect and catch up from their lastSyncId.
  app.addHook("preClose", async () => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  });
  return app;
}
