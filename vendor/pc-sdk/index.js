import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Rpc, nodePort } from './rpc.js';

// What an app's part on the PC gets from the program (docs/v2/pc-host.md §6.3): its id and folders, calls from its screen
// (`rpc.handle`), events to its screen (`events.emit`), programs it runs (`processes.spawn` — stopped with the part), «я занята»
// for updates (`lifecycle.busy`), and through the program what it may not do itself — the person's files (`files.*`), Windows
// notifications (`notify`), the network of its `net:` rights (`net.fetch`). Each of those by the rights its manifest asks.
// Runs inside the part's own process. Plain JavaScript with types beside it (index.d.ts): an author's bundler takes it as it is.

export { Rpc, RpcError, nodePort, DEFAULT_TIMEOUT_MS } from './rpc.js';

/** Builds the part's host on a port the kernel gave (tests give one of node's MessageChannel). */
export function hostOn(port, hello, o = {}) {
  const rpc = new Rpc(port, hello.token);
  /** @type {Array<() => void | Promise<void>>} */
  const stops = [];
  let readySaid = false;
  rpc.handle('$ping', () => 'pong');
  // What the AI asks through Hub (pc.mcp): its own handlers, never the screen's; a call the AI dropped is aborted.
  /** @type {Map<string, (params: unknown, ctx: { signal: AbortSignal }) => unknown>} */
  const mcpHandlers = new Map();
  /** @type {Map<string, AbortController>} */
  const mcpRunning = new Map();
  rpc.handle('$mcp', async (x) => {
    const { callId, method, params } = x && typeof x === 'object' ? x : {};
    const fn = typeof method === 'string' ? mcpHandlers.get(method) : undefined;
    if (!fn) throw new Error(`Нет такого инструмента: ${method}`);
    const abort = new AbortController();
    if (typeof callId === 'string') mcpRunning.set(callId, abort);
    try {
      return await fn(params, { signal: abort.signal });
    } finally {
      if (typeof callId === 'string') mcpRunning.delete(callId);
    }
  });
  rpc.handle('$mcpCancel', (x) => {
    const id = x && typeof x === 'object' ? x.callId : undefined;
    mcpRunning.get(id)?.abort(new Error('ИИ отменил вызов'));
    return true;
  });
  rpc.handle('$stop', async () => {
    for (const fn of stops) await fn();
    return true;
  });
  const appDir = typeof hello.appDir === 'string' ? hello.appDir : null;
  // Sockets opened by the program for this part (host.net.websocket): their frames come as `$ws` events.
  /** @type {Map<string, { message: Set<(data: unknown) => void>, close: Set<(code: number, reason: string) => void>, open: (() => void) | null }>} */
  const sockets = new Map();
  rpc.on('$ws', (e) => {
    const s = e && sockets.get(e.id);
    if (!s) return;
    if (e.type === 'open') s.open?.();
    if (e.type === 'message') for (const fn of s.message) fn(e.binary ? new Uint8Array(Buffer.from(e.data, 'base64')) : e.data);
    if (e.type === 'close') {
      sockets.delete(e.id);
      for (const fn of s.close) fn(e.code, e.reason);
    }
  });
  const api = {
    app: {
      id: hello.appId,
      dataDir: hello.dataDir,
      config: hello.config ?? {},
      /** A download of its manifest (`parts.pc.downloads`): the file, or with `unpack: 'zip'` its unpacked folder. */
      download(id, opts = {}) {
        if (!appDir) throw new Error('У части нет скачанного груза');
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw new Error('Неверное имя груза');
        return join(appDir, 'downloads', opts.unpacked ? `${id}.d` : id);
      },
    },
    rpc: { handle: (m, fn) => rpc.handle(m, fn) },
    events: { emit: (name, data) => rpc.emit('$event', { name, data }) },
    processes: {
      spawn(command, args, options = {}) {
        const child = spawn(command, args, { windowsHide: true, ...options });
        if (child.pid) void rpc.call('$spawned', { pid: child.pid }, 5_000).catch(() => undefined);
        child.on('exit', () => void rpc.call('$exited', { pid: child.pid }, 5_000).catch(() => undefined));
        return child;
      },
    },
    lifecycle: {
      busy: (reason) => void rpc.call('$busy', { reason }, 5_000).catch(() => undefined),
      onStop: (fn) => void stops.push(fn),
      ready: () => {
        if (!readySaid) rpc.emit('$ready');
        readySaid = true;
      },
    },
    kernel: { call: (method, params, timeoutMs) => rpc.call(method, params, timeoutMs) },
    files: {
      // The person picks in Windows' own window (pc.files.pick); the paths are remembered as this app's.
      pick: (opts = {}) => rpc.call('files.pick', opts, 30 * 60_000),
      stat: (path) => rpc.call('files.stat', { path }),
      outputPath: (path, ext, opts = {}) => rpc.call('files.outputPath', { path, ext, ...opts }),
      remove: (path) => rpc.call('files.remove', { path }),
      reveal: (path) => rpc.call('files.reveal', { path }),
      open: (path) => rpc.call('files.open', { path }),
    },
    notify: (title, body) => rpc.call('notify', { title, body }),
    mcp: {
      /** A tool of this app for the AI (manifest: an MCP tool with handler 'pc:<name>', right pc.mcp). */
      handle: (name, fn) => void mcpHandlers.set(name, fn),
    },
    secrets: {
      // Sealed by the OS for this Windows user, only this app gets it back; keep the blob in its data folder.
      seal: async (data) => new Uint8Array(Buffer.from(await rpc.call('secrets.seal', { data: Buffer.from(typeof data === 'string' ? Buffer.from(data) : data).toString('base64') }), 'utf8')),
      unseal: async (sealed) => new Uint8Array(Buffer.from(await rpc.call('secrets.unseal', { sealed: Buffer.from(sealed).toString('utf8') }), 'base64')),
    },
    net: {
      /** A WebSocket through the program: wss:// to the hosts of its `net:` rights; resolves when it is open. */
      websocket: (url, protocols) =>
        new Promise((resolve, reject) => {
          rpc.call('net.websocket.open', { url, protocols }).then(({ id }) => {
            const s = { message: new Set(), close: new Set(), open: null };
            sockets.set(id, s);
            const socket = {
              send: (data) =>
                rpc.call('net.websocket.send', typeof data === 'string' ? { id, data } : { id, data: Buffer.from(data).toString('base64'), binary: true }),
              onMessage: (fn) => (s.message.add(fn), () => void s.message.delete(fn)),
              onClose: (fn) => (s.close.add(fn), () => void s.close.delete(fn)),
              close: (code, reason) => rpc.call('net.websocket.close', { id, code, reason }).catch(() => undefined),
            };
            s.open = () => resolve(socket);
            s.close.add((code, reason) => reject(Object.assign(new Error(`Соединение закрыто: ${code} ${reason}`), { code })));
          }, reject);
        }),
      fetch: async (url, init = {}) => {
        const body = init.body;
        const res = await rpc.call(
          'net.fetch',
          { url, method: init.method, headers: init.headers, ...(typeof body === 'string' ? { body } : body ? { bodyBase64: Buffer.from(body).toString('base64') } : {}) },
          90_000,
        );
        return { status: res.status, headers: res.headers, body: Buffer.from(res.bodyBase64, 'base64') };
      },
    },
  };
  // Ready after the part's own code has set its handlers (next turn of the loop), unless the part says it itself.
  if (!o.manualReady) setTimeout(() => api.lifecycle.ready(), 0);
  return api;
}

/**
 * In the part's process: waits for the program's hello. A built-in part runs in Electron's utilityProcess (a parentPort and a
 * message port); an installed app's part runs in Node mode under its rights and talks over Node's IPC channel (process.send) —
 * the same calls either way.
 */
export function connect(o = {}) {
  const parent = process.parentPort;
  if (!parent && typeof process.send === 'function') {
    return new Promise((resolve, reject) => {
      process.once('message', (hello) => {
        if (!hello || hello.type !== 'quadro-part') return reject(new Error('Bad hello from the kernel'));
        const port = {
          post: (m) => void process.send?.(m),
          onMessage: (fn) => void process.on('message', fn),
          close: () => process.disconnect?.(),
          onClose: (fn) => void process.on('disconnect', fn),
        };
        resolve(hostOn(port, hello, o));
      });
    });
  }
  if (!parent) return Promise.reject(new Error('Not started by the Quadro Hub kernel (no parentPort)'));
  return new Promise((resolve, reject) => {
    parent.once('message', (e) => {
      const hello = e.data;
      const raw = e.ports?.[0];
      if (!hello || hello.type !== 'quadro-part' || !raw) return reject(new Error('Bad hello from the kernel'));
      resolve(hostOn(nodePort(raw, (m) => m.data), hello, o));
    });
  });
}
