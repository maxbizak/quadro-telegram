// «Выгрузка из Telegram Desktop» end to end, in a copy of Hub, with no keys, no sign-in and no Telegram, hidden window only:
//   the real part from dist/ (the author mode) with the program's own bridges and the AI's bridge «Hub → this PC».
//   1) the screen with no keys offers the export; «Выбрать папку выгрузки» — the program's Windows window (its stand-in gives
//      QUADRO_PROBE_FILES: a folder ChatExport_2026-11-20 with test/fixtures/result-chat.json and the picture of #412), the grant
//      «to read»; the part reads result.json itself through the program, the screen follows the bar;
//   2) «Без входа — по выгрузке…», the chat in «Доступ для ИИ» closed until the person allows it;
//   3) as the AI (MCP over a key given this package): telegram_chats / telegram_search / telegram_messages read the export, marked
//      «по выгрузке от …», the search's table data carries exportedAt; telegram_file shows the picture of #412 read in the
//      export's folder; «Что читал ИИ» shows the reads;
//   4) «Выгрузка»: the chat «с картинками»; «Убрать все выгрузки» — the AI loses the chat at once.
//
//   QUADRO_PROBE_LOGIN=test_owner:<password> QUADRO_DEV_PACKAGES=<this folder>\dist QUADRO_PROBE_RELAY=1 PROBE_OUT=<folder> \
//   QUADRO_PROBE_FILES=<…>\ChatExport_2026-11-20 (made by this probe if missing: PROBE_EXPORT_DIR) \
//   PROBE_API=http://127.0.0.1:8891 electron <Hub>/apps/desktop/scripts/probe.cjs --addr apps.localhost --port 5291 \
//     --path p/quadro.telegram --bridges --apps <empty folder> --steps test/probe-export.cjs
/* eslint-disable */
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const OUT = process.env.PROBE_OUT || '.';
const API = process.env.PROBE_API || 'http://127.0.0.1:8891';
/** The folder Windows' window «gives» (the program's stand-in reads QUADRO_PROBE_FILES). */
const EXPORT_DIR = (process.env.QUADRO_PROBE_FILES || '').split(';')[0];

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
  const frame = async () => {
    for (const x of win.webContents.mainFrame.framesInSubtree.filter((f) => f !== win.webContents.mainFrame)) {
      try {
        if (await x.executeJavaScript('!!document.querySelector(".tg")')) return x;
      } catch {}
    }
    return null;
  };
  const inFrame = async (expr) => (await frame())?.executeJavaScript(expr) ?? null;
  const untilFrame = async (expr, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await inFrame(expr).catch(() => null);
      if (v) return v;
      if (Date.now() > end) throw new Error('не дождался в кадре: ' + expr + ' — на экране: ' + String(await inFrame('document.body.innerText').catch(() => '')).slice(0, 400));
      await wait(250);
    }
  };
  const has = (text, ms) => untilFrame(`document.body.innerText.includes(${JSON.stringify(text)})`, ms);
  const click = async (text) => {
    if (!(await inFrame(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`))) throw new Error('нет кнопки «' + text + '»');
  };
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

  // 1) No keys: the offer of an export next to the keys' step.
  await has('Нет ключей или не получается войти?', 60000);
  await inFrame(`(() => { const st = document.createElement('style'); st.textContent = '*,*::after{transition:none!important}'; document.head.append(st); return true; })()`);
  await shot(`${OUT}/export-offer.png`);
  if (!EXPORT_DIR || !existsSync(join(EXPORT_DIR, 'result.json'))) throw new Error('QUADRO_PROBE_FILES — папка выгрузки с result.json');
  await click('Загрузить выгрузку');
  await has('Выгрузка из Telegram Desktop');
  // This program reads picked files: the folder's button, not the file field of an older one.
  await has('Выбрать папку выгрузки');
  await shot(`${OUT}/export-loader.png`);
  // Windows' window (the program's stand-in) gives the export's folder «to read»; the part reads it through the program.
  await click('Выбрать папку выгрузки');

  // 2) The chats of the export, closed for the AI until allowed.
  await has('Без входа — по выгрузке из Telegram Desktop', 30000);
  await has('UGC команда');
  const line = await inFrame(`[...document.querySelectorAll('.tg-chat')].map((li) => li.innerText.replace(/\\s+/g, ' ')).join(' | ')`);
  log('ACCESS', line);
  if (!/выгрузка от/.test(line) || !/Закрыт/.test(line)) throw new Error('чат выгрузки без пометки или уже открыт: ' + line);
  await inFrame(`document.querySelector('input[role="switch"][aria-label="ИИ может читать «UGC команда»"]').click()`);
  await has('ИИ читает');
  await shot(`${OUT}/export-access.png`);

  // 3) As the AI.
  const ai = await asPerson('PUT', '/me/packages/quadro.telegram/ai', { on: true });
  log('AI-SWITCH', ai.status);
  const zones = await asPerson('GET', '/workspaces');
  const ws = (zones.body.workspaces || zones.body)[0];
  const created = await asPerson('POST', '/account/tokens', { name: 'Проверка выгрузки Telegram', workspaceId: ws.id, access: 'read', expiresInDays: 1, packages: ['quadro.telegram'] });
  const token = created.body.token;
  if (!token) throw new Error('ключ не выдан: ' + JSON.stringify(created.body).slice(0, 200));
  await mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe-export', version: '1' } });
  const chats = await mcp(token, 'tools/call', { name: 'telegram_chats', arguments: {} });
  log('CHATS', textOf(chats));
  if (!/UGC команда — группа, chat=-1001987654321 \(по выгрузке от \d\d\.\d\d\.\d{4}/.test(textOf(chats))) throw new Error('telegram_chats без пометки выгрузки');
  const found = await mcp(token, 'tools/call', { name: 'telegram_search', arguments: { query: 'оплат' } });
  const items = found.result?.structuredContent?.items || [];
  log('SEARCH', textOf(found).split('\n').slice(0, 4).join(' / '));
  log('SEARCH-ITEMS', JSON.stringify(items.map((w) => [w.id, w.amount, w.paid, !!w.exportedAt, w.link])));
  if (!items.length || !items.every((w) => w.exportedAt)) throw new Error('у строк таблицы нет exportedAt');
  if (!items.some((w) => w.id === 412 && w.paid === 'yes' && w.paidBy === 415)) throw new Error('работа #412 не отмечена оплаченной ответом #415');
  const read = await mcp(token, 'tools/call', { name: 'telegram_messages', arguments: { chat: 'UGC команда' } });
  log('MESSAGES', textOf(read).split('\n')[0]);
  if (!/по выгрузке от/.test(textOf(read)) || !/6 сообщ/.test(textOf(read))) throw new Error('telegram_messages не по выгрузке');
  // The picture of #412, read by the part in the export's folder (where it lies), through the program and Hub to the AI.
  const pic = await mcp(token, 'tools/call', { name: 'telegram_file', arguments: { chat: 'UGC команда', message: 412 } });
  const images = (pic.result?.content || []).filter((c) => c.type === 'image');
  log('FILE', textOf(pic).split('\n')[0], images.map((i) => `${i.mimeType} ${i.data.length}`).join(', '));
  if (pic.result?.isError || images.length !== 1 || !/по выгрузке от/.test(textOf(pic))) throw new Error('telegram_file без картинки из папки выгрузки: ' + JSON.stringify(pic).slice(0, 300));
  await shot(`${OUT}/export-after-ai.png`);

  // «Что читал ИИ» — the reads came by themselves.
  await inFrame(`[...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim() === 'Что читал ИИ').click()`);
  await has('Искал «оплат»');
  await shot(`${OUT}/export-journal.png`);

  // 4) «Выгрузка» → «Убрать все выгрузки»: the AI loses the chat.
  await inFrame(`[...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim() === 'Выгрузка').click()`);
  await has('Загруженные чаты');
  await has('с картинками');
  await shot(`${OUT}/export-tab.png`);
  await click('Убрать все выгрузки');
  await has('Нет ключей или не получается войти?', 30000);
  const after = await mcp(token, 'tools/call', { name: 'telegram_chats', arguments: {} });
  log('CHATS-AFTER', textOf(after));
  if (/UGC команда/.test(textOf(after))) throw new Error('ИИ всё ещё видит чат выгрузки');

  await asPerson('PUT', '/me/packages/quadro.telegram/ai', { on: false });
  if (created.body.apiToken?.id) await asPerson('DELETE', `/account/tokens/${created.body.apiToken.id}`);
  log('OK', 'выгрузка без ключей: папка выбрана в окне Windows и прочитана частью, доступ, инструменты ИИ с пометкой, картинка из папки, журнал, удаление');
};
