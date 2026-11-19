# Telegram — пакет Quadro Hub (`quadro.telegram`)

ИИ владельца, подключённый к MCP Hub, читает выбранные им чаты Telegram — с файлами, картинками и ссылками. Только чтение.
Сделан путём стороннего автора: свой проект вне ядра Hub, публичный SDK, подписанный пакет, Каталог.

## Как устроено

- **Часть на ПК** (`pc/`, Node, `@quadrohub/pc-sdk`): клиент MTProto — GramJS (npm `telegram`, MIT), вшит esbuild в
  `dist/pc/part.cjs`. Вход от аккаунта владельца, как обычный клиент («Quadro Hub» в «Настройки → Устройства»).
  - Сеть — только через программу: `host.net.websocket` к `wss://*.web.telegram.org/apiws` (адреса Telegram Web), право
    `net:*.web.telegram.org`. Свои `net`/`tls`/`websocket` у части закрыты, в сборке это заглушки (`scripts/build-pc.mjs`).
  - Сессия, api_id и api_hash — в папке данных части, запечатаны Windows (`host.secrets`, DPAPI). На сервер Hub переписка
    не уходит и там не хранится. Программа без `host.secrets` — ничего не сохраняется, экран просит обновить программу.
  - Пределы: страница до 300 сообщений (по умолчанию 100), текст сообщения до 4000 знаков, ответ до ~300 КБ текста,
    поиск до 200, картинка до 8 МБ, текстовый файл до 2 МБ, файл на ПК до 50 МБ; каждый вызов Telegram — до 45 с.
- **Экран** (`src/`, React по шаблону qhapp-react, мост `quadro.js`): ключи с my.telegram.org по шагам → вход (телефон, код,
  облачный пароль — вводит сам владелец) → «Доступ для ИИ» (по умолчанию ни один чат) → «Что читал ИИ» (журнал, без
  содержимого) → «Аккаунт» («Выйти из Telegram» — закрывает сессию в Telegram и удаляет с ПК).
- **Инструменты ИИ** (`manifest.json` → `mcp.tools`, handler `pc:<имя>`, право `pc.mcp`; Hub добавляет приставку `telegram_`):
  `telegram_chats`, `telegram_messages` (период, страницы, `cursor`), `telegram_search`, `telegram_file` (картинка — как
  изображение, текст и .docx — текстом, остальное — превью и путь на ПК). Только разрешённые чаты; методы экрана ИИ не
  достаются, а инструменты ИИ — экрану (`host.rpc.handle` и `host.mcp.handle` разные).

## Собрать и проверить

```bash
npm install
npm run build          # пакет целиком (с инструментами ИИ)
npm run build:no-mcp   # без mcp и pc.mcp — для Hub старше 20.11.2026
npm test               # сервис на заглушке Telegram, собранная часть (IPC, сокеты программы), сокет, ссылки, даты
npm run typecheck
```

Экран без публикации — своя копия Hub (`HUB_DEV_PACKAGES="<эта папка>" node scripts/dev.mjs --addr apps.localhost …`) и
скрытый зонд Hub (`apps/desktop/scripts/probe.cjs`), настоящий Telegram не трогается:
- `test/probe-telegram.cjs` — экран целиком на заглушке части;
- `test/probe-relay.cjs` — путь ИИ целиком: режим автора (часть из `dist/`), «ИИ может пользоваться», ключ с пакетом,
  MCP `tools/list` и `tools/call telegram_*` через Hub и мост до части на ПК (`--bridges --apps`, `QUADRO_DEV_PACKAGES`,
  `QUADRO_PROBE_RELAY=1`).

pc-sdk — как в документации автора: `npm i -D https://quadro-metaverse.site/pkg-sdk/v1/pc-sdk-0.1.0.tgz`.

## Упаковать и подписать

```bash
npm run qhapp -- pack "<эта папка>/dist" --out "<эта папка>/out/quadro.telegram-1.0.0.qhapp" --key ~/.quadro/keys/quadro-1.key --kid quadro-1
npm run qhapp -- check "<эта папка>/out/quadro.telegram-1.0.0.qhapp" --publisher quadro --trust official --key quadro-1=<открытый ключ>
```

## Замечания

- GramJS 2.26.22 помечен в npm как архивный; живой форк — `teleproto` (MIT). Клиент спрятан за интерфейсом `TgApi`
  (`pc/types.ts`): переход — правка одного `pc/gram.ts`.
- Вход по QR-коду (без номера телефона) — возможное улучшение.
