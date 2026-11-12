// A webhook nobody signs in to (GitHub, Resend): the raw body for its signature, and a bound on the bodies read at once.
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import { clientKey } from "./http.ts";

/**
 * Bodies read at once, and how long one may take: nobody is signed in yet, so without these a few hundred slow requests
 * hold the server's memory limit. One client (an address, an IPv6 /64) holds a quarter of them at most, so that a few
 * slow bodies cannot turn every real delivery away: a real one is read in milliseconds, and its sender's several
 * addresses each get their share. A 503 is a failed delivery: Resend delivers it again, GitHub does not (only a
 * Redeliver in the App's settings does), so a GitHub delivery refused here is lost.
 */
const READING_MAX = 8;
const READING_PER_CLIENT = 2;
const READ_MS = 15_000;

/**
 * Makes `app`, an encapsulated plugin, read every body as raw bytes (a signature covers the bytes sent, not their JSON),
 * and gives the options of a route that reads at most `bodyLimit` of them, a few at once.
 */
export function rawWebhook(app: FastifyInstance, bodyLimit: number): RouteShorthandOptions {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  let reading = 0;
  /** Slots held by client; only clients holding one are in it, so it never has more than READING_MAX keys. */
  const byClient = new Map<string, number>();
  const slots = new WeakMap<FastifyRequest, () => void>();
  return {
    bodyLimit,
    onRequest: async (req, reply) => {
      const client = clientKey(req.ip);
      const mine = byClient.get(client) ?? 0;
      if (reading >= READING_MAX || mine >= READING_PER_CLIENT) return reply.code(503).header("retry-after", "5").send({ error: "busy", message: "too many deliveries at once" });
      reading++;
      byClient.set(client, mine + 1);
      const timer = setTimeout(() => req.raw.destroy(), READ_MS);
      let held = true;
      const free = () => {
        if (held) {
          reading--;
          const left = byClient.get(client)! - 1;
          if (left) byClient.set(client, left);
          else byClient.delete(client);
        }
        held = false;
        clearTimeout(timer);
      };
      slots.set(req, free);
      req.raw.once("close", free);
    },
    preValidation: async (req) => slots.get(req)?.(),
  };
}
