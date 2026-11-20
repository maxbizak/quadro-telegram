import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, TelegramService, type ApiKeys } from '../pc/service';
import { publisherKeysOf } from '../pc/publisher';
import { Store } from '../pc/store';
import type { TgFactory } from '../pc/types';
import { fakeSealer, msg, stubFactory, stubWorld, type StubChat } from './stub-tg';

const NOW = Date.parse('2026-11-20T12:00:00Z');
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qh-tg-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(world?: StubChat[], sealer: typeof fakeSealer | null = fakeSealer, publisher: { current: ApiKeys | null } = { current: null }) {
  const stub = stubFactory(world);
  const store = new Store(dir, sealer);
  const logins: Array<{ step: string; url?: string; wrong?: boolean }> = [];
  const service = new TelegramService({ store, factory: stub.factory, now: () => NOW, offsetMin: 180, onLogin: (s) => logins.push(s), publisherKeys: () => publisher.current });
  return { ...stub, store, service, logins, publisher };
}

async function signedIn(world?: StubChat[]) {
  const s = setup(world);
  await s.service.setKeys({ apiId: '123456', apiHash: '0123456789abcdef0123456789abcdef' });
  await s.service.sendCode({ phone: '+7 999 123-45-67' });
  await s.service.signIn({ code: '12345' });
  await s.service.password({ password: 'secret' });
  return s;
}

const allow = async (s: Awaited<ReturnType<typeof signedIn>>, ...ids: string[]) => {
  for (const id of ids) await s.service.setAccess({ id, allowed: true });
};

describe('sign-in on the screen', () => {
  it('checks the keys from my.telegram.org', async () => {
    const { service } = setup();
    await expect(service.setKeys({ apiId: 'abc', apiHash: '0123456789abcdef0123456789abcdef' })).rejects.toThrow(/api_id/);
    await expect(service.setKeys({ apiId: '123', apiHash: 'short' })).rejects.toThrow(/api_hash/);
    await expect(service.sendCode({ phone: '+79991234567' })).rejects.toThrow(/api_id и api_hash/);
  });

  it('phone → code → cloud password → signed in; the session is kept sealed, never in plain text', async () => {
    const { service, state } = setup();
    await service.setKeys({ apiId: '123456', apiHash: '0123456789ABCDEF0123456789ABCDEF' });
    expect(await service.sendCode({ phone: '8 (999) 123-45-67' }).catch((e: Error) => e.message)).toMatch(/кодом страны|\+/);
    expect(await service.sendCode({ phone: '+79991234567' })).toEqual({ step: 'code', viaApp: true });
    await expect(service.signIn({ code: '11111' })).rejects.toThrow(/Неверный код/);
    expect(await service.signIn({ code: '1 2 3 4 5' })).toEqual({ step: 'password', hint: 'кот' });
    await expect(service.password({ password: 'wrong' })).rejects.toThrow(/пароль/);
    expect(await service.password({ password: 'secret' })).toEqual({ step: 'done' });
    const status = await service.status();
    expect(status).toMatchObject({ canSeal: true, configured: true, signedIn: true, me: { name: 'Владелец' }, allowed: 0 });
    const disk = readFileSync(join(dir, 'secret.bin'), 'utf8');
    expect(disk.startsWith('SEALED:')).toBe(true);
    for (const plain of ['valid-session', '0123456789abcdef', '123456']) expect(disk).not.toContain(plain);
    // The phone is never written down whole.
    expect(state.calls.join(' ')).not.toMatch(/9991234567/);
  });

  it('by QR: the code on the screen, a new one every 30 s, the cloud password (a wrong one asked again), signed in', async () => {
    const { service, state, logins, store } = setup();
    await service.setKeys({ apiId: '123456', apiHash: '0123456789abcdef0123456789abcdef' });
    const first = await service.qrStart();
    expect(first).toMatchObject({ step: 'qr', url: 'tg://login?token=QR1' });
    expect((await service.status()).step).toBe('qr');
    state.newCode!();
    expect(logins.at(-1)).toMatchObject({ step: 'qr', url: 'tg://login?token=QR2' });
    state.scan!();
    await new Promise((r) => setTimeout(r, 10));
    expect(logins.at(-1)).toEqual({ step: 'password', hint: 'кот' });
    expect(await service.password({ password: 'wrong' })).toEqual({ step: 'password', hint: 'кот', wrong: true });
    expect(await service.password({ password: 'secret' })).toEqual({ step: 'done' });
    expect(logins.at(-1)).toEqual({ step: 'done' });
    expect(await service.status()).toMatchObject({ signedIn: true, me: { name: 'Владелец' } });
    expect(await store.secret()).toMatchObject({ session: 'valid-session' });
  });

  it('QR: leaving the screen stops it; nothing more arrives', async () => {
    const { service, state, logins } = setup();
    await service.setKeys({ apiId: '123456', apiHash: '0123456789abcdef0123456789abcdef' });
    await service.qrStart();
    const seen = logins.length;
    service.qrCancel();
    state.newCode!();
    await new Promise((r) => setTimeout(r, 10));
    expect(logins).toHaveLength(seen);
    expect(await service.status()).toMatchObject({ signedIn: false, step: null });
  });

  it('a new start reads the sealed session: signed in without a code', async () => {
    const first = await signedIn();
    await first.service.stop();
    const again = new TelegramService({ store: new Store(dir, fakeSealer), factory: stubFactory().factory, now: () => NOW });
    expect(await again.status()).toMatchObject({ signedIn: true });
  });

  it('without the program’s sealing nothing is kept: it asks to update the program', async () => {
    const { service } = setup(undefined, null);
    expect(await service.status()).toMatchObject({ canSeal: false, configured: false });
    await expect(service.setKeys({ apiId: '1', apiHash: '0123456789abcdef0123456789abcdef' })).rejects.toThrow(/обновите программу/);
  });

  it('«Выйти из Telegram» ends the session at Telegram and removes it from the PC', async () => {
    const s = await signedIn();
    await allow(s, '555');
    await s.service.logout({});
    expect(s.state.loggedOut).toBe(true);
    expect(await s.store.secret()).toMatchObject({ apiId: 123456, session: '' });
    expect(s.store.allowed()).toHaveLength(1);
    await s.service.logout({ keys: true });
    expect(existsSync(join(dir, 'secret.bin'))).toBe(false);
    expect(s.store.allowed()).toHaveLength(0);
  });
});

describe('keys: Quadro’s (the publisher’s) or the person’s own', () => {
  const QUADRO = { apiId: 777000, apiHash: 'abcdefabcdefabcdefabcdefabcdef12' };

  it('with Quadro’s keys there is no step of keys: straight to sign-in, the session remembers them', async () => {
    const { service, state, store } = setup(undefined, fakeSealer, { current: QUADRO });
    expect(await service.status()).toMatchObject({ configured: true, keys: 'publisher', publisherKeys: true, apiId: null, signedIn: false });
    await service.sendCode({ phone: '+79991234567' });
    expect(state.calls).toContain('connect 777000');
    await service.signIn({ code: '12345' });
    await service.password({ password: 'secret' });
    expect(await store.secret()).toMatchObject({ apiId: 777000, source: 'publisher', session: 'valid-session' });
  });

  it('a new publisher key never breaks a signed-in session; a new sign-in takes the new key', async () => {
    const pub = { current: QUADRO as ApiKeys | null };
    const s = setup(undefined, fakeSealer, pub);
    await s.service.sendCode({ phone: '+79991234567' });
    await s.service.signIn({ code: '12345' });
    await s.service.password({ password: 'secret' });
    await s.service.stop();
    pub.current = { apiId: 888000, apiHash: '0123456789abcdef0123456789abcdef' };
    expect(await s.service.status()).toMatchObject({ signedIn: true, keys: 'publisher' });
    expect((await s.store.secret())!.apiId).toBe(777000);
    await s.service.logout({});
    expect(await s.service.status()).toMatchObject({ signedIn: false, keys: 'publisher' });
    expect((await s.store.secret())!.apiId).toBe(888000);
  });

  it('own keys win over Quadro’s; «ключи Quadro» brings them back (signing in again)', async () => {
    const s = setup(undefined, fakeSealer, { current: QUADRO });
    await s.service.setKeys({ apiId: '123456', apiHash: '0123456789abcdef0123456789abcdef' });
    expect(await s.service.status()).toMatchObject({ keys: 'own', apiId: 123456 });
    await s.service.useQuadroKeys();
    expect(await s.service.status()).toMatchObject({ keys: 'publisher', apiId: null, signedIn: false });
    await s.service.setKeys({ apiId: '123456', apiHash: '0123456789abcdef0123456789abcdef' });
    await s.service.logout({ keys: true });
    expect(await s.service.status()).toMatchObject({ keys: 'publisher', configured: true });
  });

  it('Telegram refuses Quadro’s keys: the person is told to sign in with their own (own keys keep Telegram’s words)', async () => {
    const refused = () => Object.assign(new Error('Неверные api_id или api_hash — проверьте их на my.telegram.org'), { code: 'API_ID_INVALID' });
    const stub = stubFactory();
    const refusing: TgFactory = async (o) => ({
      ...(await stub.factory(o)),
      sendCode: async () => {
        throw refused();
      },
      qrLogin: async () => {
        throw refused();
      },
    });
    const service = new TelegramService({ store: new Store(dir, fakeSealer), factory: refusing, now: () => NOW, publisherKeys: () => QUADRO });
    await expect(service.sendCode({ phone: '+79991234567' })).rejects.toMatchObject({ code: 'PUBLISHER_KEYS_REFUSED', message: expect.stringMatching(/^Ключи Quadro не подошли Telegram/) });
    await expect(service.qrStart()).rejects.toThrow(/^Ключи Quadro не подошли Telegram — войдите со своими ключами/);
    await service.setKeys({ apiId: '123456', apiHash: '0123456789abcdef0123456789abcdef' });
    await expect(service.sendCode({ phone: '+79991234567' })).rejects.toThrow(/проверьте их на my\.telegram\.org/);
  });

  it('without Quadro’s keys: own keys first, «ключи Quadro» says there are none yet', async () => {
    const s = setup();
    expect(await s.service.status()).toMatchObject({ configured: false, keys: null, publisherKeys: false });
    await expect(s.service.useQuadroKeys()).rejects.toThrow(/Ключей Quadro пока нет/);
  });

  it('reads the publisher’s values (strings, as the program gives them) only in their exact form', () => {
    expect(publisherKeysOf({ publisher: { api_id: ' 777000 ', api_hash: 'ABCDEFABCDEFABCDEFABCDEFABCDEF12' } })).toEqual({ apiId: 777000, apiHash: 'abcdefabcdefabcdefabcdefabcdef12' });
    for (const bad of [null, {}, { publisher: {} }, { publisher: { api_id: '777000' } }, { publisher: { api_id: 'x', api_hash: 'abcdefabcdefabcdefabcdefabcdef12' } }, { publisher: { api_id: '1', api_hash: 'short' } }, { publisher: { api_id: '-5', api_hash: 'abcdefabcdefabcdefabcdefabcdef12' } }])
      expect(publisherKeysOf(bad)).toBeNull();
  });
});

describe('«Доступ для ИИ»: by default nothing', () => {
  it('the AI sees no chat until the person allows one', async () => {
    const s = await signedIn();
    expect((await s.service.aiChats()).text).toMatch(/ещё не разрешил/);
    for (const ref of ['555', '@ivan_p', 'Иван Петров', 'Мама', '777']) await expect(s.service.aiMessages({ chat: ref })).rejects.toThrow(/не разрешён/);
    await expect(s.service.aiSearch({ query: 'оплата' })).rejects.toThrow(/не разрешил/);
    // Nothing of Telegram was even asked for those.
    expect(s.state.calls.filter((c) => /^(read|search|message|download)/.test(c))).toEqual([]);
  });

  it('allowed chats only — by id, @name or title; the rest stay unseen, even in search', async () => {
    const s = await signedIn();
    const list = await s.service.chats({});
    expect(list.map((c) => [c.title, c.allowed])).toEqual([
      ['UGC работа', false],
      ['Иван Петров', false],
      ['Мама', false],
    ]);
    expect(list[0]).not.toHaveProperty('peer');
    await allow(s, '-1001234', '555');
    const chats = await s.service.aiChats();
    expect(chats.text).toContain('UGC работа');
    expect(chats.text).toContain('@ivan_p');
    expect(chats.text).not.toContain('Мама');
    for (const ref of ['555', '@IVAN_P', 'иван петров']) expect((await s.service.aiMessages({ chat: ref, from: '2026-11-01' })).text).toContain('Оплачу в пятницу');
    const found = await s.service.aiSearch({ query: 'опла', from: '2026-10-01' });
    expect(found.text).toContain('Оплачу в пятницу');
    expect(found.text).toContain('Оплатил за прошлую неделю');
    expect(found.text).not.toContain('Личное');
    expect(s.state.calls.some((c) => c.endsWith(' 777'))).toBe(false);
    await s.service.setAccess({ id: '555', allowed: false });
    await expect(s.service.aiMessages({ chat: '555' })).rejects.toThrow(/не разрешён/);
  });

  it('only chats of the person’s own Telegram can be allowed', async () => {
    const s = await signedIn();
    await expect(s.service.setAccess({ id: '999999', allowed: true })).rejects.toThrow(/нет в вашем Telegram/);
  });
});

describe('the AI reads a chat page by page', () => {
  it('a period, oldest first, with a cursor to the next page', async () => {
    const s = await signedIn();
    await allow(s, '-1001234');
    const p1 = await s.service.aiMessages({ chat: 'UGC работа', from: '2026-11-01', to: '2026-11-30', limit: 100 });
    expect(p1.data).toMatchObject({ count: 100, nextCursor: '100' });
    expect(p1.text).toMatch(/^Чат «UGC работа» \(chat=-1001234\), 2026-11-01 00:00 — 2026-11-30 23:59 \(UTC\+3\): 100 сообщ\. Есть ещё — вызовите снова с cursor=100\./);
    expect(p1.text).toContain('[2026-11-01 03:00] #1 Заказчик (@client): Задача 1');
    expect(p1.notice).toBe('ИИ прочитал 100 сообщ. в чате «UGC работа»');
    const p2 = await s.service.aiMessages({ chat: 'UGC работа', from: '2026-11-01', to: '2026-11-30', cursor: p1.data && (p1.data as { nextCursor: string }).nextCursor, limit: 100 });
    expect(p2.text).toContain('#101 ');
    const p3 = await s.service.aiMessages({ chat: 'UGC работа', from: '2026-11-01', to: '2026-11-30', cursor: '200', limit: 100 });
    expect(p3.data).toMatchObject({ count: 50, nextCursor: null });
    expect(p3.text).toContain('Это всё за период');
  });

  it('only the period asked; 30 days by default; a page is at most 300', async () => {
    const s = await signedIn();
    await allow(s, '-1001234');
    const day = await s.service.aiMessages({ chat: '-1001234', from: '2026-11-02T00:00:00Z', to: '2026-11-02T05:00:00Z' });
    expect(day.data).toMatchObject({ count: 6 });
    const big = await s.service.aiMessages({ chat: '-1001234', limit: 5000 });
    expect((big.data as { count: number }).count).toBeLessThanOrEqual(LIMITS.pageMax);
    await expect(s.service.aiMessages({ chat: '-1001234', from: 'вчера' })).rejects.toThrow(/дата вида/);
    await expect(s.service.aiMessages({ chat: '-1001234', from: '2026-11-10', to: '2026-11-01' })).rejects.toThrow(/позже/);
  });

  it('shows links and attachments, and keeps the answer within a few hundred KB', async () => {
    const world = stubWorld();
    world[0]!.messages = Array.from({ length: 300 }, (_, i) => msg(i + 1, i, 'Я'.repeat(9000)));
    world[0]!.messages[0] = msg(1, 0, 'Ссылка https://www.roblox.com/catalog/123 и текст', {
      links: ['https://www.roblox.com/catalog/123'],
      attachments: [{ kind: 'document', name: 'model.rbxm', size: 2048, downloadable: true }],
    });
    const s = await signedIn(world);
    await allow(s, '-1001234');
    const a = await s.service.aiMessages({ chat: '-1001234', from: '2026-11-01', limit: 300 });
    expect(a.text).toContain('  ссылки: https://www.roblox.com/catalog/123');
    expect(a.text).toContain('  вложение: файл «model.rbxm» 2 КБ (telegram_file message=1)');
    expect(a.text).toContain('[ещё 5000 знаков]');
    expect(a.text.length).toBeLessThanOrEqual(LIMITS.answerChars + 2000);
    expect((a.data as { nextCursor: string | null }).nextCursor).not.toBeNull();
  });
});

describe('files for the AI', () => {
  it('a photo as a picture, a text file as text, a PDF kept on the PC, a huge video only its preview', async () => {
    const s = await signedIn();
    await allow(s, '-1001234');
    const photo = await s.service.aiFile({ chat: '-1001234', message: 10 });
    expect(photo.images).toEqual([{ data: Buffer.from('JPEGDATA').toString('base64'), mimeType: 'image/jpeg' }]);
    const text = await s.service.aiFile({ chat: '-1001234', message: 30 });
    expect(text.text).toContain('Сделать 3 шапки, оплата 1500 R$');
    const pdf = await s.service.aiFile({ chat: '-1001234', message: 20 });
    const path = (pdf.data as { path: string }).path;
    expect(pdf.text).toContain('файл сохранён на ПК владельца');
    expect(readFileSync(path, 'utf8')).toContain('%PDF');
    expect(path.startsWith(join(dir, 'files'))).toBe(true);
    expect(pdf.images).toHaveLength(1);
    const video = await s.service.aiFile({ chat: '-1001234', message: 40 });
    expect(video.text).toMatch(/больше 50\.0 МБ/);
    expect(video.images).toHaveLength(1);
    expect(s.state.calls).not.toContain('download 1234 40');
    await expect(s.service.aiFile({ chat: '-1001234', message: 1 })).rejects.toThrow(/нет файла/);
    await expect(s.service.aiFile({ chat: '777', message: 1 })).rejects.toThrow(/не разрешён/);
  });

  it('reads the words of a Word file', async () => {
    const world = stubWorld();
    const xml = '<w:document><w:body><w:p><w:r><w:t>Счёт № 7</w:t></w:r></w:p><w:p><w:r><w:t>Шапка — 1500 R$ &amp; доставка</w:t></w:r></w:p></w:body></w:document>';
    world[0]!.messages[59] = msg(60, 59 * 60, 'docx', { attachments: [{ kind: 'document', name: 'счёт.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 500, downloadable: true }] });
    world[0]!.files[60] = { bytes: zip({ '[Content_Types].xml': '<x/>', 'word/document.xml': xml }), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'счёт.docx' };
    const s = await signedIn(world);
    await allow(s, '-1001234');
    const a = await s.service.aiFile({ chat: '-1001234', message: 60 });
    expect(a.text).toContain('Счёт № 7\nШапка — 1500 R$ & доставка');
  });
});

describe('«Что читал ИИ»', () => {
  it('writes when, which tool, which chats and how much — never what was in them', async () => {
    const s = await signedIn();
    await allow(s, '-1001234', '555');
    await s.service.aiMessages({ chat: '555', from: '2026-11-01' });
    await s.service.aiSearch({ query: 'опла', from: '2026-10-01' });
    await s.service.aiFile({ chat: '-1001234', message: 30 });
    await s.service.aiMessages({ chat: 'Мама' }).catch(() => undefined);
    const j = s.service.journal({});
    expect(j.map((e) => [e.tool, e.chats, e.messages, e.files, !!e.error])).toEqual([
      ['messages', [], 0, 0, true],
      ['file', ['UGC работа'], 0, 1, false],
      ['search', ['UGC работа', 'Иван Петров'], 2, 0, false],
      ['messages', ['Иван Петров'], 2, 0, false],
    ]);
    expect(j[2]!.query).toBe('опла');
    const disk = readFileSync(join(dir, 'journal.json'), 'utf8');
    for (const content of ['Оплачу в пятницу', 'Сделать 3 шапки', 'Личное']) expect(disk).not.toContain(content);
    s.service.clearJournal();
    expect(s.service.journal({})).toEqual([]);
  });

  it('read-only: no call of the client writes anything to Telegram', async () => {
    const s = await signedIn();
    await allow(s, '-1001234', '555');
    await s.service.aiMessages({ chat: '555', from: '2026-11-01' });
    await s.service.aiSearch({ query: 'задача' });
    await s.service.aiFile({ chat: '-1001234', message: 10 });
    const verbs = new Set(s.state.calls.map((c) => c.split(' ')[0]));
    expect([...verbs].sort()).toEqual(['authorized', 'chats', 'checkPassword', 'connect', 'download', 'message', 'read', 'search', 'sendCode', 'signIn']);
    expect(readdirSync(dir).sort()).toEqual(['access.json', 'files', 'journal.json', 'secret.bin'].filter((n) => n !== 'files' || existsSync(join(dir, 'files'))));
  });
});

/** A small ZIP (deflate) — for the .docx test. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(packed.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    centrals.push(c, n);
    offset += 30 + n.length + packed.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
