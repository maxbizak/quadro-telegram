import type { Downloaded, LoginState, PeerRef, ReadOptions, SearchOptions, TgApi, TgChat, TgFactory, TgMessage } from '../pc/types';

// A stand-in of Telegram for the tests (no network, no real account): a few chats with messages and files, the login of a
// made-up account (code 12345, cloud password «secret»). Every call is written down: the tests check nothing but reading happens.

export interface StubFile {
  bytes: Buffer;
  mime: string;
  name: string;
  thumb?: Buffer;
}

export interface StubChat extends TgChat {
  messages: TgMessage[];
  files: Record<number, StubFile>;
}

const T0 = Date.parse('2026-11-01T00:00:00Z');

export function msg(id: number, minutes: number, text: string, extra: Partial<TgMessage> = {}): TgMessage {
  return { id, date: new Date(T0 + minutes * 60_000).toISOString(), from: { id: '7', name: 'Заказчик', username: 'client' }, text, links: [], attachments: [], ...extra };
}

export function stubWorld(): StubChat[] {
  const work: StubChat = {
    id: '-1001234',
    kind: 'group',
    title: 'UGC работа',
    peer: { type: 'channel', id: '1234', accessHash: '99' },
    messages: Array.from({ length: 250 }, (_, i) => msg(i + 1, i * 60, `Задача ${i + 1}: шапка для аватара`)),
    files: {},
  };
  work.messages[9] = msg(10, 9 * 60, 'Скрин готовой шапки', { attachments: [{ kind: 'photo', mime: 'image/jpeg', downloadable: true }] });
  work.files[10] = { bytes: Buffer.from('JPEGDATA'), mime: 'image/jpeg', name: '10.jpg' };
  work.messages[19] = msg(20, 19 * 60, 'Счёт', { attachments: [{ kind: 'document', name: 'invoice.pdf', mime: 'application/pdf', size: 1000, downloadable: true }] });
  work.files[20] = { bytes: Buffer.from('%PDF-1.7 счёт'), mime: 'application/pdf', name: 'invoice.pdf', thumb: Buffer.from('THUMB') };
  work.messages[29] = msg(30, 29 * 60, 'ТЗ', { attachments: [{ kind: 'document', name: 'brief.txt', mime: 'text/plain', size: 30, downloadable: true }] });
  work.files[30] = { bytes: Buffer.from('Сделать 3 шапки, оплата 1500 R$'), mime: 'text/plain', name: 'brief.txt' };
  work.messages[39] = msg(40, 39 * 60, 'Видео', { attachments: [{ kind: 'video', name: 'big.mp4', mime: 'video/mp4', size: 300 * 1024 * 1024, downloadable: true }] });
  work.files[40] = { bytes: Buffer.alloc(0), mime: 'video/mp4', name: 'big.mp4', thumb: Buffer.from('VIDEOTHUMB') };
  work.messages[49] = msg(50, 49 * 60, 'Оплатил за прошлую неделю https://example.com/receipt', { links: ['https://example.com/receipt'] });
  const ivan: StubChat = {
    id: '555',
    kind: 'user',
    title: 'Иван Петров',
    username: 'ivan_p',
    peer: { type: 'user', id: '555', accessHash: '42' },
    messages: [msg(1, 10, 'Когда будет модель?'), msg(2, 20, 'Оплачу в пятницу')],
    files: {},
  };
  const secret: StubChat = {
    id: '777',
    kind: 'user',
    title: 'Мама',
    peer: { type: 'user', id: '777', accessHash: '1' },
    messages: [msg(1, 5, 'Личное — ИИ это видеть не должен, оплата')],
    files: {},
  };
  return [work, ivan, secret];
}

export interface StubState {
  calls: string[];
  sessions: string[];
  authorized: boolean;
  loggedOut: boolean;
  /** QR sign-in in the stand-in: the phone «scans» the code; Telegram gives a new code. */
  scan?: () => void;
  newCode?: () => void;
}

export function stubFactory(world: StubChat[] = stubWorld(), state: StubState = { calls: [], sessions: [], authorized: false, loggedOut: false }): { factory: TgFactory; state: StubState; world: StubChat[] } {
  const find = (peer: PeerRef) => world.find((c) => c.peer.type === peer.type && c.peer.id === peer.id) ?? null;
  const factory: TgFactory = async (o) => {
    state.calls.push(`connect ${o.apiId}`);
    state.sessions.push(o.session);
    if (o.session === 'valid-session') state.authorized = true;
    let phase: 'none' | 'code' | 'password' = 'none';
    const api: TgApi = {
      alive: () => true,
      authorized: async () => (state.calls.push('authorized'), state.authorized),
      me: async () => ({ id: '1', name: 'Владелец', username: 'owner' }),
      sendCode: async (phone) => {
        state.calls.push(`sendCode ${phone.replace(/\d(?=\d{2})/g, '•')}`);
        phase = 'code';
        return { step: 'code', viaApp: true } satisfies LoginState;
      },
      signIn: async (code) => {
        state.calls.push('signIn');
        if (phase !== 'code') throw new Error('Сначала запросите код');
        if (code !== '12345') throw new Error('Неверный код');
        phase = 'password';
        return { step: 'password', hint: 'кот' };
      },
      checkPassword: async (password) => {
        state.calls.push('checkPassword');
        if (phase !== 'password' || password !== 'secret') throw new Error('Неверный облачный пароль');
        state.authorized = true;
        return { step: 'done' };
      },
      qrLogin: async (q) => {
        state.calls.push('qrLogin');
        let n = 0;
        const code = () => q.onQr(`tg://login?token=QR${++n}`, Date.now() + 30_000);
        code();
        state.newCode = code;
        await new Promise<void>((resolve, reject) => {
          state.scan = resolve;
          q.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
        // The account has a cloud password: asked until it is right.
        for (let wrong = false; ; wrong = true) {
          if ((await q.password({ hint: 'кот', wrong })) === 'secret') break;
        }
        state.authorized = true;
      },
      logOut: async () => {
        state.calls.push('logOut');
        state.loggedOut = true;
        state.authorized = false;
      },
      session: () => (state.authorized ? 'valid-session' : ''),
      chats: async (limit) => (state.calls.push('chats'), world.slice(0, limit).map(({ messages: _m, files: _f, ...c }) => c)),
      read: async (peer, r: ReadOptions) => {
        state.calls.push(`read ${peer.id}`);
        const c = find(peer);
        if (!c) throw new Error('CHANNEL_PRIVATE');
        return c.messages.filter((m) => Date.parse(m.date) >= r.fromMs && Date.parse(m.date) <= r.toMs && (!r.afterId || m.id > r.afterId)).slice(0, r.limit);
      },
      search: async (peer, query, s: SearchOptions) => {
        state.calls.push(`search ${peer.id}`);
        const c = find(peer);
        return (c?.messages ?? [])
          .filter((m) => m.text.toLowerCase().includes(query.toLowerCase()) && (!s.fromMs || Date.parse(m.date) >= s.fromMs) && (!s.toMs || Date.parse(m.date) <= s.toMs))
          .reverse()
          .slice(0, s.limit);
      },
      message: async (peer, id) => (state.calls.push(`message ${peer.id} ${id}`), find(peer)?.messages.find((m) => m.id === id) ?? null),
      download: async (peer, id, d) => {
        state.calls.push(`download ${peer.id} ${id}${d.thumb ? ' thumb' : ''}`);
        const f = find(peer)?.files[id];
        if (!f) return null;
        if (d.thumb) return f.thumb ? { bytes: f.thumb, mime: 'image/jpeg', name: `${id}-preview.jpg`, kind: 'photo' } : null;
        const m = find(peer)?.messages.find((x) => x.id === id);
        const size = m?.attachments[0]?.size ?? f.bytes.length;
        if (size > d.maxBytes) throw new Error('TOO_LARGE');
        return { bytes: f.bytes, mime: f.mime, name: f.name, kind: m?.attachments[0]?.kind ?? 'document' } satisfies Downloaded;
      },
      close: async () => void state.calls.push('close'),
    };
    return api;
  };
  return { factory, state, world };
}

/** Windows' sealing, as the tests see it: reversible only here, and never the plain text on disk. */
export const fakeSealer = {
  seal: async (data: Uint8Array | string) => new Uint8Array(Buffer.from(`SEALED:${Buffer.from(typeof data === 'string' ? Buffer.from(data) : data).toString('base64').split('').reverse().join('')}`)),
  unseal: async (sealed: Uint8Array) => {
    const s = Buffer.from(sealed).toString('utf8');
    if (!s.startsWith('SEALED:')) throw new Error('not sealed by this app');
    return new Uint8Array(Buffer.from(s.slice(7).split('').reverse().join(''), 'base64'));
  },
};
