/** A message port: Electron's MessagePortMain, Node's worker_threads MessagePort (tests) — reduced to what is needed. */
export interface Port {
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  close(): void;
  /** The other end is gone (its process died): Electron says so at once, the process's own exit may come seconds later. */
  onClose?(listener: () => void): void;
}

export declare const DEFAULT_TIMEOUT_MS: number;

export declare class RpcError extends Error {
  readonly code: 'timeout' | 'closed' | 'remote' | 'unknown-method';
  constructor(message: string, code: 'timeout' | 'closed' | 'remote' | 'unknown-method');
}

export declare class Rpc {
  constructor(port: Port, token: string);
  /** Calls a method of the other side; rejects on its error, on `timeoutMs` and when the channel closes. */
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  /** Answers the other side's calls of `method` (one handler per method; its throw goes back as an error). */
  handle(method: string, fn: (params: unknown) => unknown): void;
  emit(name: string, data?: unknown): void;
  on(name: string, fn: (data: unknown) => void): () => void;
  /** The other side is gone: every call waiting fails at once. */
  close(reason?: string): void;
  readonly isClosed: boolean;
}

/** Node's worker_threads / Electron's MessagePortMain as a Port. */
export declare function nodePort(
  p: { postMessage(m: unknown): void; on(ev: 'message' | 'close', fn: (e: unknown) => void): unknown; close(): void; start?(): void },
  unwrap?: (e: unknown) => unknown,
): Port;
