import { describe, expect, it } from 'vitest';
import { hostSocketClass, webSocketUrl, type PartSocketLike } from '../pc/host-socket';
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

describe('GramJS’s socket over the program’s WebSocket', () => {
  it('opens only Telegram Web’s addresses', () => {
    expect(webSocketUrl('venus.web.telegram.org')).toBe('wss://venus.web.telegram.org/apiws');
    expect(webSocketUrl('pluto-1.web.telegram.org', true)).toBe('wss://pluto-1.web.telegram.org/apiws_test');
    for (const bad of ['149.154.167.50', 'evil.com', 'venus.web.telegram.org.evil.com', 'a.b.web.telegram.org']) expect(() => webSocketUrl(bad)).toThrow();
  });

  it('reads exactly across frames, writes bytes, ends on a drop', async () => {
    const f = fakeSocket();
    let url = '';
    const Socket = hostSocketClass(async (u) => ((url = u), f.s));
    const sock = new Socket();
    await sock.connect(443, 'venus.web.telegram.org');
    expect(url).toBe('wss://venus.web.telegram.org/apiws');
    sock.write(Buffer.from([1, 2, 3]));
    expect(Buffer.from(f.sent[0]!)).toEqual(Buffer.from([1, 2, 3]));
    const reading = sock.readExactly(5);
    f.push(new Uint8Array([10, 11]));
    f.push(new Uint8Array([12, 13, 14, 15]));
    expect([...(await reading)]).toEqual([10, 11, 12, 13, 14]);
    expect([...(await sock.read(10))]).toEqual([15]);
    const waiting = sock.read(1);
    f.drop();
    await expect(waiting).rejects.toThrow(/closed/);
    expect(() => sock.write(Buffer.from([1]))).toThrow(/closed/);
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
