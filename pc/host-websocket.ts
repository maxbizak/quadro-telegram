// teleproto's WebSocket over the program's (pc-sdk host.net.websocket): the part's process has no network of its own (part-guard
// closes net, tls and WebSocket); the program opens wss:// only to the hosts of the manifest's `net:` rights — here
// *.web.telegram.org, Telegram's own addresses for web clients (MTProto over WebSocket, obfuscated transport). teleproto takes a
// browser-like WebSocket (WebSocketLike: binaryType, send, close, on* handlers); the program's one opens asynchronously — frames
// sent before it is open wait for it.

export interface PartSocketLike {
  send(data: Uint8Array | string): Promise<void>;
  onMessage(fn: (data: Uint8Array | string) => void): () => void;
  onClose(fn: (code: number, reason: string) => void): () => void;
  close(code?: number, reason?: string): Promise<void>;
}

export type OpenSocket = (url: string, protocols?: string | string[]) => Promise<PartSocketLike>;

/** What teleproto's WebSocketSocket uses of a WebSocket. */
export interface WebSocketLike {
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number): void;
  onopen: ((event: never) => void) | null;
  onmessage: ((event: never) => void) | null;
  onclose: ((event: never) => void) | null;
  onerror: ((event: never) => void) | null;
}

/** Telegram's web addresses only: «venus.web.telegram.org», «venus-1.web.telegram.org» (files)… */
export const TELEGRAM_WEB_HOST = /^[a-z]+(-1)?\.web\.telegram\.org$/;

/** The address teleproto asks for, if it is Telegram Web's (wss, standard port, /apiws). */
export function telegramUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Не адрес Telegram для веб-клиентов: ${url}`);
  }
  if (u.protocol !== 'wss:' || !TELEGRAM_WEB_HOST.test(u.hostname) || (u.port && u.port !== '443') || !/^\/apiws(_test)?$/.test(u.pathname)) {
    throw new Error(`Не адрес Telegram для веб-клиентов: ${url}`);
  }
  return `wss://${u.hostname}${u.pathname}`;
}

/** A browser-like WebSocket on the program's socket. */
export function hostWebSocket(open: OpenSocket, url: string, protocols?: string | string[]): WebSocketLike {
  let socket: PartSocketLike | null = null;
  let closed = false;
  const waiting: Uint8Array[] = [];
  const ws: WebSocketLike = {
    binaryType: 'arraybuffer',
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      if (closed) throw new Error('WebSocket was closed');
      const copy = new Uint8Array(data);
      if (!socket) waiting.push(copy);
      else void socket.send(copy).catch(() => drop(1006, 'send failed'));
    },
    close() {
      if (closed) return;
      closed = true;
      void socket?.close().catch(() => undefined);
    },
  };
  const fire = (name: 'onopen' | 'onmessage' | 'onclose' | 'onerror', event: unknown) => {
    try {
      (ws[name] as ((e: unknown) => void) | null)?.(event);
    } catch {
      // teleproto's own handler threw: not ours to report
    }
  };
  const drop = (code: number, reason: string) => {
    if (closed && !socket) return;
    closed = true;
    socket = null;
    fire('onclose', { code, reason, wasClean: false });
  };
  let target: string;
  try {
    target = telegramUrl(url);
  } catch (e) {
    queueMicrotask(() => {
      fire('onerror', { message: (e as Error).message });
      drop(1006, (e as Error).message);
    });
    return ws;
  }
  open(target, protocols).then(
    (s) => {
      if (closed) {
        void s.close().catch(() => undefined);
        return;
      }
      socket = s;
      s.onMessage((data) => {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        fire('onmessage', { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
      });
      s.onClose((code, reason) => drop(code, reason));
      fire('onopen', {});
      for (const f of waiting.splice(0)) void s.send(f).catch(() => drop(1006, 'send failed'));
    },
    (e: Error) => {
      fire('onerror', { message: e.message });
      drop(1006, e.message);
    },
  );
  return ws;
}
