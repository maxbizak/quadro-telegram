// The screen of «Telegram» in a copy of Hub, through Hub's hidden-window probe (no window on the screen, no real input):
//   QUADRO_PROBE_LOGIN=test_owner:<password> PROBE_OUT=<folder> electron <Hub>/apps/desktop/scripts/probe.cjs --addr apps.localhost \
//     --port 5291 --path p/quadro.telegram --steps test/probe-telegram.cjs   (the copy started with HUB_DEV_PACKAGES=<this folder>)
// 1) in a browser (no program): the screen says it works in the program;
// 2) with a stand-in of the program's bridge to the part (made-up account, never a real Telegram): keys → phone → code → cloud
//    password → «Доступ для ИИ» (allow two chats) → «Что читал ИИ» (a read arrives live) → «Аккаунт» → «Выйти».
/* eslint-disable */
const OUT = process.env.PROBE_OUT || '.';

const STAND_IN = `(() => {
  const listeners = new Set();
  const emit = (name, data) => listeners.forEach((fn) => fn({ appId: 'quadro.telegram', name, data }));
  const st = { canSeal: true, configured: false, apiId: null, signedIn: false, me: null, step: null, allowed: 0 };
  const chats = [
    { id: '-1001234', kind: 'group', title: 'UGC работа', unread: 3, lastAt: '2026-11-19T18:20:00Z', allowed: false },
    { id: '555', kind: 'user', title: 'Иван Петров', username: 'ivan_p', lastAt: '2026-11-19T15:02:00Z', allowed: false },
    { id: '556', kind: 'user', title: 'Анна (заказчик)', username: 'anna_ugc', lastAt: '2026-11-18T09:40:00Z', allowed: false },
    { id: '-1009', kind: 'channel', title: 'Roblox UGC новости', username: 'ugcnews', lastAt: '2026-11-17T12:00:00Z', allowed: false },
    { id: '777', kind: 'user', title: 'Мама', lastAt: '2026-11-19T20:11:00Z', allowed: false },
    { id: '42', kind: 'bot', title: 'BotFather', username: 'BotFather', lastAt: '2026-10-02T10:00:00Z', allowed: false },
  ];
  let journal = [];
  window.__pcCalls = [];
  window.__emitRead = (entry) => { journal = [entry, ...journal]; emit('read', entry); };
  window.quadroDesktop = Object.assign(window.quadroDesktop || {}, { parts: {
    has: (appId) => Promise.resolve(appId === 'quadro.telegram'),
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    call: (appId, method, p) => {
      window.__pcCalls.push(method + (p && p.password ? ' (пароль)' : p && p.code ? ' (код)' : ''));
      if (appId !== 'quadro.telegram') return Promise.reject(new Error('Нет части'));
      switch (method) {
        case 'status': return Promise.resolve({ ...st, allowed: chats.filter((c) => c.allowed).length });
        case 'setKeys': if (!/^[0-9a-f]{32}$/.test(p.apiHash)) return Promise.reject(new Error('api_hash — 32 знака (цифры и буквы a–f) с my.telegram.org')); st.configured = true; st.apiId = Number(p.apiId); return Promise.resolve({ ok: true });
        case 'sendCode': return Promise.resolve({ step: 'code', viaApp: true });
        case 'signIn': return p.code === '12345' ? Promise.resolve({ step: 'password', hint: 'кот' }) : Promise.reject(new Error('Неверный код'));
        case 'password': if (p.password !== 'secret') return Promise.reject(new Error('Неверный облачный пароль')); st.signedIn = true; st.me = { name: 'Тест Владелец', username: 'owner' }; return Promise.resolve({ step: 'done' });
        case 'chats': return Promise.resolve(chats.map((c) => ({ ...c })));
        case 'setAccess': { const c = chats.find((x) => x.id === p.id); c.allowed = p.allowed; return Promise.resolve({ allowed: chats.filter((x) => x.allowed) }); }
        case 'journal': return Promise.resolve(journal.slice());
        case 'clearJournal': journal = []; return Promise.resolve({ ok: true });
        case 'logout': st.signedIn = false; st.me = null; if (p.keys) { st.configured = false; st.apiId = null; } return Promise.resolve({ ok: true });
        default: return Promise.reject(new Error('Нет такого действия: ' + method));
      }
    },
  } });
  return true;
})()`;

module.exports = async (probe) => {
  const { win, js, wait, until, log } = probe;
  // The package's frame paints a beat later in a hidden window: give it time before a picture.
  // A hidden window repaints the package's frame (another origin, its own process) only when the window itself changes: a
  // one-pixel resize there and back before each picture.
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
        if (await x.executeJavaScript('!!document.querySelector(".tg")')) return x;
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
  const click = async (text) => {
    const ok = await inFrame(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`);
    if (!ok) throw new Error('нет кнопки «' + text + '»');
  };
  // React's inputs: the native setter, then an «input» event.
  const type = (selector, value) =>
    inFrame(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

  // 1) A browser: no program.
  await until('!!document.querySelector("iframe")', 30000);
  await has('в программе Quadro Hub на ПК');
  await shot(`${OUT}/tg-browser.png`);

  // 2) The program's bridge (stand-in); the frame made anew.
  await js(STAND_IN);
  await js(`(() => { const p = location.pathname; history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate')); setTimeout(() => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')); }, 400); return true; })()`);
  await wait(1500);
  await has('Шаг 1. Ключи приложения Telegram');
  // No animations in the pictures (a hidden window plays them a frame at a time).
  await inFrame(`(() => { const st = document.createElement('style'); st.textContent = '*,*::after{transition:none!important}'; document.head.append(st); return true; })()`);
  await shot(`${OUT}/tg-keys.png`);
  await type('input[inputmode="numeric"]', '1234567');
  await type('input[type="password"]', 'not-a-hash');
  await click('Сохранить ключи');
  await has('api_hash — 32 знака');
  await type('input[type="password"]', '0123456789abcdef0123456789abcdef');
  await click('Сохранить ключи');
  await has('Шаг 2. Вход в Telegram');
  await type('input[type="tel"]', '+79990000000');
  await click('Получить код');
  await has('Код пришёл в Telegram');
  await type('input[autocomplete="one-time-code"]', '11111');
  await click('Войти');
  await has('Неверный код');
  await shot(`${OUT}/tg-code.png`);
  await type('input[autocomplete="one-time-code"]', '12345');
  await click('Войти');
  await has('Подсказка: «кот»');
  await type('input[autocomplete="current-password"]', 'secret');
  await shot(`${OUT}/tg-password.png`);
  await click('Войти');
  await has('Подключён: Тест Владелец');
  await has('UGC работа');

  // «Доступ для ИИ»: allow the work group and Ivan.
  await inFrame(`[...document.querySelectorAll('input[role="switch"]')].filter((x) => /UGC работа|Иван/.test(x.getAttribute('aria-label'))).forEach((x) => x.click()) || true`);
  await has('Разрешено ИИ: 2');
  log('SWITCHES', JSON.stringify(await inFrame(`[...document.querySelectorAll('input[role="switch"]')].map((x) => [x.getAttribute('aria-label').slice(0, 30), x.checked, getComputedStyle(x.nextElementSibling).backgroundColor])`)));
  await shot(`${OUT}/tg-access.png`);
  await inFrame(`(() => { const s = document.querySelector('select[aria-label="Какие чаты"]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'allowed'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await untilFrame(`document.querySelectorAll('.tg-chat').length === 2`);

  // «Что читал ИИ»: empty, then a read arrives live.
  await click('Что читал ИИ');
  await has('ИИ ещё ничего не читал');
  await js(`window.__emitRead({ at: '2026-11-19T21:05:00Z', tool: 'messages', chats: ['UGC работа'], messages: 120, files: 0, bytes: 48000 })`);
  await js(`window.__emitRead({ at: '2026-11-19T21:06:00Z', tool: 'search', chats: ['UGC работа', 'Иван Петров'], messages: 7, files: 0, bytes: 3100, query: 'оплата' })`);
  await js(`window.__emitRead({ at: '2026-11-19T21:07:00Z', tool: 'messages', chats: [], messages: 0, files: 0, bytes: 0, error: 'Этот чат ИИ не разрешён (или его нет)' })`);
  await has('Искал «оплата»');
  await shot(`${OUT}/tg-journal.png`);

  // «Аккаунт»: the example for the AI, «Выйти» with its confirmation.
  await click('Аккаунт');
  await has('telegram_messages');
  await click('Выйти из Telegram');
  await has('исчезнет из «Устройств»');
  await shot(`${OUT}/tg-account.png`);
  await click('Выйти');
  await has('Шаг 2. Вход в Telegram');
  log('CALLS', JSON.stringify(await js('window.__pcCalls')));
};
