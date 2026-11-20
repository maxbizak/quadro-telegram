import { win32 } from 'node:path';
import type { AttachmentKind, ChatKind, Downloaded, PeerRef, ReadOptions, SearchOptions, TgAttachment, TgMessage } from './types';

// «Выгрузка из Telegram Desktop» — chats without signing in and without keys: Telegram Desktop → a chat → ⋮ → «Экспорт истории
// чата» (or Настройки → Продвинутые → «Экспорт данных из Telegram»), format «Машиночитаемый JSON». The person picks the export's
// folder (or its result.json) in Windows' own window; the part reads it where it lies through the program (pc.files.pick +
// files.read; with an older program the screen reads the file and hands its text in pieces), reads it here into the same
// messages the live client gives, and keeps them sealed by Windows in its own folder until the person removes them. A folder
// given to read also lets the AI see the export's pictures and text files (read where they lie, never copied). Nothing goes to
// Hub's server.
//
// The format (Telegram Desktop's export_output_json): one chat — { name, type, id, messages: [...] }; all data —
// { chats: { list: [chat…] }, left_chats: { list: [chat…] }, … }. A message: { id, type: 'message' | 'service', date,
// date_unixtime, edited_unixtime, from, from_id, text (a string or a list of strings and { type, text, href }), text_entities,
// reply_to_message_id, forwarded_from, photo, file, file_name, file_size, mime_type, media_type, poll, contact_information,
// location_information, action, actor, title }.

/** One chat of an export, its messages oldest → newest. */
export interface ExportChat {
  /** As Bot API marks it (like the live client): -100… supergroups and channels, -… small groups, people as they are. */
  id: string;
  kind: ChatKind;
  title: string;
  /** When the export was made (its folder's date, the file's time or its newest message), ISO. */
  exportedAt: string;
  /** The export's folder on this PC when the person gave it to read: its files can be opened for the AI. */
  folder?: string | null;
  messages: TgMessage[];
}

/** The most text of one result.json taken (a string of Node holds about 500 million characters). */
export const EXPORT_MAX_CHARS = 250_000_000;

const NOT_INCLUDED = /^\(File (?:not included|exceeds maximum size)/i;

const KIND_OF: Record<string, ChatKind> = {
  personal_chat: 'user',
  saved_messages: 'user',
  bot_chat: 'bot',
  private_group: 'group',
  private_supergroup: 'group',
  public_supergroup: 'group',
  private_channel: 'channel',
  public_channel: 'channel',
};

/** The chat's id as the live client marks it: supergroups and channels -100…, small groups -…, people as they are. */
export function markedId(type: string, id: unknown): string | null {
  const raw = typeof id === 'number' || typeof id === 'string' ? String(id).trim() : '';
  if (!/^-?\d{1,20}$/.test(raw)) return null;
  if (raw.startsWith('-')) return raw;
  if (type === 'private_group') return `-${raw}`;
  if (/supergroup|channel/.test(type)) return `-100${raw}`;
  return raw;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The text of a message: a string, or a list of strings and pieces { type, text, href }; and its links. */
function textOf(m: Record<string, unknown>): { text: string; links: string[] } {
  const links: string[] = [];
  const add = (u: string) => {
    const url = /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`;
    if (u && !links.includes(url)) links.push(url);
  };
  const parts = Array.isArray(m.text) ? m.text : [m.text];
  let text = '';
  for (const p of parts) {
    if (typeof p === 'string') text += p;
    else if (p && typeof p === 'object') {
      const piece = p as { type?: unknown; text?: unknown; href?: unknown };
      text += str(piece.text);
      if (piece.type === 'text_link' && typeof piece.href === 'string') add(piece.href);
      else if (piece.type === 'link' && typeof piece.text === 'string') add(piece.text);
    }
  }
  // Newer exports say the same in text_entities; links only (the text is already whole).
  for (const e of Array.isArray(m.text_entities) ? m.text_entities : []) {
    const piece = e as { type?: unknown; text?: unknown; href?: unknown };
    if (piece?.type === 'text_link' && typeof piece.href === 'string') add(piece.href);
    else if (piece?.type === 'link' && typeof piece.text === 'string') add(piece.text);
  }
  return { text, links };
}

const MEDIA_KIND: Record<string, AttachmentKind> = {
  video_file: 'video',
  animation: 'video',
  video_message: 'video',
  voice_message: 'voice',
  audio_file: 'audio',
  sticker: 'sticker',
};

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** A path inside the export's folder as result.json gives it («photos/photo_1@….jpg»); anything leading out of it — null. */
export function insidePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 500 || NOT_INCLUDED.test(raw) || raw.includes('\0')) return null;
  if (/^[a-z]:|^[\\/]/i.test(raw)) return null;
  const parts = raw.split(/[\\/]+/);
  return parts.some((x) => x === '..' || x === '.' || x === '') ? null : parts.join('\\');
}

/**
 * What the message carries: a photo, a file (its name, kind, size, where it lies in the export's folder), a poll, a contact, a place.
 * `files` — the folder was given to read: an included file can be opened for the AI.
 */
function attachmentsOf(m: Record<string, unknown>, files: boolean): TgAttachment[] {
  const out: TgAttachment[] = [];
  const where = (path: string) => (NOT_INCLUDED.test(path) ? 'не вошёл в выгрузку' : `в папке выгрузки: ${path}`);
  const inside = (path: unknown): Pick<TgAttachment, 'path' | 'thumbPath' | 'downloadable'> => {
    const p = files ? insidePath(path) : null;
    const thumb = files ? insidePath(m.thumbnail) : null;
    return p ? { path: p, ...(thumb ? { thumbPath: thumb } : {}), downloadable: true } : { downloadable: false };
  };
  if (typeof m.photo === 'string') out.push({ kind: 'photo', mime: 'image/jpeg', ...(NOT_INCLUDED.test(m.photo) ? {} : { name: baseName(m.photo) }), ...(typeof m.photo_file_size === 'number' ? { size: m.photo_file_size } : {}), description: where(m.photo), ...inside(m.photo) });
  if (typeof m.file === 'string') {
    const kind = MEDIA_KIND[str(m.media_type)] ?? (str(m.mime_type).startsWith('image/') ? 'image' : 'document');
    const name = str(m.file_name) || (NOT_INCLUDED.test(m.file) ? '' : baseName(m.file));
    out.push({
      kind,
      ...(name ? { name } : {}),
      ...(str(m.mime_type) ? { mime: str(m.mime_type) } : {}),
      ...(typeof m.file_size === 'number' ? { size: m.file_size } : {}),
      ...(kind === 'sticker' && str(m.sticker_emoji) ? { title: str(m.sticker_emoji) } : {}),
      description: where(m.file),
      ...inside(m.file),
    });
  }
  const poll = m.poll as { question?: unknown } | undefined;
  if (poll && typeof poll === 'object') out.push({ kind: 'poll', title: str(poll.question), downloadable: false });
  const contact = m.contact_information as { first_name?: unknown; last_name?: unknown; phone_number?: unknown } | undefined;
  if (contact && typeof contact === 'object') out.push({ kind: 'contact', title: [str(contact.first_name), str(contact.last_name)].filter(Boolean).join(' '), description: contact.phone_number ? 'есть номер телефона' : '', downloadable: false });
  if (m.location_information && typeof m.location_information === 'object') out.push({ kind: 'location', downloadable: false });
  return out;
}

const ACTION: Record<string, string> = {
  create_group: 'создал(а) группу',
  create_channel: 'создал(а) канал',
  invite_members: 'добавил(а) участников',
  remove_members: 'удалил(а) участников',
  join_group_by_link: 'вступил(а) по ссылке',
  join_group_by_request: 'вступил(а) по заявке',
  pin_message: 'закрепил(а) сообщение',
  edit_group_title: 'изменил(а) название',
  edit_group_photo: 'изменил(а) фото',
  delete_group_photo: 'удалил(а) фото',
  phone_call: 'звонок',
  group_call: 'видеочат',
  migrate_to_supergroup: 'группа стала супергруппой',
  migrate_from_group: 'группа стала супергруппой',
  topic_created: 'создал(а) тему',
  send_payment: 'оплата через Telegram',
};

/** The time of a message: date_unixtime (seconds, newer exports), else date — the local time of the PC that exported it. */
function timeOf(unix: unknown, local: unknown): string | null {
  const s = Number(unix);
  if (Number.isFinite(s) && s > 0) return new Date(s * 1000).toISOString();
  const t = typeof local === 'string' ? Date.parse(local) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function messageOf(raw: unknown, files: boolean): TgMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const id = Number(m.id);
  const date = timeOf(m.date_unixtime, m.date);
  if (!Number.isInteger(id) || id <= 0 || !date) return null;
  const edited = timeOf(m.edited_unixtime, m.edited);
  const fromId = str(m.from_id ?? m.actor_id).replace(/^\D+/, '');
  const fromName = str(m.from ?? m.actor);
  const { text, links } = textOf(m);
  const out: TgMessage = {
    id,
    date,
    ...(edited ? { editDate: edited } : {}),
    from: fromName || fromId ? { id: fromId, name: fromName || 'Удалённый аккаунт' } : null,
    text,
    links,
    attachments: attachmentsOf(m, files),
    ...(Number.isInteger(m.reply_to_message_id) ? { replyTo: m.reply_to_message_id as number } : {}),
    ...(str(m.forwarded_from) ? { forwardedFrom: str(m.forwarded_from) } : {}),
  };
  if (m.type === 'service') {
    const action = str(m.action);
    out.service = [ACTION[action] ?? action.replace(/_/g, ' '), str(m.title) ? `«${str(m.title)}»` : ''].filter(Boolean).join(' ') || 'служебное сообщение';
  }
  return out;
}

function chatOf(raw: unknown, exportedAt: string, folder: string | null): ExportChat | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const type = str(c.type);
  const kind = KIND_OF[type];
  const id = markedId(type, c.id);
  if (!kind || !id || !Array.isArray(c.messages)) return null;
  const messages = c.messages.map((m) => messageOf(m, !!folder)).filter((m): m is TgMessage => !!m).sort((a, b) => a.id - b.id);
  const title = str(c.name) || (type === 'saved_messages' ? 'Избранное' : 'Без названия');
  return { id, kind, title, exportedAt, ...(folder ? { folder } : {}), messages };
}

export class ExportError extends Error {}

/**
 * The chats of a result.json: one chat's export or the whole data's (chats and left chats). `exportedAt` — when it was made; null —
 * its newest message's time. `folder` — the export's folder given to read (its files can then be opened for the AI).
 * Not an export of Telegram Desktop in JSON (an HTML export, another file) — an error in words.
 */
export function parseExport(text: string, exportedAt: string | null, o: { folder?: string | null } = {}): ExportChat[] {
  if (text.length > EXPORT_MAX_CHARS) throw new ExportError('Выгрузка слишком большая: выгрузите нужные чаты по одному и без фото, видео и файлов');
  if (/^\s*</.test(text)) throw new ExportError('Это выгрузка в HTML: в Telegram Desktop выберите формат «Машиночитаемый JSON» и выгрузите снова');
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new ExportError('Файл не читается как JSON: выберите result.json из папки выгрузки Telegram Desktop');
  }
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const list: unknown[] = Array.isArray(d.messages)
    ? [d]
    : [d.chats, d.left_chats].flatMap((x) => (x && typeof x === 'object' && Array.isArray((x as { list?: unknown }).list) ? ((x as { list: unknown[] }).list ?? []) : []));
  if (!list.length) throw new ExportError('В файле нет чатов: это не result.json выгрузки Telegram Desktop (или выгрузка без «Личных чатов» и групп)');
  const chats = list.map((c) => chatOf(c, exportedAt ?? '', o.folder ?? null)).filter((c): c is ExportChat => !!c && c.messages.length > 0);
  if (!chats.length) throw new ExportError('В выгрузке нет сообщений');
  if (!exportedAt) {
    const newest = chats.map((c) => c.messages.at(-1)!.date).sort().at(-1)!;
    for (const c of chats) c.exportedAt = newest;
  }
  return chats;
}

/**
 * When an export was made, by its folder's name: Telegram Desktop names it «ChatExport_2026-11-20» or «DataExport_2026-11-20 (2)»;
 * noon of that day (the date is what is shown). Another name — null.
 */
export function folderDate(folder: string): string | null {
  const m = /(?:Chat|Data)Export_(\d{4})-(\d{2})-(\d{2})/i.exec(win32.basename(folder));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 ? null : d.toISOString();
}

/** Reads a file of an export's folder for the AI (through the program, where it lies): at most `maxBytes`. */
export type ExportFileReader = (path: string, maxBytes: number, signal?: AbortSignal) => Promise<Buffer>;

const MIME_OF: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.txt': 'text/plain', '.json': 'application/json' };

/** New chats over the old ones: a chat exported again replaces its older copy (by id). */
export function mergeExports(old: ExportChat[], fresh: ExportChat[]): ExportChat[] {
  const ids = new Set(fresh.map((c) => c.id));
  return [...old.filter((c) => !ids.has(c.id)), ...fresh];
}

const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Reading an export like the live client (the same answers), only its chats: `peer.id` — the chat's id. */
export class ExportReader {
  private readonly byId: Map<string, ExportChat>;
  constructor(
    chats: ExportChat[],
    /** The program's reading of a folder the person gave; none — the export's files are only told, never opened. */
    private readonly readFile?: ExportFileReader,
  ) {
    this.byId = new Map(chats.map((c) => [c.id, c]));
  }

  chat(id: string): ExportChat | undefined {
    return this.byId.get(id);
  }

  private messages(peer: PeerRef): TgMessage[] {
    return this.byId.get(peer.id)?.messages ?? [];
  }

  /** Oldest → newest within the period (as TgApi.read). */
  async read(peer: PeerRef, o: ReadOptions): Promise<TgMessage[]> {
    const out: TgMessage[] = [];
    for (const m of this.messages(peer)) {
      const t = Date.parse(m.date);
      if (t < o.fromMs || t > o.toMs || (o.afterId && m.id <= o.afterId)) continue;
      out.push(m);
      if (out.length >= o.limit) break;
    }
    return out;
  }

  /** Newest first, by the words of the text and the attachments' names (as TgApi.search). */
  async search(peer: PeerRef, query: string, o: SearchOptions): Promise<TgMessage[]> {
    const q = fold(query.trim());
    const out: TgMessage[] = [];
    const list = this.messages(peer);
    for (let i = list.length - 1; i >= 0 && out.length < o.limit; i--) {
      const m = list[i]!;
      const t = Date.parse(m.date);
      if ((o.fromMs && t < o.fromMs) || (o.toMs && t > o.toMs)) continue;
      const hay = fold(`${m.text} ${m.attachments.map((a) => `${a.name ?? ''} ${a.title ?? ''}`).join(' ')}`);
      if (hay.includes(q)) out.push(m);
    }
    return out;
  }

  async message(peer: PeerRef, id: number): Promise<TgMessage | null> {
    return this.messages(peer).find((m) => m.id === id) ?? null;
  }

  /** Where an export's file lies on this PC (its folder given to read), or null. */
  async fileOf(peer: PeerRef, id: number): Promise<string | null> {
    const chat = this.byId.get(peer.id);
    const att = (await this.message(peer, id))?.attachments.find((a) => a.downloadable && a.path);
    return chat?.folder && att?.path ? win32.join(chat.folder, att.path) : null;
  }

  /**
   * A file of the export read where it lies in its folder (given to read): the picture or file itself, or its preview. Without
   * the folder (only result.json was picked) or the program's reading — null: the file is only told.
   */
  async download(peer: PeerRef, id: number, o: { maxBytes: number; thumb?: boolean; signal?: AbortSignal } = { maxBytes: 0 }): Promise<Downloaded | null> {
    const chat = this.byId.get(peer.id);
    const att = (await this.message(peer, id))?.attachments.find((a) => a.downloadable && a.path);
    const rel = o.thumb ? att?.thumbPath : att?.path;
    if (!chat?.folder || !att || !rel || !this.readFile) return null;
    const bytes = await this.readFile(win32.join(chat.folder, rel), o.maxBytes, o.signal);
    const ext = win32.extname(rel).toLowerCase();
    const mime = o.thumb ? 'image/jpeg' : att.mime && att.mime !== 'application/octet-stream' ? att.mime : (MIME_OF[ext] ?? 'application/octet-stream');
    return { bytes, mime, name: att.name ?? win32.basename(rel), kind: att.kind };
  }
}

/** «20.11.2026» — the date of an export for the AI's text and the screen. */
export function exportDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
