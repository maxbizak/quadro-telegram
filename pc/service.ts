import { extname } from 'node:path';
import type { AllowedChat, JournalEntry, Store } from './store';
import type { Downloaded, LoginState, Me, TgApi, TgChat, TgFactory, TgMessage } from './types';
import { docxText } from './zip-text';

// «Telegram»'s part on the PC: the person signs in on its screen; the AI reads only the chats the person allowed, page by page,
// and every read is written down for the person («что читал ИИ»). Read-only: no tool sends, deletes, marks as read or reacts.

export const LIMITS = {
  /** Messages per page: default and most. */
  pageDefault: 100,
  pageMax: 300,
  /** One message's text in an answer. */
  messageChars: 4000,
  /** An answer's text: a few hundred KB at most. */
  answerChars: 300_000,
  /** Search: results per chat and in all. */
  searchPerChat: 50,
  searchMax: 200,
  /** Days read when the AI names no period. */
  defaultDays: 30,
  /** Pictures (the program shrinks them to 1600 px). */
  imageBytes: 8 * 1024 * 1024,
  /** Text files read as text. */
  textBytes: 2 * 1024 * 1024,
  textChars: 200_000,
  /** Other files kept on the PC for the AI. */
  saveBytes: 50 * 1024 * 1024,
  /** Dialogs shown on the screen. */
  dialogs: 500,
} as const;

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.log', '.xml', '.yml', '.yaml', '.ini', '.cfg', '.toml', '.lua', '.luau', '.ts', '.tsx', '.js', '.jsx', '.py', '.html', '.htm', '.css', '.sql', '.rtf', '.srt']);
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const KIND_WORD: Record<string, string> = { photo: 'фото', image: 'картинка', video: 'видео', audio: 'аудио', voice: 'голосовое', document: 'файл', sticker: 'стикер', webpage: 'ссылка', contact: 'контакт', location: 'место', poll: 'опрос', other: 'вложение' };

export interface McpAnswer {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  data?: unknown;
  notice?: string;
}

export class UserError extends Error {
  constructor(
    message: string,
    readonly code = 'BAD_REQUEST',
  ) {
    super(message);
  }
}

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1048576).toFixed(1)} МБ`);

/** «2026-11-12 14:03» in the PC's time zone. */
export function localTime(iso: string, offsetMin = -new Date(iso).getTimezoneOffset()): string {
  const d = new Date(Date.parse(iso) + offsetMin * 60_000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function zoneName(offsetMin = -new Date().getTimezoneOffset()): string {
  const h = Math.trunc(Math.abs(offsetMin) / 60);
  const m = Math.abs(offsetMin) % 60;
  return `UTC${offsetMin < 0 ? '−' : '+'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** A time the AI gave: ISO date or date-time, in the PC's time zone unless it names one; null — not given. */
export function parseTime(v: unknown, what: string, endOfDay = false, offsetMin = -new Date().getTimezoneOffset()): number | null {
  if (v == null || v === '') return null;
  const bad = () => new UserError(`${what}: дата вида 2026-11-01 или 2026-11-01T18:00`);
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(v.trim())) throw bad();
  const s = v.trim().replace(' ', 'T');
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const full = dateOnly ? `${s}T${endOfDay ? '23:59:59.999' : '00:00:00'}` : s;
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(full);
  const t = Date.parse(zoned ? full : `${full}Z`) - (zoned ? 0 : offsetMin * 60_000);
  if (!Number.isFinite(t)) throw bad();
  return t;
}

/** One message as lines for the AI. */
export function formatMessage(m: TgMessage, offsetMin?: number): string {
  const who = m.from ? `${m.from.name}${m.from.username ? ` (@${m.from.username})` : ''}` : 'канал';
  const head = `[${localTime(m.date, offsetMin)}] #${m.id} ${who}${m.replyTo ? ` ↩#${m.replyTo}` : ''}${m.forwardedFrom ? ` (переслано от ${m.forwardedFrom})` : ''}${m.editDate ? ' (изменено)' : ''}:`;
  if (m.service) return `${head} — ${m.service}`;
  let text = m.text;
  if (text.length > LIMITS.messageChars) text = `${text.slice(0, LIMITS.messageChars)}… [ещё ${text.length - LIMITS.messageChars} знаков]`;
  const lines = [text ? `${head} ${text}` : head];
  if (m.links.length) lines.push(`  ссылки: ${m.links.join(' ')}`);
  for (const a of m.attachments) {
    const parts = [KIND_WORD[a.kind] ?? a.kind];
    if (a.name) parts.push(`«${a.name}»`);
    if (a.size) parts.push(kb(a.size));
    if (a.title) parts.push(`«${a.title}»`);
    if (a.description) parts.push(`— ${a.description.slice(0, 200)}`);
    if (a.downloadable) parts.push(`(telegram_file message=${m.id})`);
    lines.push(`  вложение: ${parts.join(' ')}`);
  }
  return lines.join('\n');
}

/** api_id and api_hash of a Telegram application. */
export interface ApiKeys {
  apiId: number;
  apiHash: string;
}

export interface ServiceDeps {
  store: Store;
  factory: TgFactory;
  /** The publisher's keys («ключи Quadro»), when the platform gives them to the part; null — only the person's own. */
  publisherKeys?: () => ApiKeys | null;
  now?: () => number;
  /** The PC's time zone offset in minutes (tests fix it). */
  offsetMin?: number;
  /** A new line of «Что читал ИИ» (the open screen shows it at once). */
  onRead?: (entry: JournalEntry) => void;
  /** The QR sign-in moved on: a new code, the password asked, done or stopped (the open screen follows it). */
  onLogin?: (state: LoginState) => void;
}

/** A QR sign-in under way. */
interface QrFlow {
  abort: AbortController;
  state: LoginState;
  /** The cloud password Telegram asks for, waiting for the screen. */
  password: ((p: string) => void) | null;
  /** Who waits for the next state (the screen's call). */
  waiters: Array<(s: LoginState) => void>;
}

export class TelegramService {
  private client: TgApi | null = null;
  private connecting: Promise<TgApi> | null = null;
  private loginStep: LoginState['step'] | null = null;
  private dialogs: { at: number; list: TgChat[] } | null = null;
  private me: Me | null = null;
  private qr: QrFlow | null = null;

  constructor(private readonly d: ServiceDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  // ——— The connection ———

  private async connect(): Promise<TgApi> {
    if (this.client && !this.client.alive()) await this.stop();
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const s = await this.keys();
      if (!s) throw new UserError('Сначала укажите api_id и api_hash на экране приложения Telegram', 'NOT_CONFIGURED');
      const c = await this.d.factory({ apiId: s.apiId, apiHash: s.apiHash, session: s.session });
      this.client = c;
      return c;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** The signed-in client, or the reason in words. */
  private async signedIn(): Promise<TgApi> {
    const c = await this.connect();
    if (!(await c.authorized())) throw new UserError('Telegram не подключён: владелец входит в аккаунт на экране приложения Telegram', 'NOT_SIGNED_IN');
    return c;
  }

  /**
   * The keys of the session: the person's own if they set them; otherwise the publisher's — taken anew until a session is made
   * with them (a later change of the publisher's keys never breaks a signed-in session: it keeps the keys it was made with).
   */
  private async keys() {
    const s = await this.d.store.secret();
    if (s && (s.source === 'own' || s.session)) return s;
    const pub = this.d.publisherKeys?.() ?? null;
    if (!pub) return s;
    const fresh = { ...pub, session: '', source: 'publisher' as const };
    if (!s || s.apiId !== pub.apiId || s.apiHash !== pub.apiHash) await this.d.store.saveSecret(fresh);
    return fresh;
  }

  private async keepSession(c: TgApi): Promise<void> {
    const s = await this.d.store.secret();
    if (s) await this.d.store.saveSecret({ ...s, session: c.session() });
  }

  async stop(): Promise<void> {
    this.qr?.abort.abort();
    this.qr = null;
    const c = this.client;
    this.client = null;
    await c?.close();
  }

  // ——— The screen ———

  async status() {
    const s = this.d.store.canSeal ? await this.keys() : null;
    const publisher = !!this.d.publisherKeys?.();
    let signedIn = false;
    if (s?.session) {
      try {
        const c = await this.connect();
        signedIn = await c.authorized();
        if (signedIn && !this.me) this.me = await c.me();
      } catch {
        signedIn = false;
      }
    }
    return {
      canSeal: this.d.store.canSeal,
      configured: !!s,
      /** Whose keys: the person's own, the publisher's («ключи Quadro») or none yet. */
      keys: s?.source ?? null,
      /** The publisher's keys can be used (the screen offers «ключи Quadro»). */
      publisherKeys: publisher,
      apiId: s?.source === 'own' ? s.apiId : null,
      signedIn,
      me: signedIn ? this.me : null,
      step: signedIn ? 'done' : this.loginStep,
      allowed: this.d.store.allowed().length,
    };
  }

  async setKeys(x: unknown): Promise<{ ok: true }> {
    const apiId = Number(String(obj(x).apiId ?? '').trim());
    const apiHash = String(obj(x).apiHash ?? '').trim().toLowerCase();
    if (!Number.isInteger(apiId) || apiId <= 0 || apiId > 2 ** 31) throw new UserError('api_id — число с my.telegram.org');
    if (!/^[0-9a-f]{32}$/.test(apiHash)) throw new UserError('api_hash — 32 знака (цифры и буквы a–f) с my.telegram.org');
    await this.stop();
    this.me = null;
    this.loginStep = null;
    this.dialogs = null;
    await this.d.store.saveSecret({ apiId, apiHash, session: '', source: 'own' });
    return { ok: true };
  }

  /** Back to the publisher's keys («ключи Quadro»): the session of the own keys ends (signing in again is needed). */
  async useQuadroKeys(): Promise<{ ok: true }> {
    const pub = this.d.publisherKeys?.();
    if (!pub) throw new UserError('Ключей Quadro пока нет — войдите со своими ключами', 'NO_PUBLISHER_KEYS');
    await this.logout({});
    await this.d.store.saveSecret({ ...pub, session: '', source: 'publisher' });
    return { ok: true };
  }

  /** Telegram refused the keys: the publisher's ones the person cannot check — they are told to sign in with their own. */
  private async keysRefused(e: unknown): Promise<Error> {
    const code = (e as { code?: unknown } | null)?.code;
    const err = e instanceof Error ? e : new Error(String(e));
    if (code !== 'API_ID_INVALID' && code !== 'API_ID_PUBLISHED_FLOOD') return err;
    return (await this.d.store.secret())?.source === 'publisher'
      ? new UserError('Ключи Quadro не подошли Telegram — войдите со своими ключами api_id и api_hash (ссылка ниже)', 'PUBLISHER_KEYS_REFUSED')
      : err;
  }

  async sendCode(x: unknown): Promise<LoginState> {
    const phone = String(obj(x).phone ?? '').replace(/[\s()-]/g, '');
    if (!/^\+\d{7,15}$/.test(phone)) throw new UserError('Номер телефона с плюсом и кодом страны, например +79991234567');
    const c = await this.connect();
    let r: LoginState;
    try {
      r = await c.sendCode(phone);
    } catch (e) {
      throw await this.keysRefused(e);
    }
    this.loginStep = r.step;
    return r;
  }

  private async finishLogin(r: LoginState, c: TgApi): Promise<LoginState> {
    this.loginStep = r.step;
    if (r.step === 'done') {
      this.loginStep = null;
      this.me = await c.me();
      await this.keepSession(c);
    }
    return r;
  }

  async signIn(x: unknown): Promise<LoginState> {
    const code = String(obj(x).code ?? '').replace(/\D/g, '');
    if (code.length < 4 || code.length > 8) throw new UserError('Код из Telegram — 5 цифр');
    const c = await this.connect();
    return this.finishLogin(await c.signIn(code), c);
  }

  async password(x: unknown): Promise<LoginState> {
    const password = String(obj(x).password ?? '');
    if (!password) throw new UserError('Введите облачный пароль Telegram');
    const flow = this.qr;
    if (flow?.password) {
      const give = flow.password;
      flow.password = null;
      const next = this.nextQrState(flow);
      give(password);
      const r = await next;
      if (r.step === 'error') throw new UserError(r.message ?? 'Вход не удался');
      return r;
    }
    const c = await this.connect();
    return this.finishLogin(await c.checkPassword(password), c);
  }

  // ——— Sign-in by QR ———

  private nextQrState(flow: QrFlow, ms = 120_000): Promise<LoginState> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(flow.state), ms);
      t.unref?.();
      flow.waiters.push((s) => {
        clearTimeout(t);
        resolve(s);
      });
    });
  }

  private qrState(flow: QrFlow, state: LoginState): void {
    if (this.qr !== flow) return;
    flow.state = state;
    this.loginStep = state.step === 'error' ? null : state.step;
    for (const w of flow.waiters.splice(0)) w(state);
    this.d.onLogin?.(state);
  }

  /** Starts the QR sign-in: the first code comes back; new ones (and the rest) come as `onLogin`. */
  async qrStart(): Promise<LoginState> {
    if (this.qr) {
      this.qr.abort.abort();
      this.qr = null;
    }
    const c = await this.connect();
    if (await c.authorized()) return { step: 'done' };
    const flow: QrFlow = { abort: new AbortController(), state: { step: 'qr' }, password: null, waiters: [] };
    this.qr = flow;
    const first = this.nextQrState(flow, 30_000);
    c.qrLogin({
      onQr: (url, expiresMs) => this.qrState(flow, { step: 'qr', url, expiresMs }),
      password: (o) =>
        new Promise<string>((resolve) => {
          flow.password = resolve;
          this.qrState(flow, { step: 'password', ...(o.hint ? { hint: o.hint } : {}), ...(o.wrong ? { wrong: true } : {}) });
        }),
      signal: flow.abort.signal,
    }).then(
      async () => {
        if (this.qr !== flow) return;
        this.me = await c.me();
        await this.keepSession(c);
        this.qrState(flow, { step: 'done' });
        this.qr = null;
      },
      async (e: unknown) => {
        if (flow.abort.signal.aborted) return;
        const err = await this.keysRefused(e);
        if (flow.abort.signal.aborted) return;
        this.qrState(flow, { step: 'error', message: err.message });
        this.qr = null;
      },
    );
    const r = await first;
    if (r.step === 'error') throw new UserError(r.message ?? 'Вход по QR не удался');
    if (r.step === 'qr' && !r.url) throw new UserError('Telegram не прислал QR-код — попробуйте ещё раз', 'TIMEOUT');
    return r;
  }

  /** Stops the QR sign-in (the screen left it). */
  qrCancel(): { ok: true } {
    this.qr?.abort.abort();
    this.qr = null;
    this.loginStep = null;
    return { ok: true };
  }

  /** «Выйти из Telegram»: ends the session on Telegram's side and removes it from the PC; `keys` — the api keys and lists too. */
  async logout(x: unknown): Promise<{ ok: true }> {
    const keys = obj(x).keys === true;
    try {
      const c = this.client ?? ((await this.d.store.secret())?.session ? await this.connect() : null);
      if (c && (await c.authorized())) await c.logOut();
    } catch {
      // Offline or already ended: the session is removed from the PC anyway.
    }
    await this.stop();
    await this.d.store.forget(keys);
    this.me = null;
    this.loginStep = null;
    this.dialogs = null;
    return { ok: true };
  }

  /** The person's chats for «Доступ для ИИ» (newest first), each with its mark. */
  async chats(x: unknown) {
    const refresh = obj(x).refresh === true;
    const c = await this.signedIn();
    if (refresh || !this.dialogs || this.now() - this.dialogs.at > 60_000) this.dialogs = { at: this.now(), list: await c.chats(LIMITS.dialogs) };
    const allowed = new Set(this.d.store.allowed().map((a) => a.id));
    return this.dialogs.list.map(({ peer: _peer, ...chat }) => ({ ...chat, allowed: allowed.has(chat.id) }));
  }

  /** Marks a chat readable by the AI or not. Only a chat of the person's own list (the part knows how to reach it). */
  async setAccess(x: unknown) {
    const id = String(obj(x).id ?? '');
    const allow = obj(x).allowed === true;
    let list = this.d.store.allowed().filter((a) => a.id !== id);
    if (allow) {
      const chat = this.dialogs?.list.find((ch) => ch.id === id) ?? (await this.chats({ refresh: true }), this.dialogs?.list.find((ch) => ch.id === id));
      if (!chat) throw new UserError('Такого чата нет в вашем Telegram');
      list = [...list, { id: chat.id, kind: chat.kind, title: chat.title, ...(chat.username ? { username: chat.username } : {}), peer: chat.peer, since: new Date(this.now()).toISOString() }];
    }
    this.d.store.setAllowed(list);
    return { allowed: list.map(({ peer: _peer, ...a }) => a) };
  }

  access() {
    return this.d.store.allowed().map(({ peer: _peer, ...a }) => a);
  }

  journal(x: unknown) {
    const limit = Math.min(500, Math.max(1, Number(obj(x).limit ?? 100) || 100));
    return this.d.store.journal().slice(0, limit);
  }

  clearJournal() {
    this.d.store.clearJournal();
    return { ok: true };
  }

  // ——— The AI (MCP tools; only the allowed chats) ———

  /** A chat the AI named — id, @username or title — among the allowed ones only; otherwise it learns nothing of the rest. */
  private allowedChat(ref: unknown): AllowedChat {
    const raw = String(ref ?? '').trim();
    if (!raw) throw new UserError('Укажите чат: id, @имя или название из telegram_chats');
    const list = this.d.store.allowed();
    const low = raw.toLowerCase().replace(/^@/, '');
    const found = list.find((a) => a.id === raw) ?? list.find((a) => a.username?.toLowerCase() === low) ?? list.filter((a) => a.title.toLowerCase() === raw.toLowerCase()).at(0);
    if (!found) throw new UserError('Этот чат ИИ не разрешён (или его нет). Разрешённые — telegram_chats; разрешает владелец в приложении Telegram → «Доступ для ИИ»', 'NOT_ALLOWED');
    return found;
  }

  private log(e: Omit<JournalEntry, 'at'>): void {
    const entry = { at: new Date(this.now()).toISOString(), ...e };
    this.d.store.addJournal(entry);
    this.d.onRead?.(entry);
  }

  private async aiCall<T extends McpAnswer>(tool: string, fn: () => Promise<{ answer: T; entry: Omit<JournalEntry, 'at' | 'tool' | 'bytes'> }>): Promise<T> {
    try {
      const { answer, entry } = await fn();
      const bytes = Buffer.byteLength(answer.text) + (answer.images ?? []).reduce((n, i) => n + Math.round((i.data.length * 3) / 4), 0);
      this.log({ tool, bytes, ...entry });
      return answer;
    } catch (e) {
      this.log({ tool, chats: [], messages: 0, files: 0, bytes: 0, error: (e as Error).message.slice(0, 200) });
      throw e;
    }
  }

  async aiChats(): Promise<McpAnswer> {
    return this.aiCall('chats', async () => {
      const list = this.d.store.allowed();
      const kinds = { user: 'личный', bot: 'бот', group: 'группа', channel: 'канал' } as const;
      const text = list.length
        ? [`Чаты Telegram, которые владелец разрешил читать (${list.length}):`, ...list.map((a) => `- ${a.title} — ${kinds[a.kind]}, chat=${a.id}${a.username ? `, @${a.username}` : ''}`)].join('\n')
        : 'Владелец ещё не разрешил ИИ ни одного чата. Он отмечает чаты в приложении Telegram в Quadro Hub → «Доступ для ИИ».';
      return { answer: { text, data: { chats: list.map((a) => ({ id: a.id, title: a.title, kind: a.kind, username: a.username ?? null })) } }, entry: { chats: [], messages: 0, files: 0 } };
    });
  }

  async aiMessages(x: unknown, signal?: AbortSignal): Promise<McpAnswer> {
    return this.aiCall('messages', async () => {
      const p = obj(x);
      const chat = this.allowedChat(p.chat);
      const toMs = parseTime(p.to, 'to', true, this.d.offsetMin) ?? this.now();
      const fromMs = parseTime(p.from, 'from', false, this.d.offsetMin) ?? toMs - LIMITS.defaultDays * 86_400_000;
      if (fromMs > toMs) throw new UserError('from позже, чем to');
      const limit = Math.min(LIMITS.pageMax, Math.max(1, Number(p.limit ?? LIMITS.pageDefault) || LIMITS.pageDefault));
      const afterId = p.cursor != null && p.cursor !== '' ? Number(p.cursor) : undefined;
      if (afterId !== undefined && (!Number.isInteger(afterId) || afterId < 0)) throw new UserError('cursor — число из прошлого ответа (nextCursor)');
      const c = await this.signedIn();
      const got = await c.read(chat.peer, { fromMs, toMs, ...(afterId ? { afterId } : {}), limit: limit + 1 });
      if (signal?.aborted) throw new UserError('ИИ отменил вызов', 'ABORTED');
      // Up to the page's size and the answer's size; the rest — the next page.
      const lines: string[] = [];
      let used = 0;
      let taken = 0;
      for (const m of got.slice(0, limit)) {
        const line = formatMessage(m, this.d.offsetMin);
        if (used + line.length > LIMITS.answerChars && taken > 0) break;
        lines.push(line);
        used += line.length + 1;
        taken++;
      }
      const more = got.length > taken;
      const last = got[taken - 1];
      const nextCursor = more && last ? String(last.id) : null;
      const period = `${localTime(new Date(fromMs).toISOString(), this.d.offsetMin)} — ${localTime(new Date(toMs).toISOString(), this.d.offsetMin)} (${zoneName(this.d.offsetMin)})`;
      const header = `Чат «${chat.title}» (chat=${chat.id}), ${period}: ${taken} сообщ.${nextCursor ? ` Есть ещё — вызовите снова с cursor=${nextCursor}.` : ' Это всё за период.'}`;
      const text = [header, '', ...lines].join('\n');
      return {
        answer: { text, data: { chat: chat.id, count: taken, nextCursor }, notice: `ИИ прочитал ${taken} сообщ. в чате «${chat.title}»` },
        entry: { chats: [chat.title], messages: taken, files: 0 },
      };
    });
  }

  async aiSearch(x: unknown, signal?: AbortSignal): Promise<McpAnswer> {
    return this.aiCall('search', async () => {
      const p = obj(x);
      const query = String(p.query ?? '').trim();
      if (!query) throw new UserError('query — что искать');
      if (query.length > 200) throw new UserError('query — до 200 знаков');
      const chats = p.chat != null && p.chat !== '' ? [this.allowedChat(p.chat)] : this.d.store.allowed();
      if (!chats.length) throw new UserError('Владелец ещё не разрешил ИИ ни одного чата', 'NOT_ALLOWED');
      const fromMs = parseTime(p.from, 'from', false, this.d.offsetMin) ?? undefined;
      const toMs = parseTime(p.to, 'to', true, this.d.offsetMin) ?? undefined;
      const limit = Math.min(LIMITS.searchMax, Math.max(1, Number(p.limit ?? 50) || 50));
      const c = await this.signedIn();
      const blocks: string[] = [];
      let found = 0;
      let used = 0;
      for (const chat of chats) {
        if (signal?.aborted) throw new UserError('ИИ отменил вызов', 'ABORTED');
        if (found >= limit || used > LIMITS.answerChars) break;
        const list = await c.search(chat.peer, query, { limit: Math.min(LIMITS.searchPerChat, limit - found), ...(fromMs ? { fromMs } : {}), ...(toMs ? { toMs } : {}) });
        if (!list.length) continue;
        const lines = [];
        for (const m of list) {
          const line = formatMessage(m, this.d.offsetMin);
          if (used + line.length > LIMITS.answerChars) break;
          lines.push(line);
          used += line.length + 1;
          found++;
        }
        blocks.push(`Чат «${chat.title}» (chat=${chat.id}) — ${lines.length}:\n${lines.join('\n')}`);
      }
      const text = found ? [`Поиск «${query}»: ${found} сообщ. (новые первыми)`, '', ...blocks].join('\n\n') : `Поиск «${query}»: ничего не найдено в разрешённых чатах.`;
      return {
        answer: { text, data: { query, count: found }, notice: `ИИ искал «${query.slice(0, 40)}» в ${chats.length === 1 ? `чате «${chats[0]!.title}»` : `${chats.length} чатах`}` },
        entry: { chats: chats.map((ch) => ch.title), messages: found, files: 0, query },
      };
    });
  }

  async aiFile(x: unknown, signal?: AbortSignal): Promise<McpAnswer> {
    return this.aiCall('file', async () => {
      const p = obj(x);
      const chat = this.allowedChat(p.chat);
      const id = Number(p.message);
      if (!Number.isInteger(id) || id <= 0) throw new UserError('message — номер сообщения (#… из telegram_messages)');
      const c = await this.signedIn();
      const m = await c.message(chat.peer, id);
      if (!m) throw new UserError('Нет такого сообщения в этом чате');
      const att = m.attachments.find((a) => a.downloadable);
      if (!att) throw new UserError('У этого сообщения нет файла или картинки');
      const done = (answer: McpAnswer, files = 1) => ({ answer: { ...answer, notice: `ИИ открыл файл из чата «${chat.title}»` }, entry: { chats: [chat.title], messages: 0, files } });
      const about = `Сообщение #${id} в чате «${chat.title}»: ${KIND_WORD[att.kind] ?? att.kind}${att.name ? ` «${att.name}»` : ''}${att.size ? `, ${kb(att.size)}` : ''}`;
      const ext = extname(att.name ?? '').toLowerCase();
      const isImage = att.kind === 'photo' || (att.kind === 'image' && IMAGE_MIME.has(att.mime ?? '')) || (att.kind === 'webpage' && att.downloadable);
      const isText = (att.mime ?? '').startsWith('text/') || TEXT_EXT.has(ext) || /json|xml|csv/.test(att.mime ?? '');
      const isDocx = ext === '.docx';

      if (isImage) {
        const f = await c.download(chat.peer, id, { maxBytes: LIMITS.imageBytes, ...(signal ? { signal } : {}) });
        if (!f) throw new UserError('Картинку не удалось получить');
        return done({ text: `${about}. Картинка ниже.`, images: [{ data: f.bytes.toString('base64'), mimeType: IMAGE_MIME.has(f.mime) ? f.mime : 'image/jpeg' }] });
      }
      if ((isText || isDocx) && (!att.size || att.size <= LIMITS.textBytes)) {
        const f = await c.download(chat.peer, id, { maxBytes: LIMITS.textBytes, ...(signal ? { signal } : {}) });
        if (!f) throw new UserError('Файл не удалось получить');
        let body = isDocx ? docxText(f.bytes) : f.bytes.toString('utf8');
        if (body == null) return this.saved(about, f, chat, done);
        const cut = body.length > LIMITS.textChars;
        if (cut) body = body.slice(0, LIMITS.textChars);
        return done({ text: `${about}. Текст файла${cut ? ` (первые ${LIMITS.textChars} знаков)` : ''}:\n\n${body}` });
      }
      // Video, audio, PDF, archives…: its preview picture if there is one, and the file itself on this PC.
      const images: McpAnswer['images'] = [];
      if (att.kind === 'video' || att.kind === 'document' || att.kind === 'sticker') {
        const thumb = await c.download(chat.peer, id, { maxBytes: LIMITS.imageBytes, thumb: true }).catch(() => null);
        if (thumb) images.push({ data: thumb.bytes.toString('base64'), mimeType: 'image/jpeg' });
      }
      if (att.size && att.size > LIMITS.saveBytes) {
        return done({ text: `${about}. Файл больше ${kb(LIMITS.saveBytes)} — его не скачиваю; владелец может открыть его в Telegram.${images.length ? ' Превью ниже.' : ''}`, ...(images.length ? { images } : {}) }, images.length);
      }
      const f = await c.download(chat.peer, id, { maxBytes: LIMITS.saveBytes, ...(signal ? { signal } : {}) });
      if (!f) throw new UserError('Файл не удалось получить');
      const answer = await this.saved(about, f, chat, done);
      if (images.length) answer.answer.images = images;
      return answer;
    });
  }

  private async saved(about: string, f: Downloaded, chat: AllowedChat, done: (a: McpAnswer, files?: number) => { answer: McpAnswer; entry: Omit<JournalEntry, 'at' | 'tool' | 'bytes'> }) {
    const safe = `${chat.id}-${f.name}`.replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 150);
    const path = this.d.store.saveFile(safe, f.bytes);
    return done({ text: `${about}. Содержимое как текст не прочитать — файл сохранён на ПК владельца: ${path}`, data: { path, mime: f.mime, size: f.bytes.length } });
  }
}
