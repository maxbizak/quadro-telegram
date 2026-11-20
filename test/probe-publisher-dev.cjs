// «Telegram» with the publisher's values in the author mode — the real part, no stand-in, no account, no sign-in:
//   dist/publisher.dev.json { "api_id": "<made up>", "api_hash": "<made up>" } (never packed: npm run check:dist refuses it),
//   QUADRO_PROBE_LOGIN=test_owner:<password> QUADRO_DEV_PACKAGES=<this folder>\dist PROBE_OUT=<folder> \
//   electron <Hub>/apps/desktop/scripts/probe.cjs --addr apps.localhost --port 5291 --path p/quadro.telegram --bridges \
//     --apps <empty folder> --steps test/probe-publisher-dev.cjs          (the copy started with HUB_DEV_PACKAGES=<this folder>)
// The program reads publisher.dev.json and gives it to the part in its hello (host.app.config.publisher): the screen has no step
// of keys — straight to the QR; the part asks Telegram for a QR code with the made-up api_id and Telegram refuses it
// (API_ID_INVALID) — the screen says Quadro's keys did not fit and offers the own ones. It never shows the publisher's api_id.
/* eslint-disable */
const OUT = process.env.PROBE_OUT || '.';
const FAKE_ID = process.env.PROBE_FAKE_API_ID || '1234567';

module.exports = async (probe) => {
  const { win, wait, until, log } = probe;
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
  const text = async () => String((await inFrame('document.body.innerText')) || '');
  const has = async (needle, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      if ((await text()).includes(needle)) return true;
      if (Date.now() > end) throw new Error('не дождался «' + needle + '» — на экране: ' + (await text()).slice(0, 400));
      await wait(300);
    }
  };
  await until('!!document.querySelector("iframe")', 30000);

  await has('Вход в Telegram', 60000);
  if ((await text()).includes('Шаг ')) throw new Error('экран спросил ключи, хотя значения издателя есть');
  await has('Войти со своими ключами api_id и api_hash');
  await shot(`${OUT}/tg-publisher-dev-login.png`);

  // The QR code is asked of Telegram with the made-up keys: Telegram refuses them — the keys did reach the part.
  const end = Date.now() + 90000;
  let last = '';
  while (Date.now() < end) {
    last = await text();
    if (/не подошли|api_id или api_hash|Нет связи|не ответил|заблокированы/.test(last)) break;
    await wait(1000);
  }
  log('QR-SCREEN', JSON.stringify(last.slice(0, 600)));
  if (last.includes(FAKE_ID)) throw new Error('экран показал api_id издателя');
  if (!/Ключи Quadro не подошли Telegram/.test(last)) throw new Error('Telegram не отказал выдуманным ключам — на экране: ' + last.slice(0, 300));
  await shot(`${OUT}/tg-publisher-dev-refused.png`);
  log('OK', 'значения издателя дошли до части; экран без шага ключей; api_id издателя на экране нет');
};
