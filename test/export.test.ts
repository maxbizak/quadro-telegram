import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExportReader, exportDate, markedId, mergeExports, parseExport } from '../pc/export';
import { TelegramService } from '../pc/service';
import { Store } from '../pc/store';
import { fakeSealer, stubFactory } from './stub-tg';

// «Выгрузка из Telegram Desktop»: chats without signing in and without keys. The screen reads result.json on this PC and hands
// its text to the part; the part reads it into the live client's messages, keeps it sealed, and the AI's tools read it — marked
// «по выгрузке от …», with no call to Telegram at all.

const CHAT = readFileSync(join(__dirname, 'fixtures', 'result-chat.json'), 'utf8');
const EXPORTED = '2026-11-20T09:30:00.000Z';
const NOW = Date.parse('2026-11-20T12:00:00Z');
const at = (unix: string) => new Date(Number(unix) * 1000).toISOString();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qh-tg-export-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('reading result.json', () => {
  it('one chat: its id as the live client marks it, messages oldest → newest with text, links, replies, files, service lines', () => {
    const [chat, ...rest] = parseExport(CHAT, EXPORTED);
    expect(rest).toEqual([]);
    expect(chat).toMatchObject({ id: '-1001987654321', kind: 'group', title: 'UGC команда', exportedAt: EXPORTED });
    expect(chat!.messages.map((m) => m.id)).toEqual([398, 399, 412, 415, 430, 431]);
    const byId = new Map(chat!.messages.map((m) => [m.id, m]));
    expect(byId.get(398)).toMatchObject({ service: 'добавил(а) участников', from: { id: '100', name: 'Макс' } });
    expect(byId.get(412)).toMatchObject({
      date: at('1795022520'),
      from: { id: '555', name: 'Иван Петров' },
      text: 'Сделал 3 шапки для UGC, вот превью. С тебя 1 500 ₽, жду оплату',
      links: ['https://www.roblox.com/catalog/123'],
      attachments: [{ kind: 'photo', description: 'не вошёл в выгрузку', downloadable: false }],
    });
    expect(byId.get(415)).toMatchObject({ replyTo: 412, editDate: at('1795025160') });
    expect(byId.get(430)!.attachments).toEqual([
      { kind: 'document', name: 'крылья.rbxm', mime: 'application/octet-stream', size: 482133, description: 'в папке выгрузки: files/крылья.rbxm', downloadable: false },
    ]);
    expect(byId.get(431)).toMatchObject({ forwardedFrom: 'Roblox UGC биржа', links: ['https://t.me/ugc_birzha/1201'] });
  });

  it('all data at once: chats and left chats; a chat with no messages is left out', () => {
    const one = JSON.parse(CHAT);
    const all = {
      about: 'Here is the data you requested.',
      chats: {
        about: '…',
        list: [
          { ...one, id: 4821, type: 'personal_chat', name: 'Иван Петров' },
          { name: 'Старая группа', type: 'private_group', id: 777, messages: [{ id: 5, type: 'message', date: '2026-10-01T12:00:00', from: 'Аня', from_id: 'user9', text: 'привет' }] },
          { name: 'Пусто', type: 'public_channel', id: 99, messages: [] },
        ],
      },
      left_chats: { about: '…', list: [{ name: 'Канал UGC', type: 'public_channel', id: 1009, messages: [{ id: 3, type: 'message', date_unixtime: '1790000000', from: 'Канал UGC', from_id: 'channel1009', text: 'новости' }] }] },
    };
    const chats = parseExport(JSON.stringify(all), EXPORTED);
    expect(chats.map((c) => [c.id, c.kind, c.title])).toEqual([
      ['4821', 'user', 'Иван Петров'],
      ['-777', 'group', 'Старая группа'],
      ['-1001009', 'channel', 'Канал UGC'],
    ]);
    // A date without date_unixtime (older exports) — the local time of the PC that made it.
    expect(chats[1]!.messages[0]!.date).toBe(new Date('2026-10-01T12:00:00').toISOString());
  });

  it('says in words what is wrong: HTML, not JSON, no chats, too big', () => {
    expect(() => parseExport('<!DOCTYPE html><html>', EXPORTED)).toThrow(/HTML.*Машиночитаемый JSON/);
    expect(() => parseExport('{ oops', EXPORTED)).toThrow(/не читается как JSON/);
    expect(() => parseExport('{"personal_information":{}}', EXPORTED)).toThrow(/нет чатов/);
    expect(() => parseExport(`﻿${CHAT}`, EXPORTED)).not.toThrow();
    expect(markedId('private_supergroup', '-1001')).toBe('-1001');
    expect(markedId('bot_chat', 'x')).toBeNull();
  });

  it('a chat exported again replaces its older copy', () => {
    const [a] = parseExport(CHAT, '2026-11-01T00:00:00.000Z');
    const [b] = parseExport(CHAT, EXPORTED);
    expect(mergeExports([a!], [b!]).map((c) => c.exportedAt)).toEqual([EXPORTED]);
    expect(exportDate(EXPORTED)).toMatch(/^20\.11\.2026$/);
  });
});

describe('the reader: like the live client', () => {
  const reader = new ExportReader(parseExport(CHAT, EXPORTED));
  const peer = { type: 'channel' as const, id: '-1001987654321' };

  it('reads a period oldest → newest, page after page', async () => {
    const page = await reader.read(peer, { fromMs: Date.parse('2026-11-10T00:00:00Z'), toMs: NOW, limit: 2 });
    expect(page.map((m) => m.id)).toEqual([399, 412]);
    expect((await reader.read(peer, { fromMs: 0, toMs: NOW, afterId: 412, limit: 10 })).map((m) => m.id)).toEqual([415, 430, 431]);
  });

  it('searches newest first, by any case and ё/е, in text and file names', async () => {
    expect((await reader.search(peer, 'ОПЛАТ', { limit: 10 })).map((m) => m.id)).toEqual([431, 430, 415, 412]);
    expect((await reader.search(peer, 'перевел', { limit: 10 })).map((m) => m.id)).toEqual([399]);
    expect((await reader.search(peer, 'rbxm', { limit: 10 })).map((m) => m.id)).toEqual([430]);
    expect(await reader.search({ ...peer, id: '42' }, 'оплат', { limit: 10 })).toEqual([]);
    expect(await reader.message(peer, 415)).toMatchObject({ text: 'Оплатил, проверь' });
    expect(await reader.download()).toBeNull();
  });
});

function setup(sealer: typeof fakeSealer | null = fakeSealer) {
  const stub = stubFactory();
  const store = new Store(dir, sealer);
  const service = new TelegramService({ store, factory: stub.factory, now: () => NOW, offsetMin: 180 });
  return { ...stub, store, service };
}

/** As the screen does: the file's text in pieces. */
async function load(service: TelegramService, text = CHAT, piece = 1000) {
  const { id } = service.importStart({ size: text.length, exportedAt: Date.parse(EXPORTED) });
  for (let i = 0; i < text.length; i += piece) service.importChunk({ id, text: text.slice(i, i + piece) });
  return service.importEnd({ id });
}

describe('without keys and without signing in', () => {
  it('the person loads an export: its chats come to «Доступ для ИИ», closed; Telegram is never asked', async () => {
    const s = setup();
    expect((await s.service.status()).exports).toEqual({ chats: 0, exportedAt: null });
    const done = await load(s.service);
    expect(done.added).toEqual([expect.objectContaining({ id: '-1001987654321', title: 'UGC команда', messages: 6, exportedAt: EXPORTED })]);
    expect((await s.service.status()).exports).toEqual({ chats: 1, exportedAt: EXPORTED });
    const chats = await s.service.chats({});
    expect(chats).toEqual([expect.objectContaining({ id: '-1001987654321', source: 'export', exportedAt: EXPORTED, messages: 6, allowed: false })]);
    expect(s.state.calls).toEqual([]);
    // Kept sealed by Windows (no content in clear on the disk), read again after a restart.
    expect(readFileSync(join(dir, 'exports.bin'), 'utf8')).not.toContain('шапки');
    const again = new TelegramService({ store: new Store(dir, fakeSealer), factory: s.factory, now: () => NOW });
    expect((await again.exportsList()).map((c) => c.title)).toEqual(['UGC команда']);
  });

  it('the AI reads only what the person allowed, marked «по выгрузке от …»; the export\'s files are told, never opened', async () => {
    const s = setup();
    await load(s.service);
    await expect(s.service.aiSearch({ query: 'оплат' })).rejects.toThrow(/не разрешил/);
    await s.service.setAccess({ id: '-1001987654321', allowed: true });
    expect(s.store.allowed()).toEqual([expect.objectContaining({ id: '-1001987654321', source: 'export' })]);

    const chats = await s.service.aiChats();
    expect(chats.text).toContain('UGC команда — группа, chat=-1001987654321 (по выгрузке от 20.11.2026: новее сообщений в нём нет)');

    // No period: the export's last 30 days (not the 30 days before now).
    const read = await s.service.aiMessages({ chat: 'UGC команда' });
    expect(read.text).toMatch(/^Чат «UGC команда» \(chat=-1001987654321, по выгрузке от 20\.11\.2026\), .*: 6 сообщ\./);
    expect(read.text).toContain('Сделал 3 шапки для UGC, вот превью. С тебя 1 500 ₽, жду оплату');

    const found = await s.service.aiSearch({ query: 'оплат' });
    expect(found.text).toContain('Чат «UGC команда» (chat=-1001987654321, по выгрузке от 20.11.2026) — 4:');
    const data = found.data as { items: Array<Record<string, unknown>> };
    expect(data.items.find((w) => w.id === 412)).toMatchObject({ amount: '1 500 ₽', paid: 'yes', paidBy: 415, link: 'https://t.me/c/1987654321/412', exportedAt: EXPORTED });
    expect(data.items.find((w) => w.id === 430)).toMatchObject({ amount: '400 robux', paid: 'no' });

    const file = await s.service.aiFile({ chat: '-1001987654321', message: 430 });
    expect(file.text).toContain('«крылья.rbxm», 471 КБ — в папке выгрузки: files/крылья.rbxm');
    expect(file.text).toContain('ИИ не открывает');
    expect(file.images).toBeUndefined();
    expect(s.state.calls).toEqual([]);
    expect(s.service.journal({}).map((j) => j.tool)).toEqual(['file', 'search', 'messages', 'chats', 'search']);
  });

  it('removing the export takes it from the AI at once; «Выйти… и удалить всё» removes exports too', async () => {
    const s = setup();
    await load(s.service);
    await s.service.setAccess({ id: '-1001987654321', allowed: true });
    await s.service.removeExport({ id: '-1001987654321' });
    expect(s.store.allowed()).toEqual([]);
    expect(await s.service.exportsList()).toEqual([]);
    await expect(s.service.aiMessages({ chat: '-1001987654321' })).rejects.toThrow(/не разрешён/);
    await load(s.service);
    await s.service.logout({ keys: true });
    expect((await s.service.status()).exports).toEqual({ chats: 0, exportedAt: null });
  });

  it('refuses a broken upload in words; without Windows\' sealing nothing is kept', async () => {
    const s = setup();
    expect(() => s.service.importChunk({ id: 'nope', text: 'x' })).toThrow(/прервалась/);
    const { id } = s.service.importStart({ size: 5, exportedAt: Date.parse(EXPORTED) });
    expect(() => s.service.importChunk({ id, text: '123456' })).toThrow(/больше/);
    await expect(load(s.service, '<html></html>')).rejects.toThrow(/HTML/);
    expect(() => s.service.importStart({ size: 300_000_000 })).toThrow(/слишком большая/);
    const plain = setup(null);
    await expect(load(plain.service)).rejects.toThrow(/обновите программу/);
  });
});
