// The channel between the program's kernel and an app's part on the PC (docs/v2/pc-host.md §3.3): JSON-RPC over a message port —
// a request has an id and a time limit, the answer carries the same id, events go one way. Each side has its own token: the kernel
// gives the part a random one at start and drops anything that does not carry it (the port is private, the token is a second lock
// and tells the kernel which app a message is from).
//
// Plain JavaScript with types beside it (rpc.d.ts): it runs as it is in the program, in an author's bundled part and in tests.

export const DEFAULT_TIMEOUT_MS = 60_000;

export class RpcError extends Error {
  /** @param {string} message @param {'timeout' | 'closed' | 'remote' | 'unknown-method'} code */
  constructor(message, code) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export class Rpc {
  /** @param {import('./rpc.d.ts').Port} port @param {string} token */
  constructor(port, token) {
    this.port = port;
    this.token = token;
    this.next = 1;
    /** @type {Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>} */
    this.pending = new Map();
    /** @type {Map<string, (params: unknown) => unknown>} */
    this.handlers = new Map();
    /** @type {Map<string, Set<(data: unknown) => void>>} */
    this.listeners = new Map();
    this.closed = false;
    port.onMessage((raw) => this.receive(raw));
  }

  /** Calls a method of the other side; rejects on its error, on `timeoutMs` and when the channel closes. */
  call(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new RpcError('Канал закрыт', 'closed'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`Нет ответа на «${method}» за ${Math.round(timeoutMs / 1000)} с`, 'timeout'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.port.post({ t: 'req', tok: this.token, id, m: method, p: params });
    });
  }

  /** Answers the other side's calls of `method` (one handler per method; its throw goes back as an error). */
  handle(method, fn) {
    this.handlers.set(method, fn);
  }

  emit(name, data) {
    if (!this.closed) this.port.post({ t: 'evt', tok: this.token, n: name, d: data });
  }

  on(name, fn) {
    const set = this.listeners.get(name) ?? new Set();
    set.add(fn);
    this.listeners.set(name, set);
    return () => void set.delete(fn);
  }

  /** The other side is gone: every call waiting fails at once. */
  close(reason = 'Канал закрыт') {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError(reason, 'closed'));
    }
    this.pending.clear();
    try {
      this.port.close();
    } catch {
      // gone already
    }
  }

  get isClosed() {
    return this.closed;
  }

  receive(raw) {
    const msg = raw;
    if (!msg || typeof msg !== 'object' || msg.tok !== this.token) return; // not from our part
    if (msg.t === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.r);
      else p.reject(new RpcError(msg.e ?? 'Ошибка', 'remote'));
      return;
    }
    if (msg.t === 'evt') {
      for (const fn of this.listeners.get(msg.n) ?? []) fn(msg.d);
      return;
    }
    if (msg.t === 'req') {
      const fn = this.handlers.get(msg.m);
      const answer = (res) => {
        if (!this.closed) this.port.post({ t: 'res', tok: this.token, id: msg.id, ...res });
      };
      if (!fn) return answer({ ok: false, e: `Нет такого действия: ${msg.m}` });
      Promise.resolve()
        .then(() => fn(msg.p))
        .then(
          (r) => answer({ ok: true, r }),
          (e) => answer({ ok: false, e: e instanceof Error ? e.message : String(e) }),
        );
    }
  }
}

/** Node's worker_threads / Electron's MessagePortMain as a Port. */
export function nodePort(p, unwrap = (e) => e) {
  return {
    post: (m) => p.postMessage(m),
    onMessage: (fn) => {
      p.on('message', (e) => fn(unwrap(e)));
      p.start?.();
    },
    close: () => p.close(),
    onClose: (fn) => void p.on('close', () => fn()),
  };
}
