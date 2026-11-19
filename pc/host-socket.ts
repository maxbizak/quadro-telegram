// GramJS's network socket over the program's WebSocket (pc-sdk host.net.websocket): the part's process has no network of its own
// (part-guard closes net, tls and WebSocket); the program opens wss:// only to the hosts of the manifest's `net:` rights —
// here *.web.telegram.org, Telegram's own addresses for web clients (MTProto over WebSocket, obfuscated transport).
// The same reading interface as GramJS's PromisedWebSockets: read / readExactly / write / close.

export interface PartSocketLike {
  send(data: Uint8Array | string): Promise<void>;
  onMessage(fn: (data: Uint8Array | string) => void): () => void;
  onClose(fn: (code: number, reason: string) => void): () => void;
  close(code?: number, reason?: string): Promise<void>;
}

export type OpenSocket = (url: string, protocols?: string | string[]) => Promise<PartSocketLike>;

/** Telegram's web addresses only: «venus.web.telegram.org», «venus-1.web.telegram.org» (files)… */
export const TELEGRAM_WEB_HOST = /^[a-z]+(-1)?\.web\.telegram\.org$/;

export function webSocketUrl(host: string, testServers = false): string {
  if (!TELEGRAM_WEB_HOST.test(host)) throw new Error(`Не адрес Telegram для веб-клиентов: ${host}`);
  return `wss://${host}/apiws${testServers ? '_test' : ''}`;
}

const closed = () => new Error('WebSocket was closed');

/** A class GramJS constructs itself (`new networkSocket(proxy)`), bound to the program's sockets. */
export function hostSocketClass(open: OpenSocket) {
  return class HostSocket {
    private socket: PartSocketLike | null = null;
    private stream: Buffer = Buffer.alloc(0);
    private closed = true;
    private wake: (() => void) | null = null;
    private stops: Array<() => void> = [];

    private waitData(): Promise<void> {
      return new Promise((resolve) => {
        this.wake = resolve;
      });
    }

    private notify(): void {
      const w = this.wake;
      this.wake = null;
      w?.();
    }

    async connect(_port: number, ip: string, testServers = false): Promise<this> {
      this.stream = Buffer.alloc(0);
      this.socket = await open(webSocketUrl(ip, testServers), ['binary']);
      this.closed = false;
      this.stops.push(
        this.socket.onMessage((data) => {
          this.stream = Buffer.concat([this.stream, typeof data === 'string' ? Buffer.from(data, 'binary') : Buffer.from(data)]);
          this.notify();
        }),
        this.socket.onClose(() => {
          this.closed = true;
          this.notify();
        }),
      );
      return this;
    }

    async read(n: number): Promise<Buffer> {
      while (!this.stream.length) {
        if (this.closed) throw closed();
        await this.waitData();
      }
      const out = this.stream.subarray(0, n);
      this.stream = this.stream.subarray(n);
      return Buffer.from(out);
    }

    async readExactly(n: number): Promise<Buffer> {
      let out = Buffer.alloc(0);
      while (n > 0) {
        const part = await this.read(n);
        out = Buffer.concat([out, part]);
        n -= part.length;
      }
      return out;
    }

    async readAll(): Promise<Buffer> {
      while (!this.stream.length) {
        if (this.closed) throw closed();
        await this.waitData();
      }
      const out = this.stream;
      this.stream = Buffer.alloc(0);
      return out;
    }

    write(data: Buffer): void {
      if (this.closed || !this.socket) throw closed();
      void this.socket.send(new Uint8Array(data)).catch(() => {
        this.closed = true;
        this.notify();
      });
    }

    async close(): Promise<void> {
      this.closed = true;
      for (const stop of this.stops.splice(0)) stop();
      const s = this.socket;
      this.socket = null;
      this.notify();
      await s?.close().catch(() => undefined);
    }

    toString(): string {
      return 'HostSocket';
    }
  };
}
