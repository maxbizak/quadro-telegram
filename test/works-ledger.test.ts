import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedStatus, LEDGER, parseAmount, readNote, totalLine, totalsOf, trimLedger, unpaidText, type LedgerRow } from '../pc/ledger';
import { AI_TOOLS, SCREEN_METHODS } from '../pc/part';
import { TelegramService } from '../pc/service';
import { Store } from '../pc/store';
import { fakeSealer, stubFactory } from './stub-tg';

// «Учёт работ» (1.5.0): the AI writes its conclusions about works (telegram_works_note) and reads them (telegram_works); the person
// marks rows on the screen (worksMark — a screen method the AI cannot call) and a person's mark always wins. Without evidence the AI
// never says «paid» / «unpaid» (only «unknown»); «Что читал ИИ» gets how many rows — never sums or names; the ledger is sealed.

const CHAT = readFileSync(join(__dirname, 'fixtures', 'result-chat.json'), 'utf8');
const EXPORTED = '2026-11-20T09:30:00.000Z';
const NOW = Date.parse('2026-11-20T12:00:00Z');
const UGC = '-1001987654321';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qh-tg-works-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(sealer: typeof fakeSealer | null = fakeSealer) {
  const stub = stubFactory();
  const store = new Store(dir, sealer);
  const service = new TelegramService({ store, factory: stub.factory, now: () => NOW, offsetMin: 180 });
  return { ...stub, store, service };
}

async function withExport(allowed = true) {
  const s = setup();
  const { id } = s.service.importStart({ size: CHAT.length, exportedAt: Date.parse(EXPORTED) });
  s.service.importChunk({ id, text: CHAT });
  await s.service.importEnd({ id });
  if (allowed) await s.service.setAccess({ id: UGC, allowed: true });
  return s;
}

const note = (o: Record<string, unknown>) => ({ chat: UGC, what: 'работа', status: 'unknown', ...o });

describe('the ledger\'s rules', () => {
  it('sums as written, with their currency; a number without one is not a sum', () => {
    expect(parseAmount('1 500 ₽')).toEqual([{ value: 1500, cur: '₽' }]);
    expect(parseAmount('$20, 400 robux')).toEqual([
      { value: 20, cur: '$' },
      { value: 400, cur: 'robux' },
    ]);
    expect(parseAmount('2к руб')).toEqual([{ value: 2000, cur: '₽' }]);
    expect(parseAmount('12,5 €')).toEqual([{ value: 12.5, cur: '€' }]);
    expect(parseAmount('3 шапки')).toEqual([]);
    expect(parseAmount(null)).toEqual([]);
  });

  it('«paid» / «unpaid» only with evidence — else «unknown»; «not_work» and «unknown» need none', () => {
    expect(allowedStatus({ status: 'unpaid', evidence: [] })).toEqual({ status: 'unknown', downgraded: true });
    expect(allowedStatus({ status: 'paid', evidence: [] })).toEqual({ status: 'unknown', downgraded: true });
    expect(allowedStatus({ status: 'paid', evidence: [415] })).toEqual({ status: 'paid', downgraded: false });
    expect(allowedStatus({ status: 'not_work', evidence: [] })).toEqual({ status: 'not_work', downgraded: false });
    expect(readNote({ chat: UGC, message: 0, what: 'x', status: 'paid' })).toMatch(/номер сообщения/);
    expect(readNote({ chat: UGC, message: 5, what: '', status: 'paid' })).toMatch(/what/);
    expect(readNote({ chat: UGC, message: 5, what: 'x', status: 'debt' })).toMatch(/status/);
    expect(readNote({ chat: UGC, message: 5, what: 'x'.repeat(500), status: 'paid', evidence: [1, 1, 'z', -2, 3] })).toMatchObject({ what: 'x'.repeat(LEDGER.what), evidence: [1, 3] });
  });

  it('unpaid sums by person, per currency; the text to copy; trimming keeps the person\'s rows', () => {
    const row = (key: string, who: string, amount: string | null, status: 'unpaid' | 'paid', person = false): LedgerRow => ({
      key,
      chatId: UGC,
      chat: 'UGC команда',
      message: Number(key),
      date: '2026-11-18T17:00:00.000Z',
      who,
      what: `работа ${key}`,
      amount,
      ai: { status, evidence: [1], note: null, at: `2026-11-20T10:00:0${key.length}.000Z` },
      person: person ? { status, at: '2026-11-20T11:00:00.000Z' } : null,
      link: null,
      exact: false,
    });
    const rows = [row('1', 'Иван', '1 500 ₽', 'unpaid'), row('2', 'иван', '$20', 'unpaid'), row('3', 'Иван', null, 'unpaid'), row('4', 'Даня', '400 robux', 'unpaid'), row('5', 'Даня', '700 ₽', 'paid')];
    expect(totalsOf(rows).map(totalLine)).toEqual(['Иван — 1 500 ₽ + $20 и ещё 1 без суммы (3 работы)', 'Даня — 400 robux (1 работа)']);
    const text = unpaidText(rows, () => '18.11.2026');
    expect(text).toContain('• 18.11.2026 · Даня · работа 4 — 400 robux');
    expect(text).not.toContain('работа 5');
    expect(unpaidText([rows[4]!], () => '')).toBe('Неоплаченных работ нет.');
    const many = Array.from({ length: LEDGER.rows + 5 }, (_, i) => row(String(i + 10), 'X', null, 'unpaid', i < 3));
    const kept = trimLedger(many);
    expect(kept).toHaveLength(LEDGER.rows);
    expect(kept.filter((r) => r.person)).toHaveLength(3);
  });
});

describe('the AI writes its conclusions, the person marks', () => {
  it('a row per work message: checked in the chat, evidence checked, «unpaid» without evidence becomes «unknown»; the journal has only the count', async () => {
    const s = await withExport();
    const a = await s.service.aiWorksNote({
      items: [
        note({ message: 412, who: 'Иван Петров', what: '3 шапки для UGC', amount: '1 500 ₽', status: 'paid', evidence: [415, 999] }),
        note({ message: 430, what: 'аксессуар «крылья»', amount: '400 robux', status: 'unpaid' }),
        note({ message: 431, what: 'вакансия', status: 'not_work' }),
        note({ message: 777, what: 'нет такого', status: 'unknown' }),
        { chat: UGC, message: 399, status: 'paid' },
      ],
    });
    expect(a.text).toContain('записал 3, обновил 0, отказ 2');
    expect(a.text).toMatch(/Без доказательств — «неизвестно».*#430/);
    expect(a.text).toContain('Таких сообщений-доказательств в чате нет, не записал их: #999');
    expect(a.text).toContain('#777: такого сообщения нет в чате «UGC команда»');
    expect(a.notice).toBe('ИИ записал в учёт работ: 3');
    const data = a.data as { kind: string; rows: Array<{ message: number; status: string; by: string; evidence: number[]; who: string; date: string; link: string | null }> };
    expect(data.kind).toBe('ledger');
    // The answer's table: the rows still to settle (430 unknown); 412 is paid, 431 is not a work.
    expect(data.rows.map((r) => [r.message, r.status])).toEqual([[430, 'unknown']]);
    const all = await s.service.worksList({ filter: 'all' });
    expect(all.rows.map((r) => [r.message, r.status, r.by, r.evidence])).toEqual([
      [431, 'not_work', 'ai', []],
      [430, 'unknown', 'ai', []],
      [412, 'paid', 'ai', [415]],
    ]);
    expect(all.rows.find((r) => r.message === 430)!.who).toBe('Даня');
    expect(all.rows.find((r) => r.message === 412)!.link).toBe('https://t.me/c/1987654321/412');
    // «Что читал ИИ»: the tool and how many rows — never the sums or the names.
    const [entry] = s.service.journal({});
    expect(entry).toMatchObject({ tool: 'works_note', rows: 3, chats: [] });
    expect(JSON.stringify(entry)).not.toMatch(/1 500|robux|Иван|Даня|шапки/);
  });

  it('the person\'s mark wins: the AI\'s next note does not change it; «removed» stays removed; «clear» gives the row back to the AI', async () => {
    const s = await withExport();
    await s.service.aiWorksNote({ items: [note({ message: 430, what: 'крылья', amount: '400 robux', status: 'unpaid', evidence: [430] })] });
    let row = (await s.service.worksList({ filter: 'all' })).rows[0]!;
    expect(row).toMatchObject({ status: 'unpaid', by: 'ai' });
    await s.service.worksMark({ key: row.key, status: 'paid' });
    const again = await s.service.aiWorksNote({ items: [note({ message: 430, what: 'крылья', status: 'unpaid', evidence: [430] })] });
    expect(again.text).toContain('человек отметил «оплачено», не меняю');
    expect(again.notice).toBeUndefined();
    row = (await s.service.worksList({ filter: 'all' })).rows[0]!;
    expect(row).toMatchObject({ status: 'paid', by: 'person', ai: 'unpaid' });
    // The AI sees the person's mark in telegram_works.
    expect((await s.service.aiWorks({ status: 'all' })).text).toContain('— оплачено (отметил человек)');
    await s.service.worksMark({ key: row.key, status: 'removed' });
    expect((await s.service.worksList({ filter: 'all' })).rows).toEqual([]);
    expect((await s.service.worksList({ filter: 'removed' })).rows).toHaveLength(1);
    expect((await s.service.aiWorksNote({ items: [note({ message: 430, what: 'крылья', status: 'unpaid', evidence: [430] })] })).text).toContain('человек отметил «убрано»');
    await s.service.worksMark({ key: row.key, status: 'clear' });
    expect((await s.service.worksList({ filter: 'all' })).rows[0]).toMatchObject({ status: 'unpaid', by: 'ai' });
    await expect(s.service.worksMark({ key: row.key, status: 'owed' })).rejects.toThrow(/Отметка/);
    await expect(s.service.worksMark({ key: 'nope', status: 'paid' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('only allowed chats: a closed chat is refused and its rows are hidden from the AI (the person still sees them)', async () => {
    const s = await withExport();
    await s.service.aiWorksNote({ items: [note({ message: 412, what: 'шапки', amount: '1 500 ₽', status: 'unpaid', evidence: [412] })] });
    await s.service.setAccess({ id: UGC, allowed: false });
    const refused = await s.service.aiWorksNote({ items: [note({ message: 430, what: 'крылья', status: 'unknown' })] });
    expect(refused.text).toMatch(/отказ 1/);
    expect(refused.text).toMatch(/не разрешён/);
    expect((await s.service.aiWorks({})).text).toMatch(/пока пусто/);
    expect((await s.service.worksList({ filter: 'all' })).rows).toHaveLength(1);
    // A call too big, or empty, is refused before anything is read.
    await expect(s.service.aiWorksNote({ items: Array.from({ length: LEDGER.perCall + 1 }, (_, i) => note({ message: i + 1 })) })).rejects.toThrow(/до 50 работ/);
    await expect(s.service.aiWorksNote({ items: [] })).rejects.toThrow(/items/);
  });

  it('telegram_works: open rows by default, the unpaid sums by person, filters by chat and who; empty — says how to start', async () => {
    const empty = await withExport();
    expect((await empty.service.aiWorks({})).text).toMatch(/пока пусто.*telegram_works_note/);
    const s = await withExport();
    await s.service.aiWorksNote({
      items: [
        note({ message: 412, who: 'Иван Петров', what: '3 шапки', amount: '1 500 ₽', status: 'unpaid', evidence: [412] }),
        note({ message: 430, what: 'крылья', amount: '400 robux', status: 'unpaid', evidence: [430] }),
        note({ message: 399, what: 'текстуры', amount: '700 ₽', status: 'paid', evidence: [399] }),
      ],
    });
    const open = await s.service.aiWorks({});
    expect(open.text).toContain('Учёт работ (неоплаченные и неизвестные): 2.');
    expect(open.text).toContain('- Даня — 400 robux (1 работа)');
    expect(open.text).toContain('- Иван Петров — 1 500 ₽ (1 работа)');
    expect(open.text).toContain('#412 · «UGC команда» (chat=-1001987654321) · 18.11.2026 · Иван Петров · 3 шапки — 1 500 ₽ — не оплачено (решил ИИ; доказательства #412)');
    expect((await s.service.aiWorks({ who: 'дан' })).text).not.toContain('Иван');
    expect((await s.service.aiWorks({ status: 'paid' })).text).toContain('текстуры');
    expect((await s.service.aiWorks({ chat: 'ugc команда', status: 'all' })).text).toContain(': 3.');
    expect((open.data as { totals: unknown[] }).totals).toHaveLength(2);
    expect(s.service.journal({})[0]).toMatchObject({ tool: 'works', rows: 3 });
    // The person's own look (the screen «Работы и оплата» in Hub) writes nothing to «Что читал ИИ».
    const before = s.service.journal({}).length;
    await s.service.personWorks({ status: 'all' });
    expect(s.service.journal({})).toHaveLength(before);
    expect((await s.service.worksText()).text).toMatch(/Неоплаченные работы:[\s\S]*Итого:/);
  });

  it('kept sealed on the PC; a program without sealing cannot keep it; «выйти совсем» removes it', async () => {
    const s = await withExport();
    await s.service.aiWorksNote({ items: [note({ message: 412, who: 'Иван Петров', what: '3 шапки', amount: '1 500 ₽', status: 'unpaid', evidence: [412] })] });
    const raw = readFileSync(join(dir, 'works.bin'), 'utf8');
    expect(raw.startsWith('SEALED:')).toBe(true);
    expect(raw).not.toMatch(/шапки|Иван|1 500/);
    // A new start reads it back.
    const again = new TelegramService({ store: new Store(dir, fakeSealer), factory: s.factory, now: () => NOW, offsetMin: 180 });
    expect((await again.worksList({ filter: 'all' })).rows).toHaveLength(1);
    await s.service.logout({ keys: true });
    expect(existsSync(join(dir, 'works.bin'))).toBe(false);
    const plain = setup(null);
    await expect(plain.service.aiWorksNote({ items: [note({ message: 412 })] })).rejects.toThrow(/обновите программу/);
  });

  it('the part: the AI\'s tools are worksNote and works; the person\'s screen has no method that writes the AI\'s conclusions', () => {
    expect(AI_TOOLS).toEqual(expect.arrayContaining(['worksNote', 'works']));
    expect(SCREEN_METHODS).toEqual(expect.arrayContaining(['works', 'worksList', 'worksMark', 'worksText']));
    expect(SCREEN_METHODS as readonly string[]).not.toContain('worksNote');
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'manifest.json'), 'utf8')) as { mcp: { tools: Array<{ name: string; handler: string; readOnly?: boolean; destructive?: boolean; view?: string }> } };
    const tools = Object.fromEntries(manifest.mcp.tools.map((t) => [t.name, t]));
    expect(tools.works_note).toMatchObject({ handler: 'pc:worksNote', readOnly: false, destructive: false, view: 'works' });
    expect(tools.works).toMatchObject({ handler: 'pc:works', readOnly: true, view: 'works' });
  });
});
