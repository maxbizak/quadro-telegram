import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { PartFiles } from '../pc/service';

// A stand-in of the program's files for a part (the Hub program, apps/desktop/src/pc-apps/files.ts): Windows' window answers with
// `answer` (paths the «person» picks); what was picked is the app's — a file to read («in»), a folder to read («dir-in»). Reading
// goes in pieces at most `piece` bytes (smaller than the part asks: a letter of UTF-8 split between two pieces), nothing outside
// what was given; a folder is listed one level, folders first. Every call is written down.

export interface StubFiles extends PartFiles {
  calls: string[];
  /** What Windows' window gives next (empty — the person closed it). */
  answer: string[];
}

export function stubFiles(o: { piece?: number; answer?: string[] } = {}): StubFiles {
  const grants = new Map<string, 'in' | 'dir-in'>();
  const calls: string[] = [];
  const piece = o.piece ?? 63;
  const inside = (path: string) => {
    const p = resolve(path);
    if (grants.get(p) === 'in') return true;
    return [...grants].some(([g, kind]) => kind === 'dir-in' && p.startsWith(g + sep));
  };
  const self: StubFiles = {
    calls,
    answer: o.answer ?? [],
    async pick(x) {
      calls.push(`pick ${x.folder ? (x.read ? 'folder-to-read' : 'folder') : 'file'}`);
      const picked = self.answer.map((p) => resolve(p));
      for (const p of picked) grants.set(p, x.folder && x.read ? 'dir-in' : 'in');
      return picked;
    },
    async read(path, x = {}) {
      calls.push(`read ${path}`);
      if (!inside(path)) throw new Error('Этот файл приложению не открыт');
      const size = statSync(path).size;
      const offset = x.offset ?? 0;
      const want = Math.max(0, Math.min(x.length ?? 1024 * 1024, piece, size - offset));
      const buf = Buffer.alloc(want);
      const fd = openSync(path, 'r');
      try {
        readSync(fd, buf, 0, want, offset);
      } finally {
        closeSync(fd);
      }
      return { data: new Uint8Array(buf), size, eof: offset + want >= size };
    },
    async list(path) {
      calls.push(`list ${path}`);
      const p = resolve(path);
      if (grants.get(p) !== 'dir-in' && !inside(p)) throw new Error('Эта папка приложению не открыта');
      const entries = readdirSync(p, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      return { items: entries.map((e) => ({ path: join(p, e.name), name: e.name, dir: e.isDirectory(), size: e.isFile() ? statSync(join(p, e.name)).size : 0 })), more: false };
    },
  };
  return self;
}

/** A program before reading picked files: Windows' window works, reading does not exist. */
export function oldProgramFiles(): PartFiles {
  return {
    pick: async () => [],
    read: async () => {
      throw new Error('Нет такого действия: files.read');
    },
    list: async () => {
      throw new Error('Нет такого действия: files.list');
    },
  };
}
