// The screen «Работы и оплата» (views.works, surface «mcp-app») inside Hub — the same HTML file as in the AI's chat — through
// Hub's hidden-window probe (no window on the screen, no real input):
//   QUADRO_PROBE_LOGIN=test_owner:<password> PROBE_OUT=<folder> PROBE_DATA=<worksData JSON> electron <Hub>/apps/desktop/scripts/probe.cjs \
//     --addr apps.localhost --port 5291 --path p/quadro.telegram/works --steps test/probe-works.cjs
//   (the copy started with HUB_DEV_PACKAGES=<a folder holding this package's dist>; PROBE_DATA — data of the real worksData)
// 1) a browser: the screen says the search works in the program;
// 2) a stand-in of the program's bridge to the part (made-up chats, never a real Telegram): quadro.tools.call('search') reaches
//    the part's method «search» (the person's search), the table is drawn, the chats' list comes from «access»; Hub runs the
//    page's own inline script (its sha256 in the frame's CSP). «Открыть в Telegram» is not pressed here: in the program it opens
//    the system's browser.
/* eslint-disable */
const { readFileSync } = require('node:fs');

const OUT = process.env.PROBE_OUT || '.';
const DATA = JSON.parse(readFileSync(process.env.PROBE_DATA, 'utf8'));

const STAND_IN = `(() => {
  const data = ${JSON.stringify(DATA)};
  window.__pcCalls = [];
  window.quadroDesktop = Object.assign(window.quadroDesktop || {}, { parts: {
    has: (appId) => Promise.resolve(appId === 'quadro.telegram'),
    onEvent: () => () => {},
    call: (appId, method, p) => {
      window.__pcCalls.push([method, p]);
      if (appId !== 'quadro.telegram') return Promise.reject(new Error('Нет части'));
      if (method === 'access') return Promise.resolve([{ id: '-1001987654321', kind: 'group', title: 'UGC команда' }, { id: '555', kind: 'user', title: 'Иван Петров', username: 'ivan_ugc' }]);
      if (method === 'search') return Promise.resolve({ text: 'Поиск «' + p.query + '»: ' + data.count + ' сообщ.', data: { ...data, query: p.query } });
      return Promise.reject(new Error('Нет такого действия: ' + method));
    },
  } });
  return true;
})()`;

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
  const frameOf = async () => {
    for (const x of win.webContents.mainFrame.framesInSubtree.filter((f) => f !== win.webContents.mainFrame)) {
      try {
        if (await x.executeJavaScript('!!document.getElementById("find")')) return x;
      } catch {}
    }
    return null;
  };
  const inFrame = async (expr) => {
    const f = await frameOf();
    return f ? f.executeJavaScript(expr) : null;
  };
  const untilFrame = async (expr, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await inFrame(expr).catch(() => null);
      if (v) return v;
      if (Date.now() > end) throw new Error('не дождался в кадре: ' + expr + ' — на экране: ' + String(await inFrame('document.body.innerText').catch(() => '')).slice(0, 300));
      await wait(200);
    }
  };
  const has = (text) => untilFrame(`document.body.innerText.includes(${JSON.stringify(text)})`);

  // 1) A browser: no program.
  await until('!!document.querySelector("iframe")', 30000);
  await has('работает в программе Quadro Hub');
  await shot(`${OUT}/works-browser.png`);

  // 2) The program's bridge (a stand-in) — the screen mounted again.
  await js(STAND_IN);
  await js(`(() => { const p = location.pathname; history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate')); setTimeout(() => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')); }, 400); return true; })()`);
  await wait(1500);
  await untilFrame(`!!document.getElementById('find') && !document.body.innerText.includes('работает в программе')`);
  await inFrame(`(() => { document.getElementById('q').value = 'оплат'; document.getElementById('find').requestSubmit(); return true; })()`);
  await has('Не оплачено');
  await has('Иван Петров');
  const calls = await js('JSON.stringify(window.__pcCalls)');
  log('PC-CALLS', calls);
  if (!/\["search",\{"query":"оплат"\}\]/.test(calls)) throw new Error('поиск не дошёл до части методом search: ' + calls);
  const rows = await inFrame(`document.querySelectorAll('.row:not(.th)').length`);
  const ask = await inFrame(`document.getElementById('ask').hidden`);
  log('ROWS', rows, 'ASK-HIDDEN', ask);
  if (!rows) throw new Error('таблица пустая');
  if (ask !== true) throw new Error('«Попросить ИИ» видно в Hub — там его нет');
  await shot(`${OUT}/works-hub.png`);

  // The chats' list: the part's «access» (the allowed chats), asked when the list is opened.
  await inFrame(`document.getElementById('chat').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await untilFrame(`document.getElementById('chat').options.length > 1`);
  const options = await inFrame(`[...document.getElementById('chat').options].map((o) => o.textContent).join(' | ')`);
  log('CHATS', options);
  // A search in one chat.
  await inFrame(`(() => { document.getElementById('chat').value = '555'; document.querySelector('.words .chip:nth-child(2)').click(); return true; })()`);
  await wait(800);
  const last = await js('JSON.stringify(window.__pcCalls.at(-1))');
  log('LAST-CALL', last);
  if (!/"chat":"555"/.test(last) || !/"query":"скинул"/.test(last)) throw new Error('поиск в одном чате ушёл не так: ' + last);
  log('OK', 'экран инструмента в Hub: поиск через часть, таблица, список чатов');
};
