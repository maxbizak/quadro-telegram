// «Учёт работ» (1.5.0) end to end, in a copy of Hub, with no keys, no sign-in and no Telegram, hidden window only:
//   the real part from dist/ (the author mode), the program's own bridges and the AI's bridge «Hub → this PC».
//   1) the export of Telegram Desktop (QUADRO_PROBE_FILES — its folder) is loaded, «UGC команда» allowed for the AI;
//   2) as the AI (MCP over a key given this package): telegram_works_note — #412 «paid» with evidence #415, #430 «unpaid» with
//      evidence #430, #431 «unpaid» without evidence (→ «неизвестно»); telegram_works shows the open rows and the unpaid sums;
//   3) the person, tab «Работы»: the rows, «Не оплачено по людям», marks #430 «Оплачено»; the AI's next note on #430 does not
//      change it, telegram_works says «отметил человек»;
//   4) «Что читал ИИ»: «Записал в учёт работ» with the number of rows — no sums, no names;
//   5) the screen «Работы и оплата» in Hub: «Учёт работ» (quadro.tools.call('works') — the part's own method) draws the ledger.
//
//   QUADRO_PROBE_LOGIN=test_owner:<password> QUADRO_DEV_PACKAGES=<this folder>\dist QUADRO_PROBE_RELAY=1 PROBE_OUT=<folder> \
//   QUADRO_PROBE_FILES=<…>\ChatExport_2026-11-20 PROBE_API=http://127.0.0.1:8891 \
//   electron <Hub>/apps/desktop/scripts/probe.cjs --addr apps.localhost --port 5291 --path p/quadro.telegram --bridges \
//     --apps <empty folder> --steps test/probe-ledger.cjs        (the copy started with HUB_DEV_PACKAGES=<a folder with this dist>)
/* eslint-disable */
const OUT = process.env.PROBE_OUT || '.';
const API = process.env.PROBE_API || 'http://127.0.0.1:8891';

module.exports = async (probe) => {
  const { win, js, wait, log } = probe;
  const shot = async (file) => {
    const [w, h] = win.getSize();
    win.setSize(w, h + 1);
    await wait(400);
    win.setSize(w, h);
    await wait(600);
    await probe.shot(file);
  };
  const frameWith = async (selector) => {
    for (const x of win.webContents.mainFrame.framesInSubtree.filter((f) => f !== win.webContents.mainFrame)) {
      try {
        if (await x.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`)) return x;
      } catch {}
    }
    return null;
  };
  let selector = '.tg';
  const inFrame = async (expr) => (await frameWith(selector))?.executeJavaScript(expr) ?? null;
  const untilFrame = async (expr, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await inFrame(expr).catch(() => null);
      if (v) return v;
      if (Date.now() > end) throw new Error('не дождался в кадре: ' + expr + ' — на экране: ' + String(await inFrame('document.body.innerText').catch(() => '')).slice(0, 500));
      await wait(250);
    }
  };
  const has = (text, ms) => untilFrame(`document.body.innerText.includes(${JSON.stringify(text)})`, ms);
  const click = async (text) => {
    if (!(await inFrame(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`))) throw new Error('нет кнопки «' + text + '»');
  };
  const tab = (name) => inFrame(`[...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim() === ${JSON.stringify(name)}).click()`);
  const asPerson = (method, path, body) =>
    js(`(async () => { const csrf = decodeURIComponent((document.cookie.match(/qh_csrf=([^;]+)/) || [])[1] || ''); const r = await fetch('/api${path}', { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ''} credentials: 'include' }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null }; })()`);
  let rpcId = 0;
  const mcp = async (token, method, params) => {
    const r = await fetch(`${API}/api/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    const t = await r.text();
    if (!r.ok) throw new Error(`MCP ${method}: ${r.status} ${t.slice(0, 300)}`);
    return JSON.parse(t);
  };
  const textOf = (res) => (res.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const call = async (token, name, args) => {
    const res = await mcp(token, 'tools/call', { name, arguments: args });
    if (res.error || res.result?.isError) throw new Error(`${name}: ${JSON.stringify(res.error || textOf(res)).slice(0, 400)}`);
    return res;
  };

  // 1) The export, the chat allowed.
  await has('Нет ключей или не получается войти?', 60000);
  await inFrame(`(() => { const st = document.createElement('style'); st.textContent = '*,*::after{transition:none!important}'; document.head.append(st); return true; })()`);
  await click('Загрузить выгрузку');
  await has('Выбрать папку выгрузки');
  await click('Выбрать папку выгрузки');
  await has('Без входа — по выгрузке из Telegram Desktop', 30000);
  await has('UGC команда');
  await inFrame(`document.querySelector('input[role="switch"][aria-label="ИИ может читать «UGC команда»"]').click()`);
  await has('ИИ читает');

  // 2) As the AI.
  await asPerson('PUT', '/me/packages/quadro.telegram/ai', { on: true });
  const zones = await asPerson('GET', '/workspaces');
  const ws = (zones.body.workspaces || zones.body)[0];
  const created = await asPerson('POST', '/account/tokens', { name: 'Проверка учёта работ Telegram', workspaceId: ws.id, access: 'write', expiresInDays: 1, packages: ['quadro.telegram'] });
  const token = created.body.token;
  if (!token) throw new Error('ключ не выдан: ' + JSON.stringify(created.body).slice(0, 200));
  try {
    await mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe-ledger', version: '1' } });
    const list = await mcp(token, 'tools/list', {});
    const names = (list.result?.tools || []).map((t) => t.name);
    log('TOOLS', names.filter((n) => n.startsWith('telegram_')).join(', '));
    for (const n of ['telegram_works', 'telegram_works_note']) if (!names.includes(n)) throw new Error('нет инструмента ' + n);
    const note = await call(token, 'telegram_works_note', {
      items: [
        { chat: 'UGC команда', message: 412, who: 'Иван Петров', what: '3 шапки для UGC', amount: '1 500 ₽', status: 'paid', evidence: [415] },
        { chat: 'UGC команда', message: 430, what: 'аксессуар «крылья»', amount: '400 robux', status: 'unpaid', evidence: [430] },
        { chat: 'UGC команда', message: 431, what: 'вакансия моделлера', status: 'unpaid' },
      ],
    });
    log('NOTE', textOf(note).split('\n').slice(0, 2).join(' | '));
    if (!/записал 3/.test(textOf(note)) || !/#431/.test(textOf(note))) throw new Error('works_note: ' + textOf(note).slice(0, 300));
    const sc = note.result?.structuredContent;
    log('NOTE-DATA', JSON.stringify({ kind: sc?.kind, rows: (sc?.rows || []).map((r) => `${r.message}:${r.status}:${r.by}`), totals: sc?.totals }));
    if (sc?.kind !== 'ledger') throw new Error('works_note без таблицы учёта');
    const works = await call(token, 'telegram_works', {});
    log('WORKS', textOf(works).split('\n').slice(0, 5).join(' | '));
    if (!/Даня — 400 robux/.test(textOf(works))) throw new Error('telegram_works без суммы по людям: ' + textOf(works).slice(0, 300));

    // 3) The person: «Работы».
    await tab('Работы');
    await has('Не оплачено по людям');
    await has('аксессуар «крылья»');
    await shot(`${OUT}/ledger-tab.png`);
    const marked = await inFrame(`(() => { const li = [...document.querySelectorAll('.tg-work')].find((x) => x.innerText.includes('крылья')); const b = li && [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Оплачено'); if (!b) return false; b.click(); return true; })()`);
    if (!marked) throw new Error('нет кнопки «Оплачено» у строки #430');
    // Marked «paid», it leaves «Неоплаченные и неясные»: it is under «Все» (and «Оплаченные»), marked by the person.
    await untilFrame(`[...document.querySelectorAll('.tg-chip')].some((c) => c.textContent.replace(/\\s+/g, ' ').trim() === 'Оплаченные 2')`);
    await inFrame(`[...document.querySelectorAll('.tg-chip')].find((c) => c.textContent.trim().startsWith('Все')).click()`);
    await has('отметили вы');
    const again = await call(token, 'telegram_works_note', { items: [{ chat: 'UGC команда', message: 430, what: 'аксессуар «крылья»', status: 'unpaid', evidence: [430] }] });
    log('NOTE-AGAIN', textOf(again).split('\n').slice(0, 3).join(' | '));
    if (!/человек отметил «оплачено», не меняю/.test(textOf(again))) throw new Error('ИИ переписал отметку человека: ' + textOf(again).slice(0, 300));
    const all = await call(token, 'telegram_works', { status: 'all' });
    if (!/крылья» — 400 robux — оплачено \(отметил человек\)/.test(textOf(all))) throw new Error('telegram_works без отметки человека: ' + textOf(all).slice(0, 400));
    await has('Оплаченные');
    await shot(`${OUT}/ledger-marked.png`);

    // 4) «Что читал ИИ»: the count only.
    await tab('Что читал ИИ');
    await has('Записал в учёт работ');
    const journal = await inFrame(`[...document.querySelectorAll('.tg-read')].map((li) => li.innerText.replace(/\\s+/g, ' ')).join(' | ')`);
    log('JOURNAL', journal.slice(0, 300));
    if (!/строк: 3/.test(journal)) throw new Error('в журнале нет числа строк');
    if (/robux|1 500|Иван|Даня|крылья/.test(journal)) throw new Error('в журнале суммы или имена: ' + journal);
    await shot(`${OUT}/ledger-journal.png`);
  } finally {
    await asPerson('PUT', '/me/packages/quadro.telegram/ai', { on: false });
    if (created.body.apiToken?.id) await asPerson('DELETE', `/account/tokens/${created.body.apiToken.id}`);
  }

  // 5) The screen «Работы и оплата» in Hub: «Учёт работ» — the part's own method, not the AI.
  await js(`(() => { history.pushState({}, '', '/p/quadro.telegram/works'); dispatchEvent(new PopStateEvent('popstate')); return true; })()`);
  selector = '#book';
  await untilFrame(`!!document.getElementById('book') && !document.getElementById('book').hidden`, 30000);
  await click('Учёт работ');
  // All three rows; nothing is unpaid any more (#430 marked «paid» by the person, #431 unknown) — so no unpaid sums block.
  await has('Учёт работ · 3', 30000);
  await has('отметили вы');
  if (await inFrame(`!document.getElementById('totals').hidden`)) throw new Error('суммы неоплаченного при нуле неоплаченных');
  const screen = await inFrame(`document.body.innerText.replace(/\\s+/g, ' ')`);
  log('SCREEN', screen.slice(0, 400));
  await shot(`${OUT}/ledger-screen.png`);
  log('OK', 'учёт работ: ИИ записал выводы (без доказательства — «неизвестно»), человек отметил, ИИ не переписал, журнал без сумм и имён, экран «Работы и оплата» показывает учёт');
};
