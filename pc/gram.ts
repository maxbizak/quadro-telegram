import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { ConnectionTCPObfuscated } from 'telegram/network';
import { computeCheck } from 'telegram/Password';
import { Logger, LogLevel } from 'telegram/extensions/Logger';
import { hostSocketClass, type OpenSocket } from './host-socket';
import { linksOf } from './links';
import type { AttachmentKind, ChatKind, Downloaded, LoginState, Me, PeerRef, ReadOptions, SearchOptions, TgApi, TgAttachment, TgChat, TgFactory, TgMessage } from './types';

// The person's Telegram account through GramJS (MTProto, MIT): like Telegram Web, over WebSocket to *.web.telegram.org, opened by
// the program. Only reading calls are used here: dialogs, history, search, files. Nothing sends, deletes, reads-out or reacts.

/** Telegram Web's addresses for every data centre (files: the «-1» ones). */
class WebClient extends TelegramClient {
  override async getDC(dcId: number, downloadDC = false): Promise<{ id: number; ipAddress: string; port: number }> {
    return super.getDC(dcId, downloadDC, true);
  }
}

const CONNECT_MS = 30_000;
/** Below the AI's 60 s for a whole call. */
const CALL_MS = 45_000;

/** The promise, or a TIMEOUT error after `ms`. */
export function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new TgError(`Telegram не ответил за ${Math.round(ms / 1000)} с — попробуйте ещё раз`, 'TIMEOUT')), ms);
      timer.unref?.();
    }),
  ]);
}

/** The first address of a new session: DC 2 (Europe) over the web address; Telegram moves the session to its own DC itself. */
const FIRST_DC = { id: 2, host: 'venus.web.telegram.org' };

export class TgError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Telegram's error codes in words for a person. */
export function tgError(e: unknown): Error {
  const raw = (e as { errorMessage?: string; message?: string })?.errorMessage ?? (e as Error)?.message ?? String(e);
  const flood = /FLOOD_WAIT_(\d+)/.exec(raw) ?? (/A wait of (\d+) seconds/.exec(raw) as RegExpExecArray | null);
  if (flood) return new TgError(`Telegram просит подождать ${flood[1]} с — попробуйте позже`, 'FLOOD_WAIT');
  const words: Record<string, string> = {
    PHONE_NUMBER_INVALID: 'Неверный номер телефона: нужен полный номер с кодом страны, например +79991234567',
    PHONE_NUMBER_BANNED: 'Этот номер заблокирован в Telegram',
    PHONE_NUMBER_UNOCCUPIED: 'На этот номер нет аккаунта Telegram',
    PHONE_CODE_INVALID: 'Неверный код',
    PHONE_CODE_EMPTY: 'Введите код из Telegram',
    PHONE_CODE_EXPIRED: 'Код устарел — запросите новый',
    PASSWORD_HASH_INVALID: 'Неверный облачный пароль',
    API_ID_INVALID: 'Неверные api_id или api_hash — проверьте их на my.telegram.org',
    API_ID_PUBLISHED_FLOOD: 'Эти api_id и api_hash заблокированы Telegram — создайте свои на my.telegram.org',
    AUTH_KEY_UNREGISTERED: 'Сессия больше не действует — войдите заново',
    SESSION_REVOKED: 'Сессию закрыли в Telegram — войдите заново',
    USER_DEACTIVATED: 'Аккаунт удалён или заблокирован',
    CHANNEL_PRIVATE: 'Нет доступа к этому чату',
    CHAT_ADMIN_REQUIRED: 'Нет прав на это в чате',
    MSG_ID_INVALID: 'Нет такого сообщения',
  };
  for (const [code, text] of Object.entries(words)) if (raw.includes(code)) return new TgError(text, code);
  return e instanceof Error ? e : new Error(raw);
}

const iso = (unixSec?: number) => (unixSec ? new Date(unixSec * 1000).toISOString() : undefined);
const str = (v: unknown) => (v == null ? '' : String(v));

export function inputPeer(p: PeerRef): Api.TypeInputPeer {
  if (p.type === 'user') return new Api.InputPeerUser({ userId: bigInt(p.id), accessHash: bigInt(p.accessHash ?? '0') });
  if (p.type === 'chat') return new Api.InputPeerChat({ chatId: bigInt(p.id) });
  return new Api.InputPeerChannel({ channelId: bigInt(p.id), accessHash: bigInt(p.accessHash ?? '0') });
}

function nameOf(e: unknown): string {
  if (e instanceof Api.User) return [e.firstName, e.lastName].filter(Boolean).join(' ') || (e.username ? `@${e.username}` : `id${str(e.id)}`);
  if (e instanceof Api.Chat || e instanceof Api.Channel) return e.title;
  return '';
}

export function chatOf(entity: unknown, extra: { unread?: number; date?: number } = {}): TgChat | null {
  let kind: ChatKind;
  let peer: PeerRef;
  let id: string;
  let username: string | undefined;
  if (entity instanceof Api.User) {
    kind = entity.bot ? 'bot' : 'user';
    peer = { type: 'user', id: str(entity.id), accessHash: str(entity.accessHash) };
    id = str(entity.id);
    username = entity.username ?? undefined;
  } else if (entity instanceof Api.Chat) {
    kind = 'group';
    peer = { type: 'chat', id: str(entity.id) };
    id = `-${str(entity.id)}`;
  } else if (entity instanceof Api.Channel) {
    kind = entity.megagroup || entity.gigagroup ? 'group' : 'channel';
    peer = { type: 'channel', id: str(entity.id), accessHash: str(entity.accessHash) };
    id = `-100${str(entity.id)}`;
    username = entity.username ?? undefined;
  } else return null;
  return { id, kind, title: nameOf(entity), ...(username ? { username } : {}), ...(extra.unread ? { unread: extra.unread } : {}), ...(extra.date ? { lastAt: iso(extra.date) } : {}), peer };
}

function attachmentsOf(m: Api.Message): TgAttachment[] {
  const media = m.media;
  if (!media || media instanceof Api.MessageMediaEmpty) return [];
  if (media instanceof Api.MessageMediaPhoto) return [{ kind: 'photo', mime: 'image/jpeg', downloadable: !!media.photo }];
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const d = media.document;
    let kind: AttachmentKind = 'document';
    let name: string | undefined;
    for (const a of d.attributes) {
      if (a instanceof Api.DocumentAttributeFilename) name = a.fileName;
      if (a instanceof Api.DocumentAttributeVideo) kind = 'video';
      if (a instanceof Api.DocumentAttributeAudio) kind = a.voice ? 'voice' : 'audio';
      if (a instanceof Api.DocumentAttributeSticker) kind = 'sticker';
    }
    if (kind === 'document' && d.mimeType.startsWith('image/')) kind = 'image';
    return [{ kind, ...(name ? { name } : {}), mime: d.mimeType, size: Number(str(d.size)), downloadable: true }];
  }
  if (media instanceof Api.MessageMediaWebPage) {
    const w = media.webpage;
    if (w instanceof Api.WebPage) return [{ kind: 'webpage', url: w.url, ...(w.title ? { title: w.title } : {}), ...(w.description ? { description: w.description.slice(0, 500) } : {}), downloadable: !!w.photo }];
    return 'url' in w && typeof w.url === 'string' ? [{ kind: 'webpage', url: w.url, downloadable: false }] : [];
  }
  if (media instanceof Api.MessageMediaContact) return [{ kind: 'contact', title: [media.firstName, media.lastName].filter(Boolean).join(' '), description: media.phoneNumber ? 'есть номер телефона' : '', downloadable: false }];
  if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaVenue || media instanceof Api.MessageMediaGeoLive) return [{ kind: 'location', downloadable: false }];
  if (media instanceof Api.MessageMediaPoll) return [{ kind: 'poll', title: media.poll.question.text, downloadable: false }];
  return [{ kind: 'other', title: media.className, downloadable: false }];
}

/** A service message in a few words. */
function serviceText(action: Api.TypeMessageAction): string {
  const words: Record<string, string> = {
    MessageActionChatAddUser: 'добавил участника',
    MessageActionChatDeleteUser: 'участник вышел',
    MessageActionChatJoinedByLink: 'вошёл по ссылке',
    MessageActionChatEditTitle: 'сменил название',
    MessageActionChatEditPhoto: 'сменил фото',
    MessageActionPinMessage: 'закрепил сообщение',
    MessageActionChatCreate: 'создал группу',
    MessageActionChannelCreate: 'создал канал',
    MessageActionPhoneCall: 'звонок',
    MessageActionPaymentSent: 'оплата',
    MessageActionGiftPremium: 'подарок Premium',
  };
  return words[action.className] ?? action.className.replace(/^MessageAction/, '');
}

export function messageOf(m: Api.TypeMessage): TgMessage | null {
  if (m instanceof Api.MessageEmpty) return null;
  const sender = (m as Api.Message).sender as unknown;
  const from = sender ? { id: str((sender as { id?: unknown }).id), name: nameOf(sender), ...((sender as { username?: string }).username ? { username: (sender as { username: string }).username } : {}) } : null;
  const base = { id: m.id, date: iso(m.date) ?? '', from, replyTo: m.replyTo instanceof Api.MessageReplyHeader ? m.replyTo.replyToMsgId : undefined };
  if (m instanceof Api.MessageService) return { ...base, text: '', links: [], attachments: [], service: serviceText(m.action) };
  const msg = m as Api.Message;
  const buttons: string[] = [];
  if (msg.replyMarkup instanceof Api.ReplyInlineMarkup)
    for (const row of msg.replyMarkup.rows) for (const b of row.buttons) if (b instanceof Api.KeyboardButtonUrl) buttons.push(b.url);
  const attachments = attachmentsOf(msg);
  const links = linksOf(msg.message ?? '', (msg.entities ?? []).map((e) => ({ kind: e.className, offset: e.offset, length: e.length, url: (e as { url?: string }).url })), [...buttons, ...attachments.flatMap((a) => (a.url ? [a.url] : []))]);
  const fwd = msg.fwdFrom;
  return {
    ...base,
    ...(msg.editDate ? { editDate: iso(msg.editDate) } : {}),
    text: msg.message ?? '',
    links,
    attachments,
    ...(fwd ? { forwardedFrom: fwd.fromName ?? (fwd.postAuthor || 'переслано') } : {}),
    ...(msg.groupedId ? { groupId: str(msg.groupedId) } : {}),
  };
}

export interface GramOptions {
  apiId: number;
  apiHash: string;
  session: string;
  openSocket: OpenSocket;
}

export async function gramClient(o: GramOptions): Promise<TgApi> {
  const session = new StringSession(o.session);
  if (!o.session) session.setDC(FIRST_DC.id, FIRST_DC.host, 443);
  const client = new WebClient(session, o.apiId, o.apiHash, {
    connection: ConnectionTCPObfuscated,
    networkSocket: hostSocketClass(o.openSocket) as never,
    useWSS: true,
    connectionRetries: 3,
    requestRetries: 2,
    floodSleepThreshold: 15,
    deviceModel: 'Quadro Hub',
    systemVersion: 'Windows',
    appVersion: '1.0',
    langCode: 'ru',
    systemLangCode: 'ru',
    baseLogger: new Logger(LogLevel.NONE),
  });
  // GramJS reports a failed connection by `false` (and would then wait for ever): no link — say so and stop its loops.
  let ok = false;
  try {
    ok = (await within(client.connect(), CONNECT_MS)) !== false && !!client.connected;
  } catch (e) {
    await client.destroy().catch(() => undefined);
    throw tgError(e);
  }
  if (!ok) {
    await client.destroy().catch(() => undefined);
    throw new TgError('Нет связи с Telegram — проверьте интернет и попробуйте снова', 'OFFLINE');
  }
  let alive = true;
  let login: { phone: string; hash: string } | null = null;

  const passwordHint = async (): Promise<LoginState> => {
    const pwd = await client.invoke(new Api.account.GetPassword());
    return { step: 'password', ...(pwd.hint ? { hint: pwd.hint } : {}) };
  };
  const guard = async <T>(fn: () => Promise<T>, ms = CALL_MS): Promise<T> => {
    if (!alive) throw new TgError('Соединение с Telegram прервано — повторите', 'OFFLINE');
    try {
      return await within(fn(), ms);
    } catch (e) {
      const err = tgError(e);
      // A call that never came back or a dropped link: this client is done, the service makes a new one.
      if (err instanceof TgError && (err.code === 'TIMEOUT' || err.code === 'OFFLINE')) alive = false;
      if (/disconnected|Not connected|closed/i.test(err.message)) alive = false;
      throw err;
    }
  };

  const api: TgApi = {
    alive: () => alive && !!client.connected,
    authorized: () => guard(() => client.checkAuthorization()),
    me: () =>
      guard(async () => {
        const me = await client.getMe();
        return { id: str(me.id), name: nameOf(me), ...(me.username ? { username: me.username } : {}) } satisfies Me;
      }),
    sendCode: (phone) =>
      guard(async () => {
        const r = await client.sendCode({ apiId: o.apiId, apiHash: o.apiHash }, phone);
        login = { phone, hash: r.phoneCodeHash };
        return { step: 'code', viaApp: r.isCodeViaApp };
      }),
    signIn: (code) =>
      guard(async () => {
        if (!login) throw new TgError('Сначала запросите код', 'NO_CODE');
        try {
          const r = await client.invoke(new Api.auth.SignIn({ phoneNumber: login.phone, phoneCodeHash: login.hash, phoneCode: code }));
          if (r instanceof Api.auth.AuthorizationSignUpRequired) throw new TgError('На этот номер нет аккаунта Telegram', 'SIGN_UP');
          login = null;
          return { step: 'done' };
        } catch (e) {
          if (str((e as { errorMessage?: string }).errorMessage).includes('SESSION_PASSWORD_NEEDED')) return passwordHint();
          throw e;
        }
      }),
    checkPassword: (password) =>
      guard(async () => {
        const pwd = await client.invoke(new Api.account.GetPassword());
        await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pwd, password) }));
        login = null;
        return { step: 'done' };
      }),
    logOut: () =>
      guard(async () => {
        await client.invoke(new Api.auth.LogOut());
      }),
    session: () => String(client.session.save()),
    chats: (limit) =>
      guard(async () => {
        const dialogs = await client.getDialogs({ limit });
        const out: TgChat[] = [];
        for (const d of dialogs) {
          const c = chatOf(d.entity, { unread: d.unreadCount, date: d.date });
          if (c) out.push(c);
        }
        return out;
      }),
    read: (peer, r: ReadOptions) =>
      guard(async () => {
        const list = await client.getMessages(inputPeer(peer), {
          limit: r.limit,
          reverse: true,
          ...(r.afterId ? { offsetId: r.afterId } : { offsetDate: Math.floor(r.fromMs / 1000) }),
        });
        const out: TgMessage[] = [];
        for (const m of list) {
          const t = (m.date ?? 0) * 1000;
          if (t < r.fromMs) continue;
          if (t > r.toMs) break;
          const x = messageOf(m);
          if (x) out.push(x);
        }
        return out;
      }),
    search: (peer, query, s: SearchOptions) =>
      guard(async () => {
        const list = await client.getMessages(inputPeer(peer), { search: query, limit: s.limit, ...(s.toMs ? { offsetDate: Math.floor(s.toMs / 1000) } : {}) });
        return list.flatMap((m) => {
          if (s.fromMs && (m.date ?? 0) * 1000 < s.fromMs) return [];
          const x = messageOf(m);
          return x ? [x] : [];
        });
      }),
    message: (peer, id) =>
      guard(async () => {
        const [m] = await client.getMessages(inputPeer(peer), { ids: [id] });
        return m ? messageOf(m) : null;
      }),
    download: (peer, id, d) =>
      guard(async () => {
        const [m] = await client.getMessages(inputPeer(peer), { ids: [id] });
        if (!(m instanceof Api.Message) || !m.media) return null;
        const [att] = attachmentsOf(m);
        if (!att) return null;
        let media: Api.TypeMessageMedia = m.media;
        let kind: AttachmentKind = att.kind;
        // A link preview's picture.
        if (media instanceof Api.MessageMediaWebPage && media.webpage instanceof Api.WebPage && media.webpage.photo) {
          media = new Api.MessageMediaPhoto({ photo: media.webpage.photo });
          kind = 'photo';
        }
        const thumbs = media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document ? (media.document.thumbs ?? []) : [];
        if (d.thumb) {
          if (!thumbs.length) return null;
          const bytes = await client.downloadMedia(media, { thumb: thumbs.length - 1 });
          return Buffer.isBuffer(bytes) ? { bytes, mime: 'image/jpeg', name: `${id}-preview.jpg`, kind: 'photo' } : null;
        }
        if (att.size && att.size > d.maxBytes) throw new TgError(`Файл ${Math.round(att.size / 1048576)} МБ — больше предела ${Math.round(d.maxBytes / 1048576)} МБ`, 'TOO_LARGE');
        const bytes = await client.downloadMedia(media, {});
        if (!Buffer.isBuffer(bytes)) return null;
        const mime = kind === 'photo' ? 'image/jpeg' : (att.mime ?? 'application/octet-stream');
        return { bytes, mime, name: att.name ?? `${id}${kind === 'photo' ? '.jpg' : ''}`, kind } satisfies Downloaded;
      }),
    close: async () => {
      alive = false;
      await client.destroy().catch(() => undefined);
    },
  };
  return api;
}

export const gramFactory =
  (openSocket: OpenSocket): TgFactory =>
  (o) =>
    gramClient({ ...o, openSocket });
