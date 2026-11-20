import { fork, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Rpc, type Port } from '@quadrohub/pc-sdk';
import { buildPart } from '../scripts/build-pc.mjs';

// The built part (dist/pc/part.cjs: teleproto and pc-sdk inside) started the way the program starts an installed part — Node's IPC
// channel and the program's hello — with the test playing the program: Windows' sealing (a stand-in), the program's WebSockets
// (it records what the part asks to open and send; Telegram itself is never reached) and the person's files (Windows' window
// gives an export's folder «to read»; the program reads in it only, in pieces, as base64 — as apps/desktop's files.ts).

const dirs: string[] = [];
let child: ChildProcess;
let rpc: Rpc;
let dataDir: string;
const opened: Array<{ url: string; protocols: unknown }> = [];
const frames: Buffer[] = [];
const other: string[] = [];
const picks: unknown[] = [];
let exportDir: string;

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
  // The person's export: its folder, picked in Windows' window to read.
  exportDir = join(work, 'Telegram Desktop', 'ChatExport_2026-11-20');
  mkdirSync(join(exportDir, 'photos'), { recursive: true });
  const sample = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'result-chat.json'), 'utf8')) as { messages: Array<Record<string, unknown>> };
  sample.messages = sample.messages.map((m) => (m.id === 412 ? { ...m, photo: 'photos/photo_412.jpg' } : m));
  writeFileSync(join(exportDir, 'result.json'), JSON.stringify(sample, null, 1));
  writeFileSync(join(exportDir, 'photos', 'photo_412.jpg'), 'JPEG412');
  const given = (p: unknown) => typeof p === 'string' && (p === exportDir || p.startsWith(exportDir + sep));
  rpc.handle('files.pick', (x) => {
    picks.push(x);
    return [exportDir];
  });
  rpc.handle('files.read', (x) => {
    const { path, offset = 0, length = 1 << 20 } = x as { path: string; offset?: number; length?: number };
    if (!given(path) || path === exportDir) throw new Error('Этот файл приложению не открыт');
    const size = statSync(path).size;
    const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buf, 0, buf.length, offset);
    } finally {
      closeSync(fd);
    }
    return { data: buf.toString('base64'), bytesRead: buf.length, size, eof: offset + buf.length >= size };
  });
  rpc.handle('files.list', (x) => {
    const { path } = x as { path: string };
    if (!given(path)) throw new Error('Эта папка приложению не открыта');
    return { items: readdirSync(path, { withFileTypes: true }).map((e) => ({ path: join(path, e.name), name: e.name, dir: e.isDirectory(), size: e.isFile() ? statSync(join(path, e.name)).size : 0 })), more: false };
  });
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
    expect(await rpc.call('status')).toEqual({ canSeal: true, configured: false, keys: null, publisherKeys: false, apiId: null, signedIn: false, me: null, step: null, allowed: 0, exports: { chats: 0, exportedAt: null }, files: { read: true, folder: true } });
  });

  it('reads an export the person picks where it lies — Windows\' window «to read», the program\'s pieces; no WebSocket opened', async () => {
    const started = (await rpc.call('importPick', { folder: true })) as { stage: string };
    expect(started.stage).toBe('picking');
    type Job = { stage: string; added: Array<Record<string, unknown>>; read: number; size: number };
    const going = (j: Job | null) => !j || j.stage === 'picking' || j.stage === 'reading';
    let job = null as Job | null;
    for (let i = 0; i < 200 && going(job); i++) {
      await new Promise((r) => setTimeout(r, 25));
      job = ((await rpc.call('importState')) as { job: Job | null }).job;
    }
    expect(job).toMatchObject({ stage: 'done', added: [expect.objectContaining({ title: 'UGC команда', messages: 6, withFiles: true })] });
    expect(job!.read).toBe(job!.size);
    expect(picks).toEqual([{ folder: true, read: true, title: 'Папка выгрузки Telegram Desktop' }]);
    expect(readFileSync(join(dataDir, 'exports.bin'), 'utf8').startsWith('SEALED:')).toBe(true);
    expect(opened).toEqual([]);
    await rpc.call('removeExport', {});
  });

  it('takes an export of Telegram Desktop from its screen with no keys (an older program) — sealed, no WebSocket opened', async () => {
    const text = readFileSync(join(__dirname, 'fixtures', 'result-chat.json'), 'utf8');
    const { id } = (await rpc.call('importStart', { size: text.length, exportedAt: Date.parse('2026-11-20T09:30:00Z') })) as { id: string };
    await rpc.call('importChunk', { id, text: text.slice(0, 1500) });
    await rpc.call('importChunk', { id, text: text.slice(1500) });
    const done = (await rpc.call('importEnd', { id })) as { added: Array<{ title: string; messages: number }> };
    expect(done.added).toEqual([expect.objectContaining({ title: 'UGC команда', messages: 6 })]);
    expect(await rpc.call('chats', {})).toEqual([expect.objectContaining({ title: 'UGC команда', source: 'export', allowed: false })]);
    expect(readFileSync(join(dataDir, 'exports.bin'), 'utf8').startsWith('SEALED:')).toBe(true);
    expect(opened).toEqual([]);
    await rpc.call('removeExport', {});
    expect(await rpc.call('exportsList')).toEqual([]);
  });

  it('keeps the keys sealed by the program', async () => {
    await rpc.call('setKeys', { apiId: 123456, apiHash: '5e7a1f0c9b2d4e6f8a1b3c5d7e9f0a2b' });
    const disk = readFileSync(join(dataDir, 'secret.bin'), 'utf8');
    expect(disk.startsWith('SEALED:')).toBe(true);
    expect(disk).not.toContain('5e7a1f0c9b2d4e6f8a1b3c5d7e9f0a2b');
    expect(await rpc.call('status')).toMatchObject({ configured: true, apiId: 123456, signedIn: false });
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
    // The screen «Работы и оплата» in Hub searches as the person: the same allowed chats, no line in «Что читал ИИ».
    await expect(rpc.call('search', { query: 'оплат' })).rejects.toThrow(/не разрешил/);
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
