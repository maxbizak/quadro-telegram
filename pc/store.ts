import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatKind, PeerRef } from './types';

// What the part keeps, all in its own data folder on the PC (pc.files.own) — nothing goes to Hub's server:
//   secret.bin   api_id, api_hash and the Telegram session, sealed by Windows (DPAPI, bound to this app and this Windows user)
//   access.json  the chats the person let the AI read (id, kind, title, how to address it)
//   journal.json what the AI read: when, which tool, which chats, how many messages and bytes — never the content
//   files/       attachments the AI asked for that are not pictures or text (to read on this PC), the newest 100

export interface Sealer {
  seal(data: Uint8Array | string): Promise<Uint8Array>;
  unseal(sealed: Uint8Array): Promise<Uint8Array>;
}

export interface Secret {
  apiId: number;
  apiHash: string;
  session: string;
  /** Whose keys made this session: the person's own (my.telegram.org) or the publisher's («ключи Quadro»). */
  source: 'own' | 'publisher';
}

export interface AllowedChat {
  id: string;
  kind: ChatKind;
  title: string;
  username?: string;
  peer: PeerRef;
  /** When the person allowed it (ISO). */
  since: string;
}

export interface JournalEntry {
  at: string;
  tool: string;
  chats: string[];
  messages: number;
  files: number;
  bytes: number;
  /** What the AI searched for (its own words, not the chats' content). */
  query?: string;
  error?: string;
}

const JOURNAL_MAX = 500;
const FILES_MAX = 100;

export class Store {
  constructor(
    private readonly dir: string,
    private readonly sealer: Sealer | null,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  /** Windows can protect the session (a program that gives host.secrets). */
  get canSeal(): boolean {
    return !!this.sealer;
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  private readJson<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(this.path(name), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  /** Written whole or not at all (a new file, then renamed over the old one). */
  private writeFile(name: string, data: string | Uint8Array): void {
    const tmp = this.path(`${name}.tmp`);
    writeFileSync(tmp, data);
    renameSync(tmp, this.path(name));
  }

  async secret(): Promise<Secret | null> {
    if (!this.sealer || !existsSync(this.path('secret.bin'))) return null;
    try {
      const raw = Buffer.from(await this.sealer.unseal(new Uint8Array(readFileSync(this.path('secret.bin'))))).toString('utf8');
      const s = JSON.parse(raw) as Partial<Secret>;
      return typeof s.apiId === 'number' && typeof s.apiHash === 'string'
        ? { apiId: s.apiId, apiHash: s.apiHash, session: typeof s.session === 'string' ? s.session : '', source: s.source === 'publisher' ? 'publisher' : 'own' }
        : null;
    } catch {
      // Sealed by another Windows user or a damaged file: as if nothing was kept.
      return null;
    }
  }

  async saveSecret(s: Secret): Promise<void> {
    if (!this.sealer) throw new Error('Программа Quadro Hub не умеет защищать сессию: обновите программу');
    this.writeFile('secret.bin', await this.sealer.seal(JSON.stringify(s)));
  }

  /** «Выйти»: the session goes; the keys stay unless `keys` (then nothing of Telegram is left on the PC). */
  async forget(keys: boolean): Promise<void> {
    const s = await this.secret();
    if (keys || !s) rmSync(this.path('secret.bin'), { force: true });
    else await this.saveSecret({ ...s, session: '' });
    rmSync(this.path('files'), { recursive: true, force: true });
    if (keys) {
      rmSync(this.path('access.json'), { force: true });
      rmSync(this.path('journal.json'), { force: true });
    }
  }

  allowed(): AllowedChat[] {
    const list = this.readJson<{ chats?: AllowedChat[] }>('access.json', {}).chats;
    return Array.isArray(list) ? list : [];
  }

  setAllowed(chats: AllowedChat[]): void {
    this.writeFile('access.json', JSON.stringify({ chats }, null, 1));
  }

  journal(): JournalEntry[] {
    const list = this.readJson<JournalEntry[]>('journal.json', []);
    return Array.isArray(list) ? list : [];
  }

  addJournal(entry: JournalEntry): void {
    this.writeFile('journal.json', JSON.stringify([entry, ...this.journal()].slice(0, JOURNAL_MAX)));
  }

  clearJournal(): void {
    rmSync(this.path('journal.json'), { force: true });
  }

  /** An attachment kept for the AI on this PC; the oldest go beyond the newest 100. */
  saveFile(name: string, bytes: Buffer): string {
    const dir = this.path('files');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, bytes);
    const all = readdirSync(dir)
      .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of all.slice(FILES_MAX)) rmSync(join(dir, old.n), { force: true });
    return file;
  }
}
