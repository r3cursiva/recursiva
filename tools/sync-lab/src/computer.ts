// One "computer": the real sync engine (packages/sync) with its own disk (IndexedDB) and its own network (Relay).
import tls from "node:tls";
import net from "node:net";
import { authorizedTransport, createSyncStore, type SyncEngine, type SyncStoreOptions } from "@rsva/sync";
import { IDBFactory } from "fake-indexeddb";
import WebSocket from "ws";
import { Relay } from "./relay.ts";
import type { Target } from "./target.ts";

export class Computer {
  readonly relay: Relay;
  readonly idb = new IDBFactory();
  store!: SyncEngine;
  /** HTTP fails as it does without a network; the socket goes through the relay and is broken there. */
  offline = false;
  private port = 0;
  readonly name: string;
  private readonly target: Target;
  /** The credential the engine's requests carry: the browser's cookie, which another tab's sign-in may replace. */
  private token: string;
  private readonly options: Partial<SyncStoreOptions>;

  constructor(name: string, target: Target, token: string, options: Partial<SyncStoreOptions> = {}) {
    this.name = name;
    this.target = target;
    this.token = token;
    this.options = options;
    const u = new URL(target.url);
    this.relay = new Relay(u.hostname, Number(u.port) || (u.protocol === "https:" ? 443 : 80));
  }

  /** Opens the app: the engine starts from its disk, or from a snapshot when the disk is empty. */
  async open(): Promise<void> {
    if (!this.port) this.port = await this.relay.listen();
    const { url } = this.target;
    const u = new URL(url);
    const port = this.port;
    const secure = u.protocol === "https:";
    // The token is read on every request: another tab's sign-in may replace it (`token`).
    const link = authorizedTransport(() => `Bearer ${this.token}`, WebSocket, {
      createConnection: () => (secure ? tls.connect({ host: "127.0.0.1", port, servername: u.hostname }) : net.connect(port, "127.0.0.1")),
    });
    this.store = createSyncStore({
      workspace: this.target.ws,
      baseUrl: url,
      indexedDB: this.idb,
      WebSocket: link.WebSocket,
      fetch: (input, init) => (this.offline ? Promise.reject(new TypeError("fetch failed: offline")) : link.fetch(input, init)),
      reload: () => {},
      ...this.options,
    });
    await this.store.start();
  }

  /** Closes the tab: what is on disk stays. */
  async reload(): Promise<void> {
    await this.store.persist();
    this.remember();
    this.store.dispose();
    await this.open();
  }

  /** The tab dies with no chance to save: only what already reached the disk stays. */
  async crash(): Promise<void> {
    this.remember();
    this.store.dispose();
    await this.open();
  }

  private refused: string | null = null;
  private remember(): void {
    const r = this.store.lastRejection;
    if (r && r.code !== "conflict") this.refused ??= `${r.code}: ${r.message}`;
  }

  /** The first refusal this computer got, across reloads, but for a conflict of descriptions: that one is its own outcome. */
  refusal(): string | null {
    this.remember();
    return this.refused;
  }

  /** Someone else signs in in this browser: the open engine's next requests and sockets carry their credential. */
  signedInAs(token: string): void {
    this.token = token;
  }

  /** The link is gone for this computer, and it says so: sockets reset, new ones refused, HTTP fails. */
  disconnect(): void {
    this.offline = true;
    this.relay.refuse();
  }

  connect(): void {
    this.offline = false;
    this.relay.heal();
  }

  close(): void {
    this.store?.dispose();
    this.relay.close();
  }
}
