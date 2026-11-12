// The engine's network outside a browser: there no cookie goes along, so every request and the socket carry an
// Authorization header. Node's WebSocket (undici) and `ws` both take headers in their second argument; the browser's
// does not, and does not need to.
import type { SocketLike } from "./client.ts";

/**
 * The `WebSocket` and `fetch` for createSyncStore that carry `authorization` (the header's value, "Bearer …" or
 * "Session …"): a function is read on every request, for a credential that may be replaced while the engine runs.
 * `options` goes to the socket's constructor beside the headers (`ws`'s createConnection, say). The token goes in a
 * header only, never in the URL.
 */
export function authorizedTransport<C extends new (url: string, init: never) => SocketLike>(
  authorization: string | (() => string),
  WebSocket: C,
  options: object = {},
): { WebSocket: new (url: string) => InstanceType<C>; fetch: typeof fetch } {
  const value = typeof authorization === "string" ? () => authorization : authorization;
  // Both constructors take an options object second; their declared types differ, so the call is checked here only.
  const Base = WebSocket as unknown as new (url: string, init: object) => SocketLike;
  class Socket extends Base {
    constructor(url: string) {
      super(url, { ...options, headers: { authorization: value() } });
    }
  }
  return {
    WebSocket: Socket as unknown as new (url: string) => InstanceType<C>,
    fetch: (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", value());
      return fetch(input, { ...init, headers });
    },
  };
}
