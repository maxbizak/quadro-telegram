import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderDate, insidePath, parseExport } from '../pc/export';
import { exportTime, TelegramService, type ImportJob, type PartFiles } from '../pc/service';
import { Store } from '../pc/store';
import { fakeSealer, stubFactory } from './stub-tg';
import { oldProgramFiles, stubFiles } from './stub-files';

// «Выгрузка из Telegram Desktop» read by the part itself where it lies (program with pc.files.pick + files.read / files.list):
// the person picks the export's folder (or only result.json) in Windows' own window; the part reads it in pieces through the
// program, keeps the chats sealed; a folder given to read also lets the AI see the export's pictures and text files — read where
// they lie, never copied, only in allowed chats, never a path leading out of the folder.

const CHAT = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'result-chat.json'), 'utf8')) as { messages: Array<Record<string, unknown>> };
const NOW = Date.parse('2026-11-20T12:00:00Z');
const PHOTO = 'photos/photo_412@18-11-2026_20-22-00.jpg';

/** The sample chat as an export with its files in the folder (a picture, a model, a video with its preview, a text, a path out). */
function withFiles(): string {
  const messages = CHAT.messages.map((m) => (m.id === 412 ? { ...m, photo: PHOTO, photo_file_size: 7 } : m));
  messages.push(
    { id: 432, type: 'message', date_unixtime: '1795121000', from: 'Даня', from_id: 'user200', file: 'video_files/клип.mp4', file_name: 'клип.mp4', thumbnail: 'video_files/клип.mp4_thumb.jpg', media_type: 'video_file', mime_type: 'video/mp4', file_size: 5_000_000, text: 'Превью анимации' },
    { id: 433, type: 'message', date_unixtime: '1795121100', from: 'Даня', from_id: 'user200', file: '../../secret.txt', file_name: 'secret.txt', mime_type: 'text/plain', file_size: 10, text: 'не туда' },
    { id: 434, type: 'message', date_unixtime: '1795121200', from: 'Даня', from_id: 'user200', file: 'files/ТЗ.txt', file_name: 'ТЗ.txt', mime_type: 'text/plain', file_size: 46, text: 'ТЗ на шапки' },
  );
  return JSON.stringify({ ...CHAT, messages }, null, 1);
}

let dir: string;
let root: string;
let exportDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qh-tg-files-'));
  root = join(dir, 'Telegram Desktop');
  exportDir = join(root, 'ChatExport_2026-11-20');
  for (const sub of ['photos', 'files', 'video_files']) mkdirSync(join(exportDir, sub), { recursive: true });
  writeFileSync(join(exportDir, 'result.json'), withFiles());
  writeFileSync(join(exportDir, PHOTO), 'JPEG412');
  writeFileSync(join(exportDir, 'files', 'крылья.rbxm'), 'RBXM');
  writeFileSync(join(exportDir, 'files', 'ТЗ.txt'), 'Сделать 3 шапки до пятницы, оплата после');
  writeFileSync(join(exportDir, 'video_files', 'клип.mp4_thumb.jpg'), 'THUMB432');
  writeFileSync(join(dir, 'secret.txt'), 'SECRET');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(files?: PartFiles) {
  const stub = stubFactory();
  const data = join(dir, 'data');
  const store = new Store(data, fakeSealer);
  const service = new TelegramService({ store, factory: stub.factory, now: () => NOW, offsetMin: 180, ...(files ? { files } : {}) });
  return { ...stub, store, service, data };
}

async function finished(service: TelegramService): Promise<ImportJob> {
  for (let i = 0; i < 2000; i++) {
    const { job } = await service.importState();
    if (job && job.stage !== 'picking' && job.stage !== 'reading') return job;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('выгрузка не дочитана');
}

const UGC = '-1001987654321';
// Reading goes in many small pieces: a loaded PC may take a while.
vi.setConfig({ testTimeout: 30_000 });

describe('helpers', () => {
  it('the export\'s date by its folder\'s name; a path out of the folder is never one of its files', () => {
    expect(folderDate('C:\\Users\\Макс\\Downloads\\Telegram Desktop\\ChatExport_2026-11-20')).toBe(new Date(2026, 10, 20, 12).toISOString());
    expect(folderDate('D:\\DataExport_2026-11-02 (2)')).toBe(new Date(2026, 10, 2, 12).toISOString());
    expect(folderDate('D:\\Выгрузки')).toBeNull();
    expect(folderDate('D:\\ChatExport_2026-13-40')).toBeNull();
    expect(insidePath('photos/photo_1@18-11-2026_20-22-00.jpg')).toBe('photos\\photo_1@18-11-2026_20-22-00.jpg');
    for (const bad of ['../secret.txt', 'files/../../x', 'C:\\Windows\\win.ini', '/etc/passwd', '\\\\server\\share\\x', '(File not included. Change data exporting settings to download.)', '', 42]) expect(insidePath(bad)).toBeNull();
  });

  it('a folder given to read makes the included files openable; without it, or without a date, as before', () => {
    const [opened] = parseExport(withFiles(), null, { folder: exportDir });
    const photo = opened!.messages.find((m) => m.id === 412)!.attachments[0]!;
    expect(photo).toMatchObject({ kind: 'photo', path: 'photos\\photo_412@18-11-2026_20-22-00.jpg', downloadable: true, size: 7 });
    expect(opened!.messages.find((m) => m.id === 432)!.attachments[0]).toMatchObject({ thumbPath: 'video_files\\клип.mp4_thumb.jpg', downloadable: true });
    expect(opened!.messages.find((m) => m.id === 433)!.attachments[0]).toMatchObject({ downloadable: false });
    expect(opened!.messages.find((m) => m.id === 433)!.attachments[0]!.path).toBeUndefined();
    // No date given: the newest message's time.
    expect(opened!.exportedAt).toBe(new Date(1795121200 * 1000).toISOString());
    const [plain] = parseExport(withFiles(), '2026-11-20T09:30:00.000Z');
    expect(plain!.folder).toBeUndefined();
    expect(plain!.messages.flatMap((m) => m.attachments).every((a) => !a.downloadable && !a.path)).toBe(true);
  });
});

describe('a program that cannot read picked files', () => {
  it('the screen is told to read result.json itself; picking is refused in words', async () => {
    for (const files of [undefined, oldProgramFiles()]) {
      const s = setup(files);
      expect((await s.service.status()).files).toEqual({ read: false, folder: false });
      expect((await s.service.importState()).access).toEqual({ read: false, folder: false });
      await expect(s.service.importPick({ folder: true })).rejects.toThrow(/обновите программу или выберите result\.json/);
    }
  });
});

describe('the part reads the export where it lies', () => {
  it('the export\'s folder: Windows\' window «to read», result.json read in pieces (letters split between pieces stay whole), sealed; no picture read yet', async () => {
    const files = stubFiles({ answer: [exportDir], piece: 63 });
    const s = setup(files);
    expect((await s.service.status()).files).toEqual({ read: true, folder: true });
    const started = await s.service.importPick({ folder: true });
    expect(started).toMatchObject({ stage: 'picking', folder: true });
    const job = await finished(s.service);
    expect(job).toMatchObject({ stage: 'done', files: 1, name: 'ChatExport_2026-11-20', skipped: [], chats: 1, error: null });
    expect(job.read).toBe(job.size);
    expect(job.added).toEqual([expect.objectContaining({ id: UGC, title: 'UGC команда', messages: 9, withFiles: true, exportedAt: new Date(2026, 10, 20, 12).toISOString() })]);
    expect(files.calls.filter((c) => c.startsWith('pick'))).toEqual(['pick folder-to-read']);
    expect(files.calls.filter((c) => c.startsWith('read ')).every((c) => c.endsWith('result.json'))).toBe(true);
    // 63 bytes a piece (odd): two-byte letters of «Сделал 3 шапки…» fall on many edges.
    expect(files.calls.filter((c) => c.startsWith('read ') && c.endsWith('result.json')).length).toBeGreaterThan(50);
    const chats = await s.service.chats({});
    expect(chats).toEqual([expect.objectContaining({ id: UGC, source: 'export', withFiles: true, allowed: false })]);
    await s.service.setAccess({ id: UGC, allowed: true });
    expect((await s.service.aiMessages({ chat: 'UGC команда' })).text).toContain('Сделал 3 шапки для UGC, вот превью. С тебя 1 500 ₽, жду оплату');
    expect(readFileSync(join(s.data, 'exports.bin'), 'utf8')).not.toContain('шапки');
    expect(s.state.calls).toEqual([]);
  });

  it('a folder of several exports: all of them; a chat exported twice keeps its newest copy; an HTML export is skipped in words', async () => {
    const older = join(root, 'ChatExport_2026-11-10');
    mkdirSync(older);
    writeFileSync(join(older, 'result.json'), JSON.stringify({ ...CHAT, messages: CHAT.messages.slice(0, 2) }));
    mkdirSync(join(root, 'Другое'));
    writeFileSync(join(root, 'Другое', 'result.json'), '<!DOCTYPE html><html></html>');
    mkdirSync(join(root, 'Пусто'));
    const s = setup(stubFiles({ answer: [root], piece: 4096 }));
    await s.service.importPick({ folder: true });
    const job = await finished(s.service);
    expect(job.stage).toBe('done');
    expect(job.files).toBe(3);
    expect(job.skipped).toEqual([{ name: 'Другое', error: expect.stringMatching(/HTML/) }]);
    expect(job.added).toEqual([expect.objectContaining({ title: 'UGC команда', messages: 9, exportedAt: new Date(2026, 10, 20, 12).toISOString() })]);
  });

  it('a folder with no export says so; the window closed changes nothing', async () => {
    const empty = join(dir, 'Документы');
    mkdirSync(empty);
    const files = stubFiles({ answer: [empty] });
    const s = setup(files);
    await s.service.importPick({ folder: true });
    expect(await finished(s.service)).toMatchObject({ stage: 'error', error: expect.stringMatching(/нет result\.json/) });
    files.answer = [];
    await s.service.importPick({ folder: true });
    expect(await finished(s.service)).toMatchObject({ stage: 'cancelled' });
    expect(await s.service.exportsList()).toEqual([]);
  });

  it('a program that tells when result.json was written (1.0.106+): that time is the export\'s, for a folder and for result.json alone', async () => {
    const written = new Date(2026, 10, 20, 21, 47, 5);
    utimesSync(join(exportDir, 'result.json'), written, written);
    for (const folder of [true, false]) {
      const files = stubFiles({ answer: [folder ? exportDir : join(exportDir, 'result.json')], piece: 4096, mtime: true });
      const s = setup(files);
      await s.service.importPick({ folder });
      const job = await finished(s.service);
      expect(job.added).toEqual([expect.objectContaining({ title: 'UGC команда', exportedAt: written.toISOString() })]);
      if (!folder) expect(files.calls).toContain(`stat ${join(exportDir, 'result.json')}`);
    }
    // No time, a time in the future or before Telegram had JSON exports — the folder's name, then the newest message.
    expect(exportTime(undefined, exportDir)).toBe(new Date(2026, 10, 20, 12).toISOString());
    expect(exportTime(new Date(Date.now() + 3 * 86_400_000).toISOString(), exportDir)).toBe(new Date(2026, 10, 20, 12).toISOString());
    expect(exportTime('2001-01-01T00:00:00.000Z', 'D:\\Выгрузки')).toBeNull();
    expect(exportTime('не время', 'D:\\Выгрузки')).toBeNull();
  });

  it('only result.json: text only — the AI is told the person can give the whole folder for pictures', async () => {
    const files = stubFiles({ answer: [join(exportDir, 'result.json')], piece: 4096 });
    const s = setup(files);
    await s.service.importPick({ folder: false });
    const job = await finished(s.service);
    expect(files.calls.filter((c) => c.startsWith('pick'))).toEqual(['pick file']);
    expect(job.added).toEqual([expect.objectContaining({ withFiles: false, exportedAt: new Date(2026, 10, 20, 12).toISOString() })]);
    await s.service.setAccess({ id: UGC, allowed: true });
    const told = await s.service.aiFile({ chat: UGC, message: 412 });
    expect(told.text).toContain('загрузил только result.json');
    expect(told.images).toBeUndefined();
    expect(files.calls.some((c) => c.includes('photo_412'))).toBe(false);
  });
});

describe('the AI and the export\'s files (its folder given to read)', () => {
  async function loaded() {
    const files = stubFiles({ answer: [exportDir], piece: 1 << 20 });
    const s = setup(files);
    await s.service.importPick({ folder: true });
    await finished(s.service);
    return { ...s, files };
  }

  it('only in an allowed chat; a picture read where it lies; a text file as text; another file told where it lies, never copied', async () => {
    const s = await loaded();
    await expect(s.service.aiFile({ chat: UGC, message: 412 })).rejects.toThrow(/не разрешён/);
    expect(s.files.calls.some((c) => c.includes('photo_412'))).toBe(false);
    await s.service.setAccess({ id: UGC, allowed: true });

    const photo = await s.service.aiFile({ chat: UGC, message: 412 });
    expect(photo.images).toEqual([{ data: Buffer.from('JPEG412').toString('base64'), mimeType: 'image/jpeg' }]);
    expect(photo.text).toContain('(по выгрузке от 20.11.2026)');
    expect(photo.notice).toBe('ИИ открыл файл из выгрузки чата «UGC команда»');

    const brief = await s.service.aiFile({ chat: UGC, message: 434 });
    expect(brief.text).toContain('Сделать 3 шапки до пятницы, оплата после');

    const model = await s.service.aiFile({ chat: UGC, message: 430 });
    expect(model.text).toContain(`лежит на ПК владельца в папке выгрузки: ${join(exportDir, 'files', 'крылья.rbxm')}`);
    expect(model.data).toMatchObject({ path: join(exportDir, 'files', 'крылья.rbxm') });

    const clip = await s.service.aiFile({ chat: UGC, message: 432 });
    expect(clip.images).toEqual([{ data: Buffer.from('THUMB432').toString('base64'), mimeType: 'image/jpeg' }]);
    expect(clip.text).toContain('Превью ниже');

    // A path leading out of the export's folder is not one of its files: never read.
    const out = await s.service.aiFile({ chat: UGC, message: 433 });
    expect(out.text).toContain('нет в папке выгрузки');
    expect(s.files.calls.some((c) => c.includes('secret'))).toBe(false);

    // Nothing copied into the app's folder.
    expect(existsSync(join(s.data, 'files')) ? readdirSync(join(s.data, 'files')) : []).toEqual([]);
    // The refused call too.
    expect(s.service.journal({}).map((j) => j.tool)).toEqual(['file', 'file', 'file', 'file', 'file', 'file']);
  });

  it('the export\'s folder moved away: the AI is told in words', async () => {
    const s = await loaded();
    await s.service.setAccess({ id: UGC, allowed: true });
    renameSync(exportDir, join(root, 'перенесла'));
    await expect(s.service.aiFile({ chat: UGC, message: 412 })).rejects.toThrow(/переместили или удалили/);
  });
});
