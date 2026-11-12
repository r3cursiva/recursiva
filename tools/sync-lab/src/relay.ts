// A TCP relay between the engine and the server: the network a test can break. It works on bytes, so TLS to a real server
// passes through untouched and the same faults apply to a local server and to production.
import net from "node:net";

interface Pair {
  down: net.Socket;
  up: net.Socket;
}

export class Relay {
  private server: net.Server | undefined;
  private readonly pairs = new Set<Pair>();
  private refusing = false;
  private hanging = false;
  private stalled = false;
  private stalledDown = false;
  latency = 0;
  /** Connections accepted so far. */
  connections = 0;

  private readonly host: string;
  private readonly port: number;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server = net.createServer((down) => this.accept(down));
      this.server.listen(0, "127.0.0.1", () => resolve((this.server!.address() as net.AddressInfo).port));
    });
  }

  private accept(down: net.Socket): void {
    this.connections++;
    down.on("error", () => {});
    if (this.refusing) return void down.resetAndDestroy();
    if (this.hanging) return; // the connection stands and nothing ever answers
    const up = net.connect(this.port, this.host);
    up.on("error", () => down.destroy());
    const pair: Pair = { down, up };
    this.pairs.add(pair);
    const forward = (from: net.Socket, to: net.Socket, isDown: boolean) => {
      from.on("data", (chunk) => {
        // Bytes in a stall are lost, as a dead link loses them: only a resume after a short blip would have saved them,
        // and TCP would have retransmitted those; `blip` holds them instead.
        if (this.stalled || (isDown && this.stalledDown)) return;
        if (this.latency) setTimeout(() => to.writable && to.write(chunk), this.latency);
        else to.write(chunk);
      });
      from.on("close", () => {
        to.destroy();
        this.pairs.delete(pair);
      });
    };
    forward(down, up, false);
    forward(up, down, true);
  }

  /** The link dies without a word: nothing passes either way and neither end is told. */
  stall(): void {
    this.stalled = true;
  }

  /** Only server → client dies: requests still arrive, answers do not (an ack lost on its way back). */
  stallDown(): void {
    this.stalledDown = true;
  }

  /** The link works again for new connections; the old ones stay dead until `cut`, as after a NAT forgets them. */
  heal(): void {
    this.stalled = this.stalledDown = this.refusing = this.hanging = false;
    this.cut();
  }

  /** Every open connection is reset. */
  cut(): void {
    for (const p of this.pairs) {
      p.down.resetAndDestroy();
      p.up.destroy();
    }
    this.pairs.clear();
  }

  /** New connections are refused (the network is down and says so). */
  refuse(on = true): void {
    this.refusing = on;
    if (on) this.cut();
  }

  /** New connections are accepted and never answered (a captive portal, a dead proxy). */
  hang(on = true): void {
    this.hanging = on;
    if (on) this.cut();
  }

  close(): void {
    this.cut();
    this.server?.close();
  }
}
