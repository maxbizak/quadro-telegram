import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Rpc, type Port } from '@quadrohub/pc-sdk';
import { buildPart } from '../scripts/build-pc.mjs';

// The built part (dist/pc/part.cjs: teleproto and pc-sdk inside) started the way the program starts an installed part — Node's IPC
// channel and the program's hello — with the test playing the program: Windows' sealing (a stand-in), and the program's
// WebSockets (it records what the part asks to open and send; Telegram itself is never reached).

const dirs: string[] = [];
let child: ChildProcess;
let rpc: Rpc;
let dataDir: string;
const opened: Array<{ url: string; protocols: unknown }> = [];
const frames: Buffer[] = [];
const other: string[] = [];

beforeAll(async () => {
  const work = mkdtempSync(join(tmpdir(), 'qh-tg-part-'));
  dirs.push(work);
  const part = await buildPart(join(work, 'pc', 'part.cjs'));
  dataDir = join(work, 'data');
  child = fork(part, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const token = 'test-token';
  const port: Port = {
    post: (m) => void child.send(m as never),
    onMessage: (fn) => void child.on('message', fn),
    close: () => child.kill(),
    onClose: (fn) => void child.on('exit', () => fn()),
  };
  rpc = new Rpc(port, token);
  rpc.handle('secrets.seal', (x) => `SEALED:${(x as { data: string }).data}`);
  rpc.handle('secrets.unseal', (x) => String((x as { sealed: string }).sealed).replace(/^SEALED:/, ''));
  let next = 0;
  rpc.handle('net.websocket.open', (x) => {
    const { url, protocols } = x as { url: string; protocols: unknown };
    opened.push({ url, protocols });
    // The first socket opens; later ones are refused, as if Telegram were unreachable.
    if (opened.length > 1) throw new Error('нет сети');
    const id = `ws${++next}`;
    setTimeout(() => rpc.emit('$ws', { id, type: 'open' }), 10);
    return { id };
  });
  rpc.handle('net.websocket.send', (x) => {
    const { id, data } = x as { id: string; data: string };
    frames.push(Buffer.from(data, 'base64'));
    // Telegram «hangs up» after the first frame.
    setTimeout(() => rpc.emit('$ws', { id, type: 'close', code: 1006, reason: 'test' }), 10);
    return true;
  });
  rpc.handle('net.websocket.close', () => true);
  rpc.handle('net.fetch', (x) => {
    other.push(`fetch ${(x as { url: string }).url}`);
    throw new Error('no');
  });
  const ready = new Promise<void>((resolve) => rpc.on('$ready', () => resolve()));
  child.send({ type: 'quadro-part', token, appId: 'quadro.telegram', dataDir, config: {} });
  await ready;
}, 60_000);

afterAll(async () => {
  await rpc.call('$stop', undefined, 5_000).catch(() => undefined);
  child?.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('the built part of «Telegram»', () => {
  it('starts with nothing: no keys, no session, sealing available', async () => {
    expect(await rpc.call('status')).toEqual({ canSeal: true, configured: false, keys: null, publisherKeys: false, apiId: null, signedIn: false, me: null, step: null, allowed: 0 });
  });

  it('keeps the keys sealed by the program', async () => {
    await rpc.call('setKeys', { apiId: 2040, apiHash: 'b18441a1ff607e10a989891a5462e627' });
    const disk = readFileSync(join(dataDir, 'secret.bin'), 'utf8');
    expect(disk.startsWith('SEALED:')).toBe(true);
    expect(disk).not.toContain('b18441a1ff607e10a989891a5462e627');
    expect(await rpc.call('status')).toMatchObject({ configured: true, apiId: 2040, signedIn: false });
  });

  it('teleproto goes to Telegram only through the program’s WebSocket, to Telegram Web’s address', async () => {
    await expect(rpc.call('sendCode', { phone: '+79990000000' }, 120_000)).rejects.toThrow();
    expect(opened[0]).toEqual({ url: 'wss://venus.web.telegram.org/apiws', protocols: 'binary' });
    for (const o of opened) expect(o.url).toMatch(/^wss:\/\/[a-z]+(-1)?\.web\.telegram\.org\/apiws$/);
    // MTProto's obfuscated transport starts with its 64-byte header.
    expect(frames[0]!.length).toBeGreaterThanOrEqual(64);
    expect(other).toEqual([]);
  }, 120_000);

  it('the AI’s tools answer only the AI; the screen’s methods only the screen', async () => {
    const chats = (await rpc.call('$mcp', { callId: 'c1', method: 'chats', params: {} })) as { text: string };
    expect(chats.text).toMatch(/ещё не разрешил/);
    await expect(rpc.call('$mcp', { callId: 'c2', method: 'messages', params: { chat: 'Мама' } })).rejects.toThrow(/не разрешён/);
    await expect(rpc.call('$mcp', { callId: 'c3', method: 'sendCode', params: { phone: '+79990000000' } })).rejects.toThrow(/Нет такого инструмента/);
    await expect(rpc.call('$mcp', { callId: 'c4', method: 'logout', params: {} })).rejects.toThrow(/Нет такого инструмента/);
    await expect(rpc.call('messages', { chat: 'Мама' })).rejects.toThrow(/Нет такого действия/);
    const journal = (await rpc.call('journal', {})) as Array<{ tool: string; error?: string }>;
    expect(journal.map((j) => j.tool)).toEqual(['messages', 'chats']);
  });

  it('has no way to send, delete or react: its methods are reading ones', async () => {
    for (const m of ['sendMessage', 'send', 'deleteMessages', 'react', 'forward', 'markRead']) {
      await expect(rpc.call(m, {})).rejects.toThrow(/Нет такого действия/);
      await expect(rpc.call('$mcp', { callId: m, method: m, params: {} })).rejects.toThrow(/Нет такого инструмента/);
    }
  });
});
