// The AI's whole path to «Telegram», in a copy of Hub, with no window and no real Telegram:
//   the program's own bridges (--bridges --apps), the author mode (the part straight from dist/, unsigned) and the AI's bridge
//   «Hub → this PC» (QUADRO_PROBE_RELAY=1). The screen sets keys through the real part (sealed by Windows); then, as the person,
//   «ИИ может пользоваться» and a key given this package; then, as the AI, MCP tools/list and tools/call telegram_* over that key —
//   Hub relays them to the part on this PC, the screen's journal shows each read as it happens.
//
//   QUADRO_PROBE_LOGIN=test_owner:<password> QUADRO_DEV_PACKAGES=<this folder>\dist QUADRO_PROBE_RELAY=1 PROBE_OUT=<folder> \
//   PROBE_API=http://127.0.0.1:8891 electron <Hub>/apps/desktop/scripts/probe.cjs --addr apps.localhost --port 5291 \
//     --path p/quadro.telegram --bridges --apps <empty folder> --steps test/probe-relay.cjs
/* eslint-disable */
const OUT = process.env.PROBE_OUT || '.';
const API = process.env.PROBE_API || 'http://127.0.0.1:8891';

module.exports = async (probe) => {
  const { win, js, wait, until, log } = probe;
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
      if (Date.now() > end) throw new Error('не дождался в кадре: ' + expr + ' — на экране: ' + String(await inFrame('document.body.innerText').catch(() => '')).slice(0, 300));
      await wait(250);
    }
  };
  const has = (text, ms) => untilFrame(`document.body.innerText.includes(${JSON.stringify(text)})`, ms);
  const click = async (text) => {
    if (!(await inFrame(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`))) throw new Error('нет кнопки «' + text + '»');
  };
  const type = (selector, value) =>
    inFrame(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  /** As the person, from the page (its session and CSRF). */
  const asPerson = (method, path, body) =>
    js(`(async () => { const csrf = decodeURIComponent((document.cookie.match(/qh_csrf=([^;]+)/) || [])[1] || ''); const r = await fetch('/api${path}', { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ''} credentials: 'include' }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null }; })()`);
  let rpcId = 0;
  /** As the AI: MCP over the key. */
  let session = null; // Mcp-Session-Id of a client that shows tool screens (MCP Apps)
  const mcp = async (token, method, params) => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) };
    const r = await fetch(`${API}/api/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    const t = await r.text();
    if (!r.ok) throw new Error(`MCP ${method}: ${r.status} ${t.slice(0, 300)}`);
    if (method === 'initialize') session = r.headers.get('mcp-session-id') || session;
    return JSON.parse(t);
  };

  // 1) The real part, from the author's folder: nothing kept yet. With Windows' sealing (host.secrets) the keys are set through
  //    the screen; without it (a program, or this probe, that does not give it) the screen asks to update and keeps nothing.
  await untilFrame(`/Шаг 1\. Ключи приложения Telegram|Обновите программу Quadro Hub/.test(document.body.innerText)`, 60000);
  await inFrame(`(() => { const st = document.createElement('style'); st.textContent = '*,*::after{transition:none!important}'; document.head.append(st); return true; })()`);
  if (await inFrame(`document.body.innerText.includes('Шаг 1. Ключи')`)) {
    await type('input[inputmode="numeric"]', '1234567');
    await type('input[type="password"]', '0123456789abcdef0123456789abcdef');
    await click('Сохранить ключи');
    await has('Шаг 2. Вход в Telegram');
    log('SCREEN', 'ключи запечатаны частью, шаг входа');
  } else log('SCREEN', 'нет host.secrets — экран просит обновить программу, ничего не хранит');
  await shot(`${OUT}/relay-start.png`);

  // 2) As the person: «ИИ может пользоваться „Telegram“» and a key given this package.
  const ai = await asPerson('PUT', '/me/packages/quadro.telegram/ai', { on: true });
  log('AI-SWITCH', ai.status, JSON.stringify(ai.body).slice(0, 300));
  const zones = await asPerson('GET', '/workspaces');
  const ws = (zones.body.workspaces || zones.body)[0];
  const created = await asPerson('POST', '/account/tokens', { name: 'Проверка Telegram для ИИ', workspaceId: ws.id, access: 'read', expiresInDays: 30, packages: ['quadro.telegram'] });
  log('TOKEN', created.status, JSON.stringify(created.body.apiToken ? { packages: created.body.apiToken.packages, until: created.body.apiToken.packagesUntil } : created.body).slice(0, 300));
  const token = created.body.token;

  // 3) As the AI: the tools, then the calls — Hub relays them to the part on this PC.
  await mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } });
  const list = await mcp(token, 'tools/list', {});
  const names = list.result.tools.map((t) => t.name).filter((n) => n.startsWith('telegram_'));
  log('TOOLS', JSON.stringify(names));
  if (names.join() !== 'telegram_chats,telegram_messages,telegram_search,telegram_file') throw new Error('нет инструментов telegram_*');
  const chats = await mcp(token, 'tools/call', { name: 'telegram_chats', arguments: {} });
  log('CALL chats', JSON.stringify(chats.result).slice(0, 400));
  const denied = await mcp(token, 'tools/call', { name: 'telegram_messages', arguments: { chat: 'Мама' } });
  log('CALL messages(Мама)', JSON.stringify(denied.result ?? denied.error).slice(0, 400));
  const notSigned = await mcp(token, 'tools/call', { name: 'telegram_search', arguments: { query: 'оплата' } });
  log('CALL search', JSON.stringify(notSigned.result ?? notSigned.error).slice(0, 400));

  // 3б) An AI's chat that shows tool screens (MCP Apps, kernel §12е): telegram_search carries its screen «Работы и оплата»
  //     (ui://…), the screen is one HTML with Hub's bridge put in, the package's mcp.instructions come with initialize.
  const init = await mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }, clientInfo: { name: 'probe-ui', version: '1' } });
  const said = String(init.result?.instructions || '');
  log('UI-INIT', session ? 'Mcp-Session-Id есть' : 'без Mcp-Session-Id', JSON.stringify(said.slice(said.indexOf('Telegram'), said.indexOf('Telegram') + 120)));
  if (!said.includes('Работы и оплата')) throw new Error('в instructions нет строки пакета Telegram');
  const uiList = await mcp(token, 'tools/list', {});
  const search = uiList.result.tools.find((t) => t.name === 'telegram_search');
  const uri = search?._meta?.ui?.resourceUri;
  log('UI-TOOL', JSON.stringify(search?._meta));
  if (!uri || !/^ui:\/\//.test(uri)) throw new Error('у telegram_search нет экрана');
  if (uiList.result.tools.find((t) => t.name === 'telegram_messages')?._meta?.ui) throw new Error('экран у инструмента, которому его не давали');
  const page = await mcp(token, 'resources/read', { uri });
  const content = page.result?.contents?.[0] || {};
  log('UI-PAGE', content.uri, content.mimeType, String(content.text || '').length, 'знаков');
  if (content.mimeType !== 'text/html;profile=mcp-app') throw new Error('экран не text/html;profile=mcp-app: ' + JSON.stringify(page).slice(0, 300));
  for (const need of ['window.__quadroMcp', '"toolPrefix":"telegram_"', 'Работы и оплата', 'quadro.tools'])
    if (!String(content.text).includes(need)) throw new Error('в странице экрана нет ' + need);
  // Tags only (the bridge Hub put in mentions «<script src=…quadro.js>» in its own comment): no script is loaded by address.
  const tags = String(content.text).replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1</script>').match(/<script\b[^>]*>/gi) || [];
  if (tags.some((t) => /\bsrc\s*=/i.test(t))) throw new Error('в странице экрана остался script src: ' + tags.join(' '));
  const resources = await mcp(token, 'resources/list', {});
  log('UI-RESOURCES', JSON.stringify((resources.result?.resources || []).filter((r) => r.uri === uri).map((r) => r.name)));
  session = null;

  // 4) The person's screen: «Что читал ИИ» — the reads arrived by themselves. (Signed out: the journal is on the «Аккаунт»-less
  //    login step, so it is read straight from the part.)
  const journal = await js(`window.quadroDesktop.parts.call('quadro.telegram', 'journal', {})`);
  log('JOURNAL', JSON.stringify(journal));
  await shot(`${OUT}/relay-screen.png`);

  // 5) The switch off: the AI loses the tools at once.
  await asPerson('PUT', '/me/packages/quadro.telegram/ai', { on: false });
  const after = await mcp(token, 'tools/list', {});
  log('TOOLS after off', JSON.stringify(after.result.tools.map((t) => t.name).filter((n) => n.startsWith('telegram_'))));
  // The key goes away again.
  if (created.body.apiToken?.id) await asPerson('DELETE', `/account/tokens/${created.body.apiToken.id}`);
};
