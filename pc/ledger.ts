// «Учёт работ» (1.5.0): the works the AI found in the allowed chats and what it concluded about each — who did it, what, the sum,
// paid or not — kept on this PC (works.bin, sealed by Windows like the exports). The AI writes its conclusions with
// telegram_works_note and reads them with telegram_works; the person marks rows on the app's screen in Hub (the screen's own
// methods, which the AI cannot call): a person's mark always wins, and the AI's later notes never change it.
//
// Rules (coordinator, 21.11): a row of the AI without evidence (other messages of the chat that show it) is never «paid» or «unpaid»
// — only «unknown», so the AI does not invent debts; «Что читал ИИ» gets only how many rows, never sums or names.

export type WorkStatus = 'unpaid' | 'paid' | 'not_work' | 'unknown';
export const WORK_STATUSES: readonly WorkStatus[] = ['unpaid', 'paid', 'not_work', 'unknown'];
/** What the person may set on a row: a status, «Убрать» (hidden, and the AI cannot bring it back), or «clear» — back to the AI's. */
export type PersonMark = WorkStatus | 'removed';

export const LEDGER = {
  /** Rows kept (the oldest notes of the AI go first; rows the person marked stay). */
  rows: 2000,
  /** Rows the AI writes in one call. */
  perCall: 50,
  /** Messages the part looks up in one call to check them (the work and its evidence). */
  lookups: 120,
  who: 80,
  what: 200,
  amount: 60,
  note: 300,
  evidence: 10,
  /** Rows in an answer to the AI and on the screen. */
  shown: 300,
} as const;

export interface LedgerRow {
  /** `${chatId}:${message}` — one row per work message. */
  key: string;
  chatId: string;
  /** The chat's title when the row was written. */
  chat: string;
  message: number;
  /** The work message's time (ISO). */
  date: string | null;
  who: string;
  what: string;
  amount: string | null;
  /** The AI's conclusion. */
  ai: { status: WorkStatus; evidence: number[]; note: string | null; at: string };
  /** The person's mark (the screen); null — none. */
  person: { status: PersonMark; at: string } | null;
  /** https://t.me/… of the work message (exact) or of the chat; null — Telegram gives no address. */
  link: string | null;
  exact: boolean;
  /** The chat was read from an export made then (ISO). */
  exportedAt?: string;
}

/** What the row says now: the person's mark if any, else the AI's conclusion. */
export function statusOf(row: LedgerRow): PersonMark {
  return row.person?.status ?? row.ai.status;
}

/** Who decided the row's status. */
export const decidedBy = (row: LedgerRow): 'person' | 'ai' => (row.person ? 'person' : 'ai');

export const STATUS_WORD: Record<PersonMark, string> = { unpaid: 'не оплачено', paid: 'оплачено', not_work: 'не работа', unknown: 'неизвестно', removed: 'убрано' };

/** «open» — what is still to settle (unpaid and unknown); «all» — every row but the removed ones. */
export type LedgerFilter = 'open' | 'all' | WorkStatus;

export function matches(row: LedgerRow, filter: LedgerFilter): boolean {
  const s = statusOf(row);
  if (s === 'removed') return false;
  if (filter === 'all') return true;
  if (filter === 'open') return s === 'unpaid' || s === 'unknown';
  return s === filter;
}

// ——— Sums ———

const CURRENCY: Array<[RegExp, string]> = [
  [/^R\$$/i, 'R$'],
  [/^(₽|руб(лей|ля|ль)?\.?|р\.?|rub)$/i, '₽'],
  [/^(\$|usd|долл(аров|ара|ар)?\.?|бакс(ов|а)?)$/i, '$'],
  [/^(€|eur|евро)$/i, '€'],
  [/^(₴|грн\.?|uah)$/i, '₴'],
  [/^(₸|тг)$/i, '₸'],
  [/^(robux|робукс(ов|а|ы)?|rbx)$/i, 'robux'],
];

const currencyOf = (raw: string): string | null => CURRENCY.find(([re]) => re.test(raw.trim()))?.[1] ?? null;

const SUM = /(R\$|\$|€)?\s?(\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(\s?(?:к|k|тыс\.?|тысяч[аи]?)(?![a-zа-яё]))?\s?(R\$|₽|руб(?:лей|ля|ль)?\.?|р\.|р(?![a-zа-яё])|rub(?![a-z])|usd(?![a-z])|\$|долл(?:аров|ара|ар)?\.?|бакс(?:ов|а)?(?![a-zа-яё])|€|eur(?![a-z])|евро(?![a-zа-яё])|грн\.?|₴|uah(?![a-z])|₸|тг(?![a-zа-яё])|robux|робукс(?:ов|а|ы)?|rbx(?![a-z]))?/giu;

/** The sums of an amount as written («1 500 ₽, $20», «2к руб», «400 robux») with their currency; a number without one is skipped. */
export function parseAmount(text: string | null | undefined): Array<{ value: number; cur: string }> {
  const out: Array<{ value: number; cur: string }> = [];
  for (const m of String(text ?? '').matchAll(SUM)) {
    const cur = currencyOf(m[1] ?? m[4] ?? '');
    if (!cur || (m[1] && m[4])) continue;
    let value = Number(m[2]!.replace(/[   ]/g, '').replace(',', '.'));
    if (m[3]) value *= 1000;
    if (Number.isFinite(value) && value > 0) out.push({ value, cur });
  }
  return out;
}

export const sumText = (value: number, cur: string) => {
  // Plain spaces between the thousands (ru-RU gives a narrow no-break space): the text goes to the AI and to a message as it is.
  const n = value.toLocaleString('ru-RU', { maximumFractionDigits: 2 }).replace(/[  ]/g, ' ');
  return cur === '$' || cur === '€' || cur === 'R$' ? `${cur}${n}` : `${n} ${cur}`;
};

export interface Total {
  who: string;
  rows: number;
  sums: Array<{ cur: string; value: number }>;
  /** Rows whose sum could not be read (no currency, or none written). */
  unread: number;
}

/** «Кто сколько должен»: the rows still unpaid, by who, with their sums added per currency (most owed first). */
export function totalsOf(rows: LedgerRow[]): Total[] {
  const by = new Map<string, Total>();
  for (const r of rows) {
    if (statusOf(r) !== 'unpaid') continue;
    const who = r.who || 'без имени';
    const t = by.get(who.toLowerCase()) ?? { who, rows: 0, sums: [], unread: 0 };
    t.rows++;
    const sums = parseAmount(r.amount);
    if (!sums.length) t.unread++;
    for (const s of sums) {
      const have = t.sums.find((x) => x.cur === s.cur);
      if (have) have.value += s.value;
      else t.sums.push({ ...s });
    }
    by.set(who.toLowerCase(), t);
  }
  return [...by.values()].sort((a, b) => b.rows - a.rows || a.who.localeCompare(b.who, 'ru'));
}

export const totalLine = (t: Total) =>
  `${t.who} — ${t.sums.length ? t.sums.map((s) => sumText(s.value, s.cur)).join(' + ') : 'сумма не указана'}${t.unread && t.sums.length ? ` и ещё ${t.unread} без суммы` : ''} (${t.rows} ${t.rows === 1 ? 'работа' : t.rows < 5 ? 'работы' : 'работ'})`;

/** The text the person copies to send («Скопировать неоплаченное»): each unpaid work, then the totals. */
export function unpaidText(rows: LedgerRow[], dayOf: (iso: string) => string): string {
  const open = rows.filter((r) => statusOf(r) === 'unpaid');
  if (!open.length) return 'Неоплаченных работ нет.';
  const lines = open.map((r) => `• ${r.date ? `${dayOf(r.date)} · ` : ''}${r.who || 'без имени'} · ${r.what}${r.amount ? ` — ${r.amount}` : ''}`);
  return ['Неоплаченные работы:', ...lines, '', 'Итого:', ...totalsOf(open).map((t) => `• ${totalLine(t)}`)].join('\n');
}

// ——— What the AI writes ———

export interface AiNote {
  chat: string;
  message: number;
  who: string;
  what: string;
  amount: string | null;
  status: WorkStatus;
  evidence: number[];
  note: string | null;
}

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** One row of the AI's call, read and checked; a string — why it is refused. */
export function readNote(raw: unknown): AiNote | string {
  const x = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const chat = clip(x.chat, 200);
  const message = Number(x.message);
  if (!chat) return 'нет chat';
  if (!Number.isInteger(message) || message <= 0) return 'message — номер сообщения работы (#…)';
  const what = clip(x.what, LEDGER.what);
  if (!what) return `#${message}: what — что за работа`;
  const status = WORK_STATUSES.includes(x.status as WorkStatus) ? (x.status as WorkStatus) : null;
  if (!status) return `#${message}: status — unpaid, paid, not_work или unknown`;
  const evidence = Array.isArray(x.evidence) ? [...new Set(x.evidence.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, LEDGER.evidence) : [];
  const amount = clip(x.amount, LEDGER.amount) || null;
  return { chat, message, who: clip(x.who, LEDGER.who), what, amount, status, evidence, note: clip(x.note, LEDGER.note) || null };
}

/**
 * The status the AI may give: «paid» and «unpaid» only with evidence — messages of the chat that show it (the work message itself
 * counts when it says «с тебя 1 500, жду оплату»); otherwise «unknown».
 */
export function allowedStatus(n: Pick<AiNote, 'status' | 'evidence'>): { status: WorkStatus; downgraded: boolean } {
  if ((n.status === 'paid' || n.status === 'unpaid') && n.evidence.length === 0) return { status: 'unknown', downgraded: true };
  return { status: n.status, downgraded: false };
}

/** Keeps the ledger under its size: rows the person marked stay; of the rest the oldest notes go first. */
export function trimLedger(rows: LedgerRow[]): LedgerRow[] {
  if (rows.length <= LEDGER.rows) return rows;
  const marked = rows.filter((r) => r.person);
  const rest = rows.filter((r) => !r.person).sort((a, b) => b.ai.at.localeCompare(a.ai.at));
  const keep = new Set([...marked, ...rest].slice(0, LEDGER.rows).map((r) => r.key));
  return rows.filter((r) => keep.has(r.key));
}
