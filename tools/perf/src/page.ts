// A page under the conditions a perf check measures in: Chromium's network emulation and CPU throttling, set through
// CDP before the page loads (or, for an open page, before what is timed next).
import type { BrowserContext, CDPSession, Page } from "playwright";

/** CDP's Network.emulateNetworkConditions: latency added to every response in ms, throughput in bytes per second. */
interface NetworkProfile {
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
}

export interface Profile {
  network?: NetworkProfile;
  /** CPU slowdown factor (Emulation.setCPUThrottlingRate); 1 or less leaves the CPU alone. */
  cpu?: number;
  /** Turns on CDP's Network domain for the caller's own listeners (bytes, socket frames) also without `network`. */
  watch?: boolean;
  /** An open page to put under the profile instead of a new one. */
  page?: Page;
}

export async function profiledPage(ctx: BrowserContext, p: Profile = {}): Promise<{ page: Page; cdp: CDPSession }> {
  const page = p.page ?? (await ctx.newPage());
  const cdp = await ctx.newCDPSession(page);
  if (p.watch || p.network) await cdp.send("Network.enable");
  const n = p.network;
  if (n) await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: n.latency, downloadThroughput: n.downloadThroughput, uploadThroughput: n.uploadThroughput });
  if (p.cpu !== undefined && p.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: p.cpu });
  return { page, cdp };
}
