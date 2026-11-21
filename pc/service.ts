import { extname, win32 } from 'node:path';
import type { AllowedChat, JournalEntry, Store } from './store';
import { EXPORT_MAX_CHARS, ExportError, ExportReader, exportDate, folderDate, mergeExports, parseExport, type ExportChat, type ExportFileReader } from './export';
import type { Downloaded, LoginState, Me, PeerRef, TgApi, TgChat, TgFactory, TgMessage } from './types';
import { worksData } from './works';
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
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

/** The person's files through the program (pc.files.pick): Windows' own window, then reading where the files lie. */
export interface PartFiles {
  pick(o: { multiple?: boolean; folder?: boolean; read?: boolean; extensions?: string[]; title?: string }): Promise<string[]>;
  read(path: string, o?: { offset?: number; length?: number }): Promise<{ data: Uint8Array; size: number; eof: boolean }>;
  /** `mtime` — when a file was last written (program 1.0.106+; an older one gives none). */
  list(path: string, o?: { recursive?: boolean; after?: string }): Promise<{ items: Array<{ path: string; name: string; dir: boolean; size: number; mtime?: string }>; more: boolean }>;
  /** A picked file's facts (its `mtime` since program 1.0.106). */
  stat?(path: string): Promise<{ exists: boolean; mtime?: string | null }>;
}

/**
 * When an export was made: the time Telegram Desktop wrote its result.json (the program tells it since 1.0.106), else the date in
 * its folder's name (ChatExport_2026-11-20), else null — the newest message's date (parseExport).
 */
export function exportTime(mtime: string | null | undefined, folder: string): string | null {
  const t = typeof mtime === 'string' ? Date.parse(mtime) : NaN;
  // A real time: not in the future (a clock off by a day), not before Telegram exported JSON at all (2018).
  if (Number.isFinite(t) && t <= Date.now() + 86_400_000 && t >= Date.UTC(2018, 0, 1)) return new Date(t).toISOString();
  return folderDate(folder);
}

/** Reading an export the person picked: in the background, the screen follows it (importState). */
export interface ImportJob {
  id: string;
  /** picking — Windows' window is open; reading — the part reads the files; then done, error, or cancelled (nothing picked). */
  stage: 'picking' | 'reading' | 'done' | 'error' | 'cancelled';
  /** The export's whole folder was asked (its pictures too), not only result.json. */
  folder: boolean;
  /** The export being read (its folder's name), which one of how many. */
  name: string | null;
  index: number;
  files: number;
  /** Bytes read of how many. */
  read: number;
  size: number;
  added: ExportSummary[];
  /** Exports of the folder that could not be read (an HTML one, a broken file) — the others are taken. */
  skipped: Array<{ name: string; error: string }>;
  chats: number;
  error: string | null;
}

export interface ExportSummary {
  id: string;
  kind: ExportChat['kind'];
  title: string;
  exportedAt: string;
  messages: number;
  firstAt: string | null;
  lastAt: string | null;
  /** Its folder was given to read: the AI can open its pictures and text files. */
  withFiles: boolean;
}

/** A path the program never gave this app: refused by a program that reads files, «нет такого действия» by an older one. */
const PROBE_FILE = 'C:\\Quadro\\telegram\\probe\\result.json';
const PROBE_DIR = 'C:\\Quadro\\telegram\\probe';
/** One piece of reading a picked file (the program gives at most 4 MB). */
const READ_PIECE = 4 * 1024 * 1024;
/** The most of one result.json read (bytes; the text must also fit EXPORT_MAX_CHARS). */
const EXPORT_MAX_BYTES = 600_000_000;
/** In a folder of exports: so many of its folders looked into, so many exports taken at once. */
const MAX_SUBFOLDERS = 60;
const MAX_EXPORTS = 30;
const NO_RESULT = 'В этой папке нет result.json: выберите папку, которую сделал Telegram Desktop (ChatExport_… или DataExport_…), — формат выгрузки «Машиночитаемый JSON»';

export interface ServiceDeps {
  store: Store;
  /** The person's files (pc.files.pick); none — the screen reads the file and hands it over (an older program). */
  files?: PartFiles;
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
  /** The loaded exports (read once from the sealed file) and the reader over them. */
  private exportsCache: { chats: ExportChat[]; reader: ExportReader } | null = null;
  /** A result.json coming from the screen in pieces (an older program: the screen reads the file, the part cannot). */
  private uploads = new Map<string, { parts: string[]; size: number; exportedAt: string; at: number }>();
  /** The export the person picked, read in the background. */
  private job: ImportJob | null = null;
  /** What the program lets the part do with picked files (asked once). */
  private fileRights: Promise<{ read: boolean; folder: boolean }> | null = null;

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
    if (!(await c.authorized())) throw new UserError('Telegram не подключён: владелец входит в аккаунт на экране приложения Telegram или загружает там выгрузку из Telegram Desktop', 'NOT_SIGNED_IN');
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
      /** Loaded exports of Telegram Desktop: how many chats, the newest export's time. */
      exports: await this.exportsInfo(),
      /** The program reads a picked file (read) and a picked folder (folder) for the part; else the screen reads result.json. */
      files: await this.fileAccess(),
    };
  }

  // ——— Exports of Telegram Desktop (no sign-in, no keys) ———

  private async loadedExports(): Promise<{ chats: ExportChat[]; reader: ExportReader }> {
    if (!this.exportsCache) this.setExports(await this.d.store.exports());
    return this.exportsCache!;
  }

  private setExports(chats: ExportChat[]): void {
    this.exportsCache = { chats, reader: new ExportReader(chats, this.readExportFile) };
  }

  /**
   * A file of an export's folder for the AI, read where it lies — the program reads only inside the folder the person gave to
   * read (never a program, never past it by a link). At most `maxBytes`.
   */
  private readonly readExportFile: ExportFileReader = async (path, maxBytes, signal) => {
    const files = this.d.files;
    if (!files) throw new UserError('Эта версия программы Quadro Hub не даёт приложению читать файлы выгрузки — владелец обновляет программу');
    const out: Buffer[] = [];
    for (let offset = 0; ; ) {
      signal?.throwIfAborted();
      let piece;
      try {
        piece = await files.read(path, { offset, length: Math.max(1, Math.min(READ_PIECE, maxBytes - offset)) });
      } catch (e) {
        throw new UserError(`Файл выгрузки не прочитать (${errText(e)}): если папку выгрузки переместили или удалили, владелец загружает её снова на экране приложения Telegram`);
      }
      if (offset === 0 && piece.size > maxBytes) throw new UserError(`Файл больше ${kb(maxBytes)} — его не читаю; он лежит на ПК владельца: ${path}`);
      out.push(Buffer.from(piece.data));
      offset += piece.data.length;
      if (piece.eof || !piece.data.length || offset >= maxBytes) break;
    }
    return Buffer.concat(out);
  };

  private async exportsInfo(): Promise<{ chats: number; exportedAt: string | null }> {
    const { chats } = await this.loadedExports();
    const newest = chats.map((c) => c.exportedAt).sort().at(-1) ?? null;
    return { chats: chats.length, exportedAt: newest };
  }

  // ——— The export the person picks (the program reads it where it lies) ———

  /** What this program lets the part do with the person's files: read a picked file; read a picked folder. */
  private fileAccess(): Promise<{ read: boolean; folder: boolean }> {
    const f = this.d.files;
    if (!f) return Promise.resolve({ read: false, folder: false });
    // An older program has no such action; this one refuses a path it never gave — the answer itself tells which.
    const has = (call: () => Promise<unknown>) =>
      Promise.resolve()
        .then(call)
        .then(
          () => true,
          (e) => !/Нет такого действия|is not a function/.test(errText(e)),
        );
    this.fileRights ??= Promise.all([has(() => f.read(PROBE_FILE, { offset: 0, length: 1 })), has(() => f.list(PROBE_DIR))]).then(([read, folder]) => ({ read, folder: read && folder }));
    return this.fileRights;
  }

  /** For the screen: what can be picked, and the export being read (or the last one read) — the screen follows it. */
  async importState() {
    return { access: await this.fileAccess(), job: this.job ? { ...this.job } : null };
  }

  /**
   * «Выбрать папку выгрузки» (folder) or «Выбрать result.json»: Windows' own window of the program; the part then reads the export
   * where it lies, in the background (a 2 GB result.json takes a while) — the screen follows importState.
   */
  async importPick(x: unknown): Promise<ImportJob> {
    if (this.job && (this.job.stage === 'picking' || this.job.stage === 'reading')) return { ...this.job };
    const access = await this.fileAccess();
    if (!access.read || !this.d.files) throw new UserError('Эта версия программы Quadro Hub не даёт приложению прочитать выбранный файл: обновите программу или выберите result.json кнопкой «Выбрать файл»', 'NO_FILES');
    if (!this.d.store.canSeal) throw new UserError('Программа Quadro Hub не умеет шифровать данные приложения: обновите программу');
    const folder = obj(x).folder !== false && access.folder;
    const job: ImportJob = { id: `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, stage: 'picking', folder, name: null, index: 0, files: 0, read: 0, size: 0, added: [], skipped: [], chats: 0, error: null };
    this.job = job;
    void this.runImport(job, this.d.files);
    return { ...job };
  }

  private async runImport(job: ImportJob, files: PartFiles): Promise<void> {
    try {
      const picked = job.folder
        ? await files.pick({ folder: true, read: true, title: 'Папка выгрузки Telegram Desktop' })
        : await files.pick({ multiple: false, extensions: ['json'], title: 'result.json из папки выгрузки Telegram Desktop' });
      if (this.job !== job) return;
      const first = picked[0];
      if (!first) {
        job.stage = 'cancelled';
        return;
      }
      const targets = job.folder
        ? await this.exportsIn(files, first)
        : [{ file: first, folder: null, name: win32.basename(win32.dirname(first)), mtime: files.stat ? ((await files.stat(first).catch(() => null))?.mtime ?? null) : null }];
      if (!targets.length) throw new UserError(NO_RESULT);
      job.stage = 'reading';
      job.files = targets.length;
      const read: ExportChat[][] = [];
      for (const [i, t] of targets.entries()) {
        job.index = i;
        job.name = t.name;
        try {
          const text = await this.readText(files, t.file, job);
          read.push(parseExport(text, exportTime(t.mtime, t.folder ?? win32.dirname(t.file)), { folder: t.folder }));
        } catch (e) {
          if (targets.length === 1 || this.job !== job) throw e;
          job.skipped.push({ name: t.name, error: errText(e) });
        }
      }
      if (!read.length) throw new UserError(job.skipped[0]?.error ?? 'В выгрузке нет сообщений');
      // Older exports first: a chat exported again (in another folder) — its newest copy stays.
      read.sort((a, b) => a[0]!.exportedAt.localeCompare(b[0]!.exportedAt));
      const { chats } = await this.loadedExports();
      const all = read.reduce((acc, fresh) => mergeExports(acc, fresh), chats);
      await this.d.store.saveExports(all);
      this.setExports(all);
      const ids = new Set(read.flat().map((c) => c.id));
      job.added = all.filter((c) => ids.has(c.id)).map((c) => this.exportSummary(c));
      job.chats = all.length;
      job.stage = 'done';
    } catch (e) {
      if (this.job !== job) return;
      job.stage = 'error';
      job.error = e instanceof UserError || e instanceof ExportError ? e.message : `Не удалось прочитать выгрузку: ${errText(e)}`;
    }
  }

  /** The exports in a folder the person gave: its own result.json, or those of its folders one level down (ChatExport_… each). */
  private async exportsIn(files: PartFiles, folder: string): Promise<Array<{ file: string; folder: string; name: string; mtime: string | null }>> {
    const listAll = async (dir: string, pages: number) => {
      const items: Awaited<ReturnType<PartFiles['list']>>['items'] = [];
      let after: string | undefined;
      for (let i = 0; i < pages; i++) {
        const r = await files.list(dir, after ? { after } : {});
        items.push(...r.items);
        if (!r.more || !r.items.length) break;
        after = r.items.at(-1)!.path;
      }
      return items;
    };
    const isResult = (i: { name: string; dir: boolean }) => !i.dir && i.name.toLowerCase() === 'result.json';
    const top = await listAll(folder, 10);
    const here = top.find(isResult);
    if (here) return [{ file: here.path, folder, name: win32.basename(folder), mtime: here.mtime ?? null }];
    const out: Array<{ file: string; folder: string; name: string; mtime: string | null }> = [];
    for (const d of top.filter((i) => i.dir).slice(0, MAX_SUBFOLDERS)) {
      const r = (await listAll(d.path, 3).catch(() => [])).find(isResult);
      if (r) out.push({ file: r.path, folder: d.path, name: d.name, mtime: r.mtime ?? null });
      if (out.length >= MAX_EXPORTS) break;
    }
    return out;
  }

  /** A result.json read where it lies, piece by piece (its text decoded across the pieces' edges). */
  private async readText(files: PartFiles, path: string, job: ImportJob): Promise<string> {
    const decoder = new TextDecoder('utf-8');
    const parts: string[] = [];
    let chars = 0;
    for (let offset = 0; ; ) {
      if (this.job !== job) throw new UserError('Чтение выгрузки остановлено');
      const piece = await files.read(path, { offset, length: READ_PIECE });
      if (offset === 0) {
        if (piece.size > EXPORT_MAX_BYTES) throw new ExportError('Выгрузка слишком большая: выгрузите нужные чаты по одному');
        job.size += piece.size;
      }
      const text = decoder.decode(piece.data, { stream: true });
      chars += text.length;
      if (chars > EXPORT_MAX_CHARS) throw new ExportError('Выгрузка слишком большая: выгрузите нужные чаты по одному');
      parts.push(text);
      offset += piece.data.length;
      job.read += piece.data.length;
      if (piece.eof || !piece.data.length) break;
    }
    parts.push(decoder.decode());
    return parts.join('');
  }

  // ——— An older program: the screen reads result.json and hands its text in pieces ———

  /** A result.json begins: its size (characters) and the file's time. */
  importStart(x: unknown): { id: string } {
    const p = obj(x);
    const size = Number(p.size);
    if (!Number.isInteger(size) || size <= 0) throw new UserError('Пустой файл');
    if (size > EXPORT_MAX_CHARS) throw new UserError('Выгрузка слишком большая: выгрузите нужные чаты по одному и без фото, видео и файлов');
    const t = typeof p.exportedAt === 'number' ? p.exportedAt : Date.parse(String(p.exportedAt ?? ''));
    const exportedAt = new Date(Number.isFinite(t) && t > 0 ? t : this.now()).toISOString();
    // Pieces left by a screen that went away are dropped after 10 minutes.
    for (const [id, u] of this.uploads) if (this.now() - u.at > 600_000) this.uploads.delete(id);
    const id = `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.uploads.set(id, { parts: [], size, exportedAt, at: this.now() });
    return { id };
  }

  importChunk(x: unknown): { received: number } {
    const p = obj(x);
    const u = this.uploads.get(String(p.id ?? ''));
    if (!u) throw new UserError('Загрузка выгрузки прервалась — выберите файл ещё раз');
    const text = typeof p.text === 'string' ? p.text : '';
    const received = u.parts.reduce((n, t) => n + t.length, 0) + text.length;
    if (received > u.size) throw new UserError('Файл больше, чем было сказано — выберите его ещё раз');
    u.parts.push(text);
    u.at = this.now();
    return { received };
  }

  /** The whole file came: its chats are read and kept (sealed) — a chat exported again replaces its older copy. */
  async importEnd(x: unknown) {
    const id = String(obj(x).id ?? '');
    const u = this.uploads.get(id);
    if (!u) throw new UserError('Загрузка выгрузки прервалась — выберите файл ещё раз');
    this.uploads.delete(id);
    let fresh: ExportChat[];
    try {
      fresh = parseExport(u.parts.join(''), u.exportedAt);
    } catch (e) {
      throw e instanceof ExportError ? new UserError(e.message, 'BAD_EXPORT') : e;
    }
    const { chats } = await this.loadedExports();
    const all = mergeExports(chats, fresh);
    await this.d.store.saveExports(all);
    this.setExports(all);
    return { added: fresh.map((c) => this.exportSummary(c)), chats: all.length };
  }

  private exportSummary(c: ExportChat): ExportSummary {
    return { id: c.id, kind: c.kind, title: c.title, exportedAt: c.exportedAt, messages: c.messages.length, firstAt: c.messages[0]?.date ?? null, lastAt: c.messages.at(-1)?.date ?? null, withFiles: !!c.folder };
  }

  /** The loaded exports' chats for the screen, each with its mark. */
  async exportsList() {
    const allowed = new Set(this.d.store.allowed().map((a) => a.id));
    return (await this.loadedExports()).chats.map((c) => ({ ...this.exportSummary(c), allowed: allowed.has(c.id) }));
  }

  /** Removes one chat of the exports (`id`) or all of them; the AI loses them at once. */
  async removeExport(x: unknown) {
    const id = obj(x).id != null ? String(obj(x).id) : null;
    const { chats } = await this.loadedExports();
    const left = id ? chats.filter((c) => c.id !== id) : [];
    await this.d.store.saveExports(left);
    this.setExports(left);
    const gone = new Set(chats.filter((c) => !left.includes(c)).map((c) => c.id));
    this.d.store.setAllowed(this.d.store.allowed().filter((a) => !(a.source === 'export' && gone.has(a.id))));
    return { chats: left.length };
  }

  /** How the AI's tools reach this chat: the export it came from, or the signed-in account. */
  private async readerFor(chat: AllowedChat): Promise<Pick<TgApi, 'read' | 'search' | 'message' | 'download'>> {
    if (chat.source !== 'export') return this.signedIn();
    const { reader } = await this.loadedExports();
    if (!reader.chat(chat.id)) throw new UserError(`Выгрузки чата «${chat.title}» больше нет: владелец загружает её снова на экране приложения Telegram`, 'NOT_ALLOWED');
    return reader;
  }

  /** «по выгрузке от 20.11.2026» for a chat of an export; '' for a live one. */
  private async exportNote(chat: AllowedChat): Promise<string> {
    if (chat.source !== 'export') return '';
    const c = (await this.loadedExports()).reader.chat(chat.id);
    return c ? `по выгрузке от ${exportDate(c.exportedAt)}` : '';
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
    if (keys) this.exportsCache = null;
    this.me = null;
    this.loginStep = null;
    this.dialogs = null;
    return { ok: true };
  }

  /** The person's chats for «Доступ для ИИ» (newest first), each with its mark. */
  /**
   * The person's chats for «Доступ для ИИ» (newest first), each with its mark: the signed-in account's, then the loaded exports'
   * that the account does not have (`source: 'export'`, the export's time and how many messages). Without a session only the
   * exports' — and Telegram is not asked at all.
   */
  async chats(x: unknown) {
    const refresh = obj(x).refresh === true;
    const { chats: exported } = await this.loadedExports();
    const session = this.d.store.canSeal ? (await this.d.store.secret())?.session : '';
    let live: TgChat[] = [];
    if (session || !exported.length) {
      try {
        const c = await this.signedIn();
        if (refresh || !this.dialogs || this.now() - this.dialogs.at > 60_000) this.dialogs = { at: this.now(), list: await c.chats(LIMITS.dialogs) };
        live = this.dialogs.list;
      } catch (e) {
        if (!exported.length) throw e;
      }
    }
    const allowed = new Set(this.d.store.allowed().map((a) => a.id));
    const liveIds = new Set(live.map((c) => c.id));
    return [
      ...live.map(({ peer: _peer, ...chat }) => ({ ...chat, allowed: allowed.has(chat.id) })),
      ...exported
        .filter((c) => !liveIds.has(c.id))
        .map((c) => ({ id: c.id, kind: c.kind, title: c.title, lastAt: c.messages.at(-1)?.date, source: 'export' as const, exportedAt: c.exportedAt, messages: c.messages.length, withFiles: !!c.folder, allowed: allowed.has(c.id) })),
    ];
  }

  /** Marks a chat readable by the AI or not. Only a chat of the person's own list (the part knows how to reach it). */
  async setAccess(x: unknown) {
    const id = String(obj(x).id ?? '');
    const allow = obj(x).allowed === true;
    let list = this.d.store.allowed().filter((a) => a.id !== id);
    if (allow) {
      const since = new Date(this.now()).toISOString();
      const findLive = () => this.dialogs?.list.find((ch) => ch.id === id);
      const exported = (await this.loadedExports()).reader.chat(id);
      const session = this.d.store.canSeal ? (await this.d.store.secret())?.session : '';
      let chat = findLive();
      if (!chat && (session || !exported)) {
        await this.chats({ refresh: true }).catch((e) => {
          if (!exported) throw e;
        });
        chat = findLive();
      }
      if (chat) list = [...list, { id: chat.id, kind: chat.kind, title: chat.title, ...(chat.username ? { username: chat.username } : {}), peer: chat.peer, since }];
      else if (exported) {
        const peer: PeerRef = { type: exported.kind === 'channel' ? 'channel' : exported.kind === 'group' ? 'chat' : 'user', id: exported.id };
        list = [...list, { id: exported.id, kind: exported.kind, title: exported.title, peer, since, source: 'export' }];
      } else throw new UserError('Такого чата нет в вашем Telegram');
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
      const notes = await Promise.all(list.map((a) => this.exportNote(a)));
      const text = list.length
        ? [
            `Чаты Telegram, которые владелец разрешил читать (${list.length}):`,
            ...list.map((a, i) => `- ${a.title} — ${kinds[a.kind]}, chat=${a.id}${a.username ? `, @${a.username}` : ''}${notes[i] ? ` (${notes[i]}: новее сообщений в нём нет)` : ''}`),
          ].join('\n')
        : 'Владелец ещё не разрешил ИИ ни одного чата. Он отмечает чаты в приложении Telegram в Quadro Hub → «Доступ для ИИ».';
      const exported = (await this.loadedExports()).reader;
      const chats = list.map((a) => ({ id: a.id, title: a.title, kind: a.kind, username: a.username ?? null, ...(a.source === 'export' ? { exportedAt: exported.chat(a.id)?.exportedAt ?? null } : {}) }));
      return { answer: { text, data: { chats } }, entry: { chats: [], messages: 0, files: 0 } };
    });
  }

  async aiMessages(x: unknown, signal?: AbortSignal): Promise<McpAnswer> {
    return this.aiCall('messages', async () => {
      const p = obj(x);
      const chat = this.allowedChat(p.chat);
      const c = await this.readerFor(chat);
      // An export ends when it was made: without «to» its last 30 days are read, not the 30 days before now.
      const exportedLast = chat.source === 'export' ? (await this.loadedExports()).reader.chat(chat.id)?.messages.at(-1)?.date : undefined;
      const toMs = parseTime(p.to, 'to', true, this.d.offsetMin) ?? (exportedLast ? Math.min(this.now(), Date.parse(exportedLast)) : this.now());
      const fromMs = parseTime(p.from, 'from', false, this.d.offsetMin) ?? toMs - LIMITS.defaultDays * 86_400_000;
      if (fromMs > toMs) throw new UserError('from позже, чем to');
      const limit = Math.min(LIMITS.pageMax, Math.max(1, Number(p.limit ?? LIMITS.pageDefault) || LIMITS.pageDefault));
      const afterId = p.cursor != null && p.cursor !== '' ? Number(p.cursor) : undefined;
      if (afterId !== undefined && (!Number.isInteger(afterId) || afterId < 0)) throw new UserError('cursor — число из прошлого ответа (nextCursor)');
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
      const note = await this.exportNote(chat);
      const header = `Чат «${chat.title}» (chat=${chat.id}${note ? `, ${note}` : ''}), ${period}: ${taken} сообщ.${nextCursor ? ` Есть ещё — вызовите снова с cursor=${nextCursor}.` : ' Это всё за период.'}`;
      const text = [header, '', ...lines].join('\n');
      return {
        answer: { text, data: { chat: chat.id, count: taken, nextCursor }, notice: `ИИ прочитал ${taken} сообщ. в чате «${chat.title}»` },
        entry: { chats: [chat.title], messages: taken, files: 0 },
      };
    });
  }

  async aiSearch(x: unknown, signal?: AbortSignal): Promise<McpAnswer> {
    return this.aiCall('search', () => this.searchAnswer(x, signal));
  }

  /**
   * The same search asked by the person on the screen «Работы и оплата» in Hub (quadro.tools.call → the part's method «search»):
   * the same chats and answer, but it is not the AI — no line in «Что читал ИИ», no notice.
   */
  async personSearch(x: unknown): Promise<McpAnswer> {
    const { answer } = await this.searchAnswer(x);
    return { text: answer.text, data: answer.data };
  }

  private async searchAnswer(x: unknown, signal?: AbortSignal): Promise<{ answer: McpAnswer; entry: Omit<JournalEntry, 'at' | 'tool' | 'bytes'> }> {
    const p = obj(x);
    const query = String(p.query ?? '').trim();
    if (!query) throw new UserError('query — что искать');
    if (query.length > 200) throw new UserError('query — до 200 знаков');
    const chats = p.chat != null && p.chat !== '' ? [this.allowedChat(p.chat)] : this.d.store.allowed();
    if (!chats.length) throw new UserError('Владелец ещё не разрешил ИИ ни одного чата', 'NOT_ALLOWED');
    const fromMs = parseTime(p.from, 'from', false, this.d.offsetMin) ?? undefined;
    const toMs = parseTime(p.to, 'to', true, this.d.offsetMin) ?? undefined;
    const limit = Math.min(LIMITS.searchMax, Math.max(1, Number(p.limit ?? 50) || 50));
    const blocks: string[] = [];
    const rows: Array<{ chat: AllowedChat & { exportedAt?: string }; m: TgMessage }> = [];
    let found = 0;
    let used = 0;
    for (const chat of chats) {
      if (signal?.aborted) throw new UserError('ИИ отменил вызов', 'ABORTED');
      if (found >= limit || used > LIMITS.answerChars) break;
      // Each chat from where it is: the signed-in account, or the export it came from (then no Telegram at all).
      const c = await this.readerFor(chat);
      const exportedAt = chat.source === 'export' ? (await this.loadedExports()).reader.chat(chat.id)?.exportedAt : undefined;
      const list = await c.search(chat.peer, query, { limit: Math.min(LIMITS.searchPerChat, limit - found), ...(fromMs ? { fromMs } : {}), ...(toMs ? { toMs } : {}) });
      if (!list.length) continue;
      const lines = [];
      for (const m of list) {
        const line = formatMessage(m, this.d.offsetMin);
        if (used + line.length > LIMITS.answerChars) break;
        lines.push(line);
        rows.push({ chat: exportedAt ? { ...chat, exportedAt } : chat, m });
        used += line.length + 1;
        found++;
      }
      const note = exportedAt ? `, по выгрузке от ${exportDate(exportedAt)}` : '';
      blocks.push(`Чат «${chat.title}» (chat=${chat.id}${note}) — ${lines.length}:\n${lines.join('\n')}`);
    }
    const text = found ? [`Поиск «${query}»: ${found} сообщ. (новые первыми)`, '', ...blocks].join('\n\n') : `Поиск «${query}»: ничего не найдено в разрешённых чатах.`;
    return {
      // data — the screen «Работы и оплата» (structuredContent): each message with its sum, «оплачено?» and address in Telegram.
      answer: { text, data: worksData(query, rows), notice: `ИИ искал «${query.slice(0, 40)}» в ${chats.length === 1 ? `чате «${chats[0]!.title}»` : `${chats.length} чатах`}` },
      entry: { chats: chats.map((ch) => ch.title), messages: found, files: 0, query },
    };
  }

  async aiFile(x: unknown, signal?: AbortSignal): Promise<McpAnswer> {
    return this.aiCall('file', async () => {
      const p = obj(x);
      const chat = this.allowedChat(p.chat);
      const id = Number(p.message);
      if (!Number.isInteger(id) || id <= 0) throw new UserError('message — номер сообщения (#… из telegram_messages)');
      const c = await this.readerFor(chat);
      const m = await c.message(chat.peer, id);
      if (!m) throw new UserError('Нет такого сообщения в этом чате');
      const fromExport = chat.source === 'export';
      if (fromExport && !m.attachments.some((a) => a.downloadable)) {
        // Its files are opened only from the export's folder the person gave to read: here — what they are and where.
        if (!m.attachments.length) throw new UserError('У этого сообщения нет файла или картинки');
        const withFolder = !!(await this.loadedExports()).reader.chat(chat.id)?.folder;
        const lines = m.attachments.map((a) => `- ${KIND_WORD[a.kind] ?? a.kind}${a.name ? ` «${a.name}»` : ''}${a.size ? `, ${kb(a.size)}` : ''}${a.title ? ` «${a.title}»` : ''}${a.description ? ` — ${a.description}` : ''}`);
        const tail = withFolder
          ? 'Этого файла нет в папке выгрузки (он в неё не вошёл): владелец может открыть его в Telegram.'
          : 'Файлы этой выгрузки ИИ не открывает: владелец загрузил только result.json. Чтобы ИИ видел картинки и файлы, он выбирает на экране приложения Telegram всю папку выгрузки.';
        const text = [`Сообщение #${id} в чате «${chat.title}» (${await this.exportNote(chat)}):`, ...lines, tail].join('\n');
        return { answer: { text, notice: `ИИ спросил о файле из выгрузки чата «${chat.title}»` }, entry: { chats: [chat.title], messages: 0, files: 0 } };
      }
      const att = m.attachments.find((a) => a.downloadable);
      if (!att) throw new UserError('У этого сообщения нет файла или картинки');
      const done = (answer: McpAnswer, files = 1) => ({ answer: { ...answer, notice: `ИИ открыл файл из ${fromExport ? 'выгрузки ' : ''}чата «${chat.title}»` }, entry: { chats: [chat.title], messages: 0, files } });
      const about = `Сообщение #${id} в чате «${chat.title}»${fromExport ? ` (${await this.exportNote(chat)})` : ''}: ${KIND_WORD[att.kind] ?? att.kind}${att.name ? ` «${att.name}»` : ''}${att.size ? `, ${kb(att.size)}` : ''}`;
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
      if (fromExport) {
        // The file already lies on the owner's PC, in the export's folder: told where, never copied.
        const where = await (await this.loadedExports()).reader.fileOf(chat.peer, id);
        return done({ text: `${about}. Как текст его не прочитать — он лежит на ПК владельца в папке выгрузки: ${where}${images.length ? '. Превью ниже.' : ''}`, ...(images.length ? { images } : {}), data: { path: where, mime: att.mime ?? null, size: att.size ?? null } }, images.length);
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
