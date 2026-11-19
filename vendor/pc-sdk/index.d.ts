import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { Port } from './rpc.js';

export { Rpc, RpcError, nodePort, DEFAULT_TIMEOUT_MS, type Port } from './rpc.js';

/** What the program said at the part's start. */
export interface Hello {
  type: 'quadro-part';
  token: string;
  appId: string;
  dataDir: string;
  config: Record<string, unknown>;
  /** The app's installed version's folder (its downloads are in it); a built-in part has none. */
  appDir?: string | null;
}

/** What a file the person picked (or the program made for the app) is now; nothing else of the PC is told. */
export interface FileStat {
  exists: boolean;
  isFile: boolean;
  size: number;
}

export interface PartHostApi {
  app: {
    id: string;
    dataDir: string;
    config: Record<string, unknown>;
    /** A download of its manifest (`parts.pc.downloads`): the file, or with `unpack: 'zip'` its unpacked folder. */
    download(id: string, opts?: { unpacked?: boolean }): string;
  };
  rpc: { handle(method: string, fn: (params: unknown) => unknown): void };
  events: { emit(name: string, data?: unknown): void };
  /** Programs of its own (pc.process): from its package and its downloads only; they stop with the part. */
  processes: { spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess };
  /** `ready`: only with connect({ manualReady: true }) — the part says it is ready once it has set up. */
  lifecycle: { busy(reason: string | null): void; onStop(fn: () => void | Promise<void>): void; ready(): void };
  /** Asks the program for what the part may not do itself (its services, by name). */
  kernel: { call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> };
  /**
   * The person's files, through the program (the part reads nothing outside its folders): pick (pc.files.pick) — Windows' own
   * window, the paths are remembered as this app's; stat — only those and what the program made for it; outputPath — a free
   * name next to a picked file («имя (Quadro).ext»), the part's program writes it; remove — only such a name; reveal / open
   * (pc.files.reveal / pc.files.open) — only those, and never a program.
   */
  files: {
    /** Files (or with `folder: true` one folder — results may then go there). */
    pick(opts?: { multiple?: boolean; folder?: boolean; extensions?: string[]; title?: string }): Promise<string[]>;
    stat(path: string): Promise<FileStat>;
    /** `folder` — a folder picked with pick({ folder: true }); none — next to the file. */
    outputPath(path: string, ext: string, opts?: { suffix?: string; folder?: string }): Promise<string>;
    remove(path: string): Promise<void>;
    reveal(path: string): Promise<void>;
    open(path: string): Promise<void>;
  };
  /** A Windows notification (pc.notify). */
  notify(title: string, body: string): Promise<void>;
  /**
   * What the AI asks through Hub's MCP (right pc.mcp; a tool of the manifest with handler 'pc:<name>'): `handle(name, fn)`. The answer
   * is JSON up to 8 MB; `{ text?, images?: [{ data: base64, mimeType }], data?, notice? }` becomes the AI's text and pictures (the
   * program shrinks pictures to 1600 px), `notice` — a quiet line for the person («ИИ читал чат …», never the content itself).
   * `signal` aborts when the AI drops the call or its time is up.
   */
  mcp: {
    handle(name: string, fn: (params: unknown, ctx: { signal: AbortSignal }) => unknown): void;
  };
  /** Secrets sealed by the OS (DPAPI of this Windows user), bound to this app: keep the sealed blob in its data folder. */
  secrets: {
    seal(data: Uint8Array | string): Promise<Uint8Array>;
    unseal(sealed: Uint8Array): Promise<Uint8Array>;
  };
  /** The network of an installed app's part: only the hosts of its `net:<host>` rights, through the program. */
  net: {
    /**
     * A WebSocket opened by the program (wss:// only, the hosts of its `net:` rights, at most 4 per app, a frame up to 4 MB);
     * resolves when it is open. It closes with the part.
     */
    websocket(url: string, protocols?: string | string[]): Promise<PartSocket>;
    fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array }): Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;
  };
}

export interface PartSocket {
  send(data: Uint8Array | string): Promise<void>;
  /** Text frames as strings, binary ones as bytes; returns «отписаться». */
  onMessage(fn: (data: Uint8Array | string) => void): () => void;
  onClose(fn: (code: number, reason: string) => void): () => void;
  close(code?: number, reason?: string): Promise<void>;
}

/** Builds the part's host on a port the program gave (tests give one of node's MessageChannel). */
export declare function hostOn(port: Port, hello: Hello, o?: { manualReady?: boolean }): PartHostApi;

/** In the part's process: waits for the program's hello and gives the host. */
export declare function connect(o?: { manualReady?: boolean }): Promise<PartHostApi>;
