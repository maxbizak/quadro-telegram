// «Telegram» with Quadro's keys (the publisher's) and without them, in a copy of Hub through the hidden-window probe:
//   QUADRO_PROBE_LOGIN=test_owner:<password> PROBE_OUT=<folder> electron <Hub>/apps/desktop/scripts/probe.cjs --addr apps.localhost \
//     --port 5291 --path p/quadro.telegram --steps test/probe-quadro-keys.cjs
// 1) no Quadro keys: step 1 «ключи», its help for my.telegram.org («ERROR», «Too many attempts»);
// 2) Quadro keys: no step of keys — straight to the QR; «Войти со своими ключами» opens the own keys and goes back;
//    signed in → «Аккаунт → Дополнительно» says «ключи Quadro».
/* eslint-disable */
const OUT = process.env.PROBE_OUT || '.';

const STAND_IN = (publisher) => `(() => {
  const listeners = new Set();
  const emit = (name, data) => listeners.forEach((fn) => fn({ appId: 'quadro.telegram', name, data }));
  const st = { canSeal: true, configured: ${publisher}, keys: ${publisher ? "'publisher'" : 'null'}, publisherKeys: ${publisher}, apiId: null, signedIn: false, me: null, step: null, allowed: 0 };
  window.__signIn = () => { st.signedIn = true; st.me = { name: 'Тест Владелец', username: 'owner' }; emit('login', { step: 'done' }); };
  window.quadroDesktop = Object.assign(window.quadroDesktop || {}, { parts: {
    has: (appId) => Promise.resolve(appId === 'quadro.telegram'),
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    call: (appId, method, p) => {
      switch (method) {
        case 'status': return Promise.resolve({ ...st });
        case 'qrStart': return Promise.resolve({ step: 'qr', url: 'tg://login?token=AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA', expiresMs: Date.now() + 30000 });
        case 'qrCancel': return Promise.resolve({ ok: true });
        case 'chats': return Promise.resolve([]);
        case 'journal': return Promise.resolve([]);
        default: return Promise.reject(new Error('Нет такого действия: ' + method));
      }
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
  const inFrame = async (expr) => {
    for (const x of win.webContents.mainFrame.framesInSubtree.filter((f) => f !== win.webContents.mainFrame)) {
      try {
        if (await x.executeJavaScript('!!document.querySelector(".tg")')) return x.executeJavaScript(expr);
      } catch {}
    }
    return null;
  };
  const has = async (text, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await inFrame(`document.body.innerText.includes(${JSON.stringify(text)})`).catch(() => false)) return true;
      if (Date.now() > end) throw new Error('не дождался «' + text + '» — на экране: ' + String(await inFrame('document.body.innerText')).slice(0, 300));
      await wait(200);
    }
  };
  const lacks = async (text) => {
    if (await inFrame(`document.body.innerText.includes(${JSON.stringify(text)})`)) throw new Error('лишнее на экране: ' + text);
  };
  const click = async (text) => {
    if (!(await inFrame(`(() => { const b = [...document.querySelectorAll('button, summary')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`))) throw new Error('нет кнопки «' + text + '»');
  };
  const remount = async (publisher) => {
    await js(STAND_IN(publisher));
    await js(`(() => { const p = location.pathname; history.pushState({}, '', '/'); dispatchEvent(new PopStateEvent('popstate')); setTimeout(() => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')); }, 400); return true; })()`);
    await wait(1500);
  };
  await until('!!document.querySelector("iframe")', 30000);

  // 1) No Quadro keys: step 1 and its help.
  await remount(false);
  await has('Шаг 1. Ключи приложения Telegram');
  await click('Не получается на my.telegram.org');
  await has('Выключите VPN и прокси');
  await has('URL и Description оставьте пустыми');
  await shot(`${OUT}/tg-keys-help.png`);

  // 2) Quadro keys: straight to the QR.
  await remount(true);
  await has('Вход в Telegram');
  await lacks('Шаг ');
  await has('Войти со своими ключами api_id и api_hash');
  await click('Войти со своими ключами');
  await has('Свои ключи Telegram');
  await has('нужны, только если ключи Quadro не подходят');
  await click('Отмена');
  await has('Вход в Telegram');
  await shot(`${OUT}/tg-quadro-keys-login.png`);
  await js('window.__signIn()');
  await has('Подключён: Тест Владелец');
  await click('Аккаунт');
  await click('Дополнительно');
  await has('Ключи приложения Telegram: ключи Quadro');
  await has('Войти со своими ключами');
  await shot(`${OUT}/tg-quadro-keys-account.png`);
  log('OK', 'оба случая ключей пройдены');
};
