import type { DemoInfo } from "@rsva/protocol";

/**
 * Whether the server is the public demo, from its answer to GET /auth/demo. Only a demo answers it with JSON naming the
 * workspace: any other server gives the app's page for an unknown address, with 200 too, and must keep its email sign-in.
 */
export async function isDemo(r: Response): Promise<boolean> {
  if (!r.ok || !r.headers.get("content-type")?.includes("application/json")) return false;
  const info = (await r.json().catch(() => null)) as Partial<DemoInfo> | null;
  return typeof info?.workspace === "string" && info.workspace !== "";
}
