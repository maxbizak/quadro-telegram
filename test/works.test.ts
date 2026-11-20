import { describe, expect, it } from 'vitest';
import type { TgMessage } from '../pc/types';
import { amountOf, messageLink, paidOf, WORKS_JSON_MAX, worksData } from '../pc/works';

// The screen «Работы и оплата» (telegram_search's view): sums and «оплачено?» from the words, the address of a message, the list
// under the size of structuredContent.

const msg = (id: number, text: string, patch: Partial<TgMessage> = {}): TgMessage => ({
  id,
  date: `2026-11-${String(10 + (id % 10)).padStart(2, '0')}T12:00:00.000Z`,
  from: { id: '555', name: 'Иван Петров', username: 'ivan_p' },
  text,
  links: [],
  attachments: [],
  ...patch,
});
const group = { id: '-1001234', kind: 'group' as const, title: 'UGC работа' };

describe('sums in the words of a message', () => {
  it('reads roubles, dollars, robux, thousands — as written, at most three', () => {
    expect(amountOf('Сделал шапку, с тебя 1 500 ₽')).toBe('1 500 ₽');
    expect(amountOf('за модель 2000р, за текстуру 500 руб.')).toBe('2000р, 500 руб.');
    expect(amountOf('Цена $20, или 20 USD')).toBe('$20, 20 USD');
    expect(amountOf('400 robux за UGC шляпу')).toBe('400 robux');
    expect(amountOf('ок, 3к ₽ норм')).toBe('3к ₽');
    expect(amountOf('выйдет 1,5 тыс. руб')).toBe('1,5 тыс. руб');
    expect(amountOf('100 R$ и 5 €, и 7 грн, и 9 тг')).toBe('100 R$, 5 €, 7 грн');
  });

  it('a number without money is not a sum', () => {
    expect(amountOf('созвон в 18:00, 3 раза переделал')).toBeNull();
    expect(amountOf('20 раз сказал')).toBeNull();
    expect(amountOf('версия 2026-11-20')).toBeNull();
  });
});

describe('«оплачено?» by the words', () => {
  it('paid: оплатил, перевёл, скинул, деньги пришли', () => {
    for (const t of ['Оплатил, проверь', 'перевёл на карту', 'скинул 1500', 'деньги пришли, спасибо', 'Спасибо за оплату!', 'paid via PayPal'])
      expect(paidOf(t), t).toBe('yes');
  });

  it('not paid: «не оплатил», waiting, asking, a debt — and a question «оплатил?»', () => {
    for (const t of ['ещё не оплатил', 'жду оплату за шапку', 'когда оплатишь?', 'ты мне должен 500р', 'Оплатите, пожалуйста', 'ты оплатил?', 'unpaid invoice', 'Оплачу в пятницу', 'скину завтра', "I'll pay tomorrow"])
      expect(paidOf(t), t).toBe('no');
  });

  it('nothing about money — unknown; «скинул» and «перевёл» without money are not a payment', () => {
    expect(paidOf('готово, лови файл')).toBeNull();
    expect(paidOf('долго делал, но вот')).toBeNull();
    expect(paidOf('Скинул файлы, проверь')).toBeNull();
    expect(paidOf('перевёл описание на английский')).toBeNull();
    expect(paidOf('Перевёл за текстуры 700 ₽, спасибо!')).toBe('yes');
  });
});

describe('the address of a message', () => {
  it('a public chat and a supergroup — the message; a person with @имя — the chat; others — none', () => {
    expect(messageLink({ id: '-1009', kind: 'channel', username: 'ugcnews' }, 12)).toEqual({ url: 'https://t.me/ugcnews/12', exact: true });
    expect(messageLink(group, 77)).toEqual({ url: 'https://t.me/c/1234/77', exact: true });
    expect(messageLink({ id: '555', kind: 'user', username: 'ivan_p' }, 5)).toEqual({ url: 'https://t.me/ivan_p', exact: false });
    expect(messageLink({ id: '777', kind: 'user' }, 5)).toBeNull();
    expect(messageLink({ id: '-4521', kind: 'group' }, 5)).toBeNull();
    expect(messageLink({ id: '-1001', kind: 'group', username: 'bad name/../x' }, 5)).toEqual({ url: 'https://t.me/c/1/5', exact: true });
  });
});

describe('the list of the screen', () => {
  it('each found message with its chat, author, sum, «оплачено?», address; an answer «оплатил» marks the work it answers', () => {
    const data = worksData('оплат', [
      { chat: group, m: msg(10, 'Сделал 3 шапки, с тебя 1 500 ₽') },
      { chat: group, m: msg(11, 'Оплатил, проверь', { from: { id: '1', name: 'Макс' }, replyTo: 10 }) },
      { chat: group, m: msg(12, 'за аксессуар 400 robux, жду оплату') },
      { chat: { id: '777', kind: 'user', title: 'Мама' }, m: msg(3, 'фото', { from: null, attachments: [{ kind: 'photo', downloadable: true }] }) },
    ]);
    expect(data).toMatchObject({ query: 'оплат', count: 4, shown: 4 });
    expect(data.items[0]).toEqual({
      chat: 'UGC работа',
      chatId: '-1001234',
      id: 10,
      date: '2026-11-10T12:00:00.000Z',
      who: 'Иван Петров',
      username: 'ivan_p',
      text: 'Сделал 3 шапки, с тебя 1 500 ₽',
      amount: '1 500 ₽',
      paid: 'yes',
      paidBy: 11,
      link: 'https://t.me/c/1234/10',
      exact: true,
    });
    expect(data.items[1]).toMatchObject({ who: 'Макс', paid: 'yes', replyTo: 10 });
    expect(data.items[2]).toMatchObject({ amount: '400 robux', paid: 'no' });
    expect(data.items[3]).toMatchObject({ who: 'Мама', text: 'фото [фото]', amount: null, paid: null, link: null, exact: false });
  });

  it('keeps under the size of structuredContent; the count says how many were found', () => {
    const long = 'Сделал модель, жду оплату 2000 ₽. '.repeat(20);
    const data = worksData('оплат', Array.from({ length: 200 }, (_, i) => ({ chat: group, m: msg(i + 1, long) })));
    expect(data.count).toBe(200);
    expect(data.shown).toBeLessThan(200);
    expect(data.shown).toBe(data.items.length);
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(WORKS_JSON_MAX);
    expect(data.items[0]!.text.length).toBeLessThanOrEqual(280);
  });
});
