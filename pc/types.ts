// What the part knows of Telegram, independent of the MTProto library: the service (service.ts) works with TgApi, the real client
// is GramJS (gram.ts), the tests give a stand-in (test/stub-tg.ts). Read-only by design: there is nothing here to send, delete or react.

export type ChatKind = 'user' | 'bot' | 'group' | 'channel';

/** How to address a chat again after a restart (MTProto input peer): kept on the PC only. */
export interface PeerRef {
  type: 'user' | 'chat' | 'channel';
  id: string;
  accessHash?: string;
}

export interface TgChat {
  /** Telegram's id of the dialog (as Bot API marks it: -100… channels, -… groups). */
  id: string;
  kind: ChatKind;
  title: string;
  username?: string;
  unread?: number;
  /** The last message's time, ISO. */
  lastAt?: string;
  peer: PeerRef;
}

export type AttachmentKind = 'photo' | 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker' | 'webpage' | 'contact' | 'location' | 'poll' | 'other';

export interface TgAttachment {
  kind: AttachmentKind;
  name?: string;
  mime?: string;
  size?: number;
  /** A link preview's address, title and words. */
  url?: string;
  title?: string;
  description?: string;
  /** Can be fetched with the file tool. */
  downloadable: boolean;
}

export interface TgMessage {
  id: number;
  /** ISO time. */
  date: string;
  editDate?: string;
  from: { id: string; name: string; username?: string } | null;
  text: string;
  links: string[];
  attachments: TgAttachment[];
  replyTo?: number;
  forwardedFrom?: string;
  /** A service message («X joined», «pinned»…), in words. */
  service?: string;
  /** Messages sent together (an album). */
  groupId?: string;
}

export interface ReadOptions {
  /** Only messages at or after this time (ms). */
  fromMs: number;
  /** Only messages at or before this time (ms). */
  toMs: number;
  /** Continue after this message id (oldest → newest). */
  afterId?: number;
  limit: number;
}

export interface SearchOptions {
  limit: number;
  fromMs?: number;
  toMs?: number;
}

export interface Downloaded {
  bytes: Buffer;
  mime: string;
  name: string;
  kind: AttachmentKind;
}

export interface LoginState {
  step: 'code' | 'password' | 'done';
  /** The code went to the Telegram app (not SMS). */
  viaApp?: boolean;
  /** The 2FA password's hint, if the person set one. */
  hint?: string;
}

export interface Me {
  id: string;
  name: string;
  username?: string;
}

/** A connected MTProto client of the person's account: login and reading, nothing else. */
export interface TgApi {
  /** The link still works (false after a dropped connection or a call that never came back: make a new client). */
  alive(): boolean;
  /** Is the session signed in. */
  authorized(): Promise<boolean>;
  me(): Promise<Me>;
  sendCode(phone: string): Promise<LoginState>;
  signIn(code: string): Promise<LoginState>;
  checkPassword(password: string): Promise<LoginState>;
  /** Ends this session on Telegram's side too (it disappears from «Устройства»). */
  logOut(): Promise<void>;
  /** The session to keep (sealed on the PC). */
  session(): string;
  chats(limit: number): Promise<TgChat[]>;
  /** Oldest → newest within the period. */
  read(peer: PeerRef, o: ReadOptions): Promise<TgMessage[]>;
  /** Newest first. */
  search(peer: PeerRef, query: string, o: SearchOptions): Promise<TgMessage[]>;
  message(peer: PeerRef, id: number): Promise<TgMessage | null>;
  /** One attachment of a message; `thumb` — its preview picture (videos, documents). Null — nothing to fetch. */
  download(peer: PeerRef, id: number, o: { maxBytes: number; thumb?: boolean; signal?: AbortSignal }): Promise<Downloaded | null>;
  close(): Promise<void>;
}

/** Makes a client for these keys and session (empty — a new login). */
export type TgFactory = (o: { apiId: number; apiHash: string; session: string }) => Promise<TgApi>;
