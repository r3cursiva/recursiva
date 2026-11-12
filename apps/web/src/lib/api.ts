// The REST calls of the settings and the account (apps/server/src/workspaces.ts, api.ts, auth/routes.ts): JSON in (or a
// Blob, sent as its bytes: a profile picture) and out, a refusal as an ApiError with the server's code and message, and 401
// as the end of the session.
import { holdReloadFor } from "./new-version.ts";
import { sessionEnded } from "./signed-in.ts";

/** A refusal: the server's message, and its code for the screens that tell cases apart (wrong_account, not_found). */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** `signal` ends a long request when its page goes (the Telegram wait). A reload for a new version waits for a write. */
export async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const sent = fetch(path, {
    method,
    ...(signal ? { signal } : {}),
    ...(body === undefined
      ? {}
      : body instanceof Blob
        ? { headers: { "content-type": body.type }, body }
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const r = await (method === "GET" ? sent : holdReloadFor(sent));
  if (r.status === 204) return undefined as T;
  // The session ended meanwhile (the last workspace or invite went): the sign-in screen, not an error line.
  if (r.status === 401) sessionEnded();
  const data = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!r.ok) throw new ApiError(r.status, data.error ?? "error", data.message ?? `HTTP ${r.status}`);
  return data as T;
}

