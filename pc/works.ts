import type { ChatKind, TgMessage } from './types';

// What the screen «Работы и оплата» (views.works, surface «mcp-app», kernel §12е) draws from telegram_search: each found
// message with its chat, author, sum and «оплачено?», and the address to open it in Telegram. The sum and «оплачено?» are read
// from the words of the message (and of a found answer to it) — a hint for the person and the AI, not a fact: the AI checks the
// conversation itself (mcp.instructions), the person opens the message.

/** structuredContent of a tool is at most 32 000 characters of JSON (Hub, MCP_STRUCTURED_MAX): the list keeps under it. */
export const WORKS_JSON_MAX = 30_000;
/** A message's text on the screen. */
export const WORK_TEXT_CHARS = 280;

export type Paid = 'yes' | 'no' | null;

export interface WorkItem {
  chat: string;
  chatId: string;
  id: number;
  /** ISO time. */
  date: string;
  who: string;
  username?: string;
  text: string;
  /** Sums found in the text, as written («1 500 ₽», «$20», «400 robux»). */
  amount: string | null;
  /** By the words: «оплатил», «перевёл»… — yes; «жду оплату», «не оплачено», «оплатил?» — no; otherwise unknown. */
  paid: Paid;
  /** The found message that answered this one with «оплатил». */
  paidBy?: number;
  replyTo?: number;
  /** https://t.me/… — the message itself (exact) or only the chat; null — Telegram gives no address (a small group, a person without @имя). */
  link: string | null;
  exact: boolean;
  /** Read from an export of Telegram Desktop made then (ISO), not from the live account. */
  exportedAt?: string;
}

export interface WorksData {
  query: string;
  /** Messages found (the text for the AI has them all). */
  count: number;
  /** Of them on the screen (the list keeps under WORKS_JSON_MAX). */
  shown: number;
  items: WorkItem[];
}

const NUM = String.raw`\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const MULT = String.raw`(?:\s?(?:к|k|тыс\.?|тысяч[аи]?)(?![a-zа-яё]))?`;
const CUR_AFTER = String.raw`(?:R\$|₽|руб(?:лей|ля|ль)?\.?|р\.|р(?![a-zа-яё])|rub(?![a-z])|usd(?![a-z])|\$|долл(?:аров|ара|ар)?\.?|бакс(?:ов|а)?(?![a-zа-яё])|€|eur(?![a-z])|евро(?![a-zа-яё])|грн\.?|₴|uah(?![a-z])|₸|тг(?![a-zа-яё])|robux|робукс(?:ов|а|ы)?|rbx(?![a-z]))`;
const AFTER = new RegExp(`(?<![\\d.,])(?:${NUM})${MULT}\\s?${CUR_AFTER}`, 'giu');
const BEFORE = new RegExp(`(?:R\\$|\\$|€)\\s?(?:${NUM})${MULT}(?![\\d])`, 'giu');

/** The sums of a text as written, in order, at most three («1 500 ₽, $20»); null — none. */
export function amountOf(text: string): string | null {
  const found: Array<{ at: number; s: string }> = [];
  for (const re of [AFTER, BEFORE]) for (const m of text.matchAll(re)) found.push({ at: m.index ?? 0, s: m[0].replace(/\s+/g, ' ').trim() });
  found.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  let end = -1;
  for (const f of found) {
    if (f.at < end) continue; // «$20» inside «20 $» — once
    end = f.at + f.s.length;
    if (!out.includes(f.s)) out.push(f.s);
    if (out.length === 3) break;
  }
  return out.length ? out.join(', ') : null;
}

const L = '[а-яёa-z]';
const NOT_PAID = new RegExp(
  [
    `не\\s+(?:оплат|заплат|скинул|скинули|перев[её]л|перевели|получил|пришл|оплачен)`,
    `ещё\\s+не\\s+(?:оплат|заплат|скин|перев)`,
    `жду\\s+(?:оплат|деньг|перевод|${L}*\\s+оплат)`,
    `когда\\s+(?:оплат|заплат|скин|перевед|будет\\s+оплат)`,
    `(?<!${L})долг(?:а|у)?(?!${L})`,
    `(?<!${L})(?:должен|должна|должны)(?!${L})`,
    `(?<!${L})оплатите?(?!${L})`,
    // A promise is not a payment yet: «оплачу в пятницу», «скину завтра».
    `(?<!${L})(?:оплачу|заплачу|скину|переведу|оплатим|заплатим|скинем|переведём|переведем)(?!${L})`,
    `will\\s+pay|i'?ll\\s+pay`,
    `unpaid|not\\s+paid|haven'?t\\s+paid|waiting\\s+for\\s+(?:the\\s+)?payment`,
  ].join('|'),
  'iu',
);
const PAID = new RegExp(
  [
    `(?<!${L})оплатил[аи]?(?!${L})`,
    `(?<!${L})оплачено(?!${L})`,
    `(?<!${L})заплатил[аи]?(?!${L})`,
    `отправил[аи]?\\s+(?:деньги|оплату)`,
    `получил[аи]?\\s+(?:оплату|деньги|перевод)`,
    `деньги\\s+пришли|пришли\\s+деньги|оплата\\s+прошла|спасибо\\s+за\\s+оплату`,
    `(?<![a-z])paid(?![a-z])|payment\\s+(?:sent|received)`,
  ].join('|'),
  'iu',
);

/** «скинул», «перевёл» are a payment only next to money: «скинул 700 ₽», «перевёл на карту» — not «скинул файлы», «перевёл текст». */
const PAID_WITH_MONEY = new RegExp(`(?<!${L})(?:скинул[аи]?|перев[её]л[аи]?)(?!${L})`, 'iu');
const MONEY_WORDS = /деньг|оплат|на\s+карт|бабк|сбер|тинькофф|т-банк|paypal|(?:скинул|перев[её]л)[аи]?\s+\d/iu;

/** «Оплачено?» by the words: a «not paid» first («не оплатил» holds «оплатил»); «оплатил?» — a question, not paid yet. */
export function paidOf(text: string): Paid {
  if (NOT_PAID.test(text)) return 'no';
  const m = PAID.exec(text) ?? (amountOf(text) || MONEY_WORDS.test(text) ? PAID_WITH_MONEY.exec(text) : null);
  if (!m) return null;
  const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 20);
  return /^[^.!\n]*\?/.test(after) ? 'no' : 'yes';
}

/**
 * The address of a message in Telegram: a public chat (@имя) and a supergroup or channel (-100…) — the message itself; a person
 * with @имя — the chat with them; a small group or a person without @имя — none (Telegram has no address for them).
 */
export function messageLink(chat: { id: string; kind: ChatKind; username?: string | null }, id: number): { url: string; exact: boolean } | null {
  const user = chat.kind === 'user' || chat.kind === 'bot';
  if (chat.username && /^[A-Za-z0-9_]{4,32}$/.test(chat.username)) return user ? { url: `https://t.me/${chat.username}`, exact: false } : { url: `https://t.me/${chat.username}/${id}`, exact: true };
  if (!user && /^-100\d+$/.test(chat.id)) return { url: `https://t.me/c/${chat.id.slice(4)}/${id}`, exact: true };
  return null;
}

const ATTACHMENT_WORD: Record<string, string> = {
  photo: 'фото',
  image: 'картинка',
  video: 'видео',
  audio: 'аудио',
  voice: 'голосовое',
  document: 'файл',
  sticker: 'стикер',
  webpage: 'ссылка',
  contact: 'контакт',
  location: 'место',
  poll: 'опрос',
  other: 'вложение',
};

function snippet(m: TgMessage): string {
  const words = m.attachments.map((a) => `[${ATTACHMENT_WORD[a.kind] ?? 'вложение'}${a.name ? ` «${a.name}»` : ''}]`).join(' ');
  const text = (m.service ?? m.text).replace(/\s+/g, ' ').trim();
  const all = [text, words].filter(Boolean).join(' ');
  return all.length > WORK_TEXT_CHARS ? `${all.slice(0, WORK_TEXT_CHARS - 1)}…` : all;
}

/** The found messages as the screen's list: newest first as found; «оплатил» in a found answer marks the message it answers. */
export function worksData(query: string, found: Array<{ chat: { id: string; kind: ChatKind; title: string; username?: string | null; exportedAt?: string }; m: TgMessage }>): WorksData {
  const all: WorkItem[] = found.map(({ chat, m }) => {
    const link = messageLink(chat, m.id);
    const full = `${m.text} ${m.attachments.map((a) => a.title ?? '').join(' ')}`;
    return {
      chat: chat.title,
      chatId: chat.id,
      id: m.id,
      date: m.date,
      who: m.from?.name ?? chat.title,
      ...(m.from?.username ? { username: m.from.username } : {}),
      text: snippet(m),
      amount: amountOf(full),
      paid: paidOf(m.text),
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      link: link?.url ?? null,
      exact: link?.exact ?? false,
      ...(chat.exportedAt ? { exportedAt: chat.exportedAt } : {}),
    };
  });
  const byKey = new Map(all.map((w) => [`${w.chatId}#${w.id}`, w]));
  for (const answer of all) {
    if (!answer.replyTo || !answer.paid) continue;
    const asked = byKey.get(`${answer.chatId}#${answer.replyTo}`);
    if (!asked || asked.paid === 'yes') continue;
    if (answer.paid === 'yes') {
      asked.paid = 'yes';
      asked.paidBy = answer.id;
    } else if (asked.paid === null) asked.paid = 'no';
  }
  const data: WorksData = { query, count: all.length, shown: 0, items: [] };
  let size = JSON.stringify(data).length;
  for (const w of all) {
    const add = JSON.stringify(w).length + 1;
    if (size + add > WORKS_JSON_MAX) break;
    data.items.push(w);
    size += add;
  }
  data.shown = data.items.length;
  return data;
}
