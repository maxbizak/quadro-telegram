import { describe, expect, it } from 'vitest';
import { hostWebSocket, telegramUrl, type PartSocketLike } from '../pc/host-websocket';
import { linksOf } from '../pc/links';
import { formatMessage, parseTime } from '../pc/service';
import { msg } from './stub-tg';

function fakeSocket() {
  const message = new Set<(d: Uint8Array | string) => void>();
  const close = new Set<(c: number, r: string) => void>();
  const sent: Uint8Array[] = [];
  const s: PartSocketLike = {
    send: async (d) => void sent.push(d as Uint8Array),
    onMessage: (fn) => (message.add(fn), () => void message.delete(fn)),
    onClose: (fn) => (close.add(fn), () => void close.delete(fn)),
    close: async () => undefined,
  };
  return { s, sent, push: (d: Uint8Array) => message.forEach((fn) => fn(d)), drop: () => close.forEach((fn) => fn(1006, '')) };
}

describe('teleproto’s WebSocket over the program’s', () => {
  it('opens only Telegram Web’s addresses', () => {
    expect(telegramUrl('wss://venus.web.telegram.org:443/apiws')).toBe('wss://venus.web.telegram.org/apiws');
    expect(telegramUrl('wss://pluto-1.web.telegram.org/apiws_test')).toBe('wss://pluto-1.web.telegram.org/apiws_test');
    for (const bad of ['ws://venus.web.telegram.org/apiws', 'wss://149.154.167.50:443/apiws', 'wss://evil.com/apiws', 'wss://venus.web.telegram.org.evil.com/apiws', 'wss://venus.web.telegram.org:8443/apiws', 'wss://venus.web.telegram.org/other'])
      expect(() => telegramUrl(bad)).toThrow();
  });

  it('frames sent before the socket opens wait for it; frames come as ArrayBuffer; a drop closes it', async () => {
    const f = fakeSocket();
    let opened = '';
    let release!: () => void;
    const ws = hostWebSocket(async (u) => {
      opened = u;
      await new Promise<void>((r) => (release = r));
      return f.s;
    }, 'wss://venus.web.telegram.org:443/apiws', 'binary');
    const events: string[] = [];
    const got: number[][] = [];
    ws.onopen = (() => events.push('open')) as never;
    ws.onmessage = ((e: { data: ArrayBuffer }) => got.push([...new Uint8Array(e.data)])) as never;
    ws.onclose = (() => events.push('close')) as never;
    ws.send(new Uint8Array([1, 2, 3]));
    expect(f.sent).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(opened).toBe('wss://venus.web.telegram.org/apiws');
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(['open']);
    expect([...f.sent[0]!]).toEqual([1, 2, 3]);
    f.push(new Uint8Array([10, 11]));
    expect(got).toEqual([[10, 11]]);
    f.drop();
    expect(events).toEqual(['open', 'close']);
    expect(() => ws.send(new Uint8Array([1]))).toThrow(/closed/);
  });

  it('a refused address never reaches the program', async () => {
    let asked = false;
    const ws = hostWebSocket(async () => ((asked = true), fakeSocket().s), 'wss://evil.com/apiws');
    const events: string[] = [];
    ws.onerror = (() => events.push('error')) as never;
    ws.onclose = (() => events.push('close')) as never;
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toBe(false);
    expect(events).toEqual(['error', 'close']);
  });
});

describe('links and words for the AI', () => {
  it('takes marked, hidden and bare addresses once each', () => {
    const text = 'Модель тут roblox.com/catalog/1 и ещё https://disk.yandex.ru/d/abc, готово';
    const links = linksOf(text, [{ kind: 'MessageEntityUrl', offset: 11, length: 20 }, { kind: 'MessageEntityTextUrl', offset: 0, length: 6, url: 'https://t.me/c/1/2' }], ['https://disk.yandex.ru/d/abc']);
    expect(links).toEqual(['https://roblox.com/catalog/1', 'https://t.me/c/1/2', 'https://disk.yandex.ru/d/abc']);
  });

  it('dates in the PC’s zone unless the AI names one', () => {
    expect(parseTime('2026-11-01', 'from', false, 180)).toBe(Date.parse('2026-10-31T21:00:00Z'));
    expect(parseTime('2026-11-01', 'to', true, 180)).toBe(Date.parse('2026-11-01T20:59:59.999Z'));
    expect(parseTime('2026-11-01T10:00:00Z', 'from', false, 180)).toBe(Date.parse('2026-11-01T10:00:00Z'));
    expect(parseTime('2026-11-01 10:00', 'from', false, 0)).toBe(Date.parse('2026-11-01T10:00:00Z'));
    expect(parseTime(undefined, 'from')).toBeNull();
    for (const bad of ['вчера', '01.11.2026', 5]) expect(() => parseTime(bad, 'from')).toThrow(/дата вида/);
  });

  it('a service message and a forwarded one', () => {
    expect(formatMessage(msg(5, 0, '', { service: 'закрепил сообщение' }), 0)).toBe('[2026-11-01 00:00] #5 Заказчик (@client): — закрепил сообщение');
    expect(formatMessage(msg(6, 0, 'текст', { forwardedFrom: 'Студия', replyTo: 5 }), 0)).toBe('[2026-11-01 00:00] #6 Заказчик (@client) ↩#5 (переслано от Студия): текст');
  });
});
