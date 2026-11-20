import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Check, ExternalLink, History, KeyRound, LogOut, Megaphone, MessageCircle, RefreshCw, Search, ShieldCheck, User, Users } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { errorText, quadro, usePcEvents, useQuadro } from './quadro';

// «Telegram»'s screen in Hub's sandbox. Everything goes to its own part on this PC (quadro.pc.call): the keys of my.telegram.org,
// the sign-in (phone, code, cloud password — typed here by the person, never seen by the AI), which chats the AI may read, and
// what it read. Nothing of Telegram is stored in Hub.

type Kind = 'user' | 'bot' | 'group' | 'channel';
type Status = { canSeal: boolean; configured: boolean; keys: 'own' | 'publisher' | null; publisherKeys: boolean; apiId: number | null; signedIn: boolean; me: { name: string; username?: string } | null; step: 'code' | 'qr' | 'password' | 'done' | null; allowed: number };
type Chat = { id: string; kind: Kind; title: string; username?: string; unread?: number; lastAt?: string; allowed: boolean };
type Read = { at: string; tool: string; chats: string[]; messages: number; files: number; bytes: number; query?: string; error?: string };
type Login = { step: 'code' | 'qr' | 'password' | 'done' | 'error'; viaApp?: boolean; hint?: string; wrong?: boolean; url?: string; expiresMs?: number; message?: string };
type Tab = 'access' | 'journal' | 'account';

const pc = <T,>(method: string, params?: unknown) => quadro.pc.call<T>(method, params);
const KIND: Record<Kind, { label: string; icon: typeof User }> = {
  user: { label: 'Личный', icon: User },
  bot: { label: 'Бот', icon: Bot },
  group: { label: 'Группа', icon: Users },
  channel: { label: 'Канал', icon: Megaphone },
};
const TOOL: Record<string, string> = { chats: 'Список чатов', messages: 'Читал сообщения', search: 'Искал', file: 'Открыл файл' };
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1048576).toFixed(1)} МБ`);

export function App() {
  const { ctx, error } = useQuadro();
  if (error) {
    return (
      <main className="tg">
        <h1>Telegram</h1>
        <p className="q-muted">Этот экран работает внутри Quadro Hub: поставьте приложение из Каталога.</p>
      </main>
    );
  }
  if (!ctx) return <main className="tg q-muted">Загрузка…</main>;
  if (ctx.pc === false) {
    return (
      <main className="tg">
        <Header />
        <section className="q-card tg-center">
          <MessageCircle size={28} className="tg-accent" />
          <h2>Telegram подключается в программе Quadro Hub на ПК</h2>
          <p className="q-muted">Вход в Telegram и переписка остаются на вашем компьютере. Откройте Quadro Hub в программе для Windows.</p>
        </section>
      </main>
    );
  }
  return <TelegramScreen />;
}

function Header() {
  return (
    <header>
      <h1>Telegram</h1>
      <p className="q-muted">Ваш ИИ читает только чаты, которые вы отметите. Всё остаётся на этом ПК.</p>
    </header>
  );
}

function TelegramScreen() {
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState('');
  const [changingKeys, setChangingKeys] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setStatus(await pc<Status>('status'));
    } catch (e) {
      setMessage(errorText(e));
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  let body: React.ReactNode = <p className="q-muted">Проверяю Telegram…</p>;
  if (status && !status.canSeal)
    body = (
      <section className="q-card tg-warn" role="alert">
        <h2>Обновите программу Quadro Hub</h2>
        <p className="q-muted">Этой версии программы нечем зашифровать вход в Telegram на ПК. Без шифрования приложение ничего не сохраняет — обновите программу и откройте экран снова.</p>
      </section>
    );
  else if (status && (!status.configured || changingKeys))
    body = (
      <KeysStep
        first={!status.configured}
        signedIn={status.signedIn}
        onCancel={changingKeys ? () => setChangingKeys(false) : null}
        onDone={async () => {
          setChangingKeys(false);
          await refresh();
        }}
      />
    );
  else if (status && !status.signedIn) body = <LoginStep status={status} onDone={refresh} onChangeKeys={() => setChangingKeys(true)} />;
  else if (status) body = <SignedIn status={status} onChanged={refresh} onOwnKeys={() => setChangingKeys(true)} />;

  return (
    <main className="tg">
      <Header />
      {message && (
        <div className="q-card tg-message" role="alert">
          <span>{message}</span>
          <button type="button" className="q-btn" onClick={() => setMessage('')}>
            Закрыть
          </button>
        </div>
      )}
      {body}
    </main>
  );
}

function KeysStep({ first, signedIn, onDone, onCancel }: { first: boolean; signedIn: boolean; onDone: () => void; onCancel: (() => void) | null }) {
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await pc('setKeys', { apiId: apiId.trim(), apiHash: apiHash.trim() });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="q-card q-stack">
      <div className="tg-step">
        <KeyRound size={20} className="tg-accent" />
        <h2>{first ? 'Шаг 1. Ключи приложения Telegram' : 'Свои ключи Telegram'}</h2>
      </div>
      <p className="q-muted">
        {first
          ? 'Telegram пускает сторонние программы только по ключам приложения. Создать свои — бесплатно, пара минут.'
          : 'Свои ключи нужны, только если ключи Quadro не подходят. Создать их — бесплатно, пара минут.'}
      </p>
      <ol className="tg-howto">
        <li>
          Откройте{' '}
          <button type="button" className="tg-link" onClick={() => void quadro.ui.openExternal('https://my.telegram.org/apps')}>
            my.telegram.org <ExternalLink size={12} />
          </button>{' '}
          и войдите своим номером — код придёт в приложение Telegram (не по SMS). VPN лучше выключить.
        </li>
        <li>Нажмите «API development tools».</li>
        <li>
          Заполните форму: <b>App title</b> — латиницей, например «QuadroHub»; <b>Short name</b> — латиницей, например «quadrohub»; <b>Platform</b> — Desktop. URL и Description оставьте пустыми. Нажмите «Create application».
        </li>
        <li>
          Скопируйте сюда <b>App api_id</b> (число) и <b>App api_hash</b> (32 знака).
        </li>
      </ol>
      <div className="tg-fields">
        <label className="q-label">
          api_id
          <input className="q-input" inputMode="numeric" autoComplete="off" value={apiId} onChange={(e) => setApiId(e.target.value)} placeholder="12345678" />
        </label>
        <label className="q-label">
          api_hash
          <input className="q-input" type="password" autoComplete="off" spellCheck={false} value={apiHash} onChange={(e) => setApiHash(e.target.value)} placeholder="32 знака" />
        </label>
      </div>
      {error && (
        <p className="tg-error" role="alert">
          {error}
        </p>
      )}
      <div className="q-row">
        <button type="button" className="q-btn q-btn-primary" disabled={busy || !apiId.trim() || !apiHash.trim()} onClick={() => void save()}>
          Сохранить ключи
        </button>
        {onCancel && (
          <button type="button" className="q-btn" onClick={onCancel}>
            Отмена
          </button>
        )}
      </div>
      <p className="q-subtle">
        <ShieldCheck size={12} /> Ключи — ваши, никому их не давайте. Они хранятся только на этом ПК, зашифрованные Windows.
        {signedIn ? ' С новыми ключами вход в Telegram придётся повторить.' : ''}
      </p>
      <KeysHelp />
    </section>
  );
}

/** A QR code as SVG — black on white whatever the theme (it is a picture for the phone's camera, not part of the page's look). */
function QrCode({ text, size = 220 }: { text: string; size?: number }) {
  const { n, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) d += `M${c + 4},${r + 4}h1v1h-1z`;
    return { n: count + 8, path: d };
  }, [text]);
  return (
    <svg className="tg-qr" role="img" aria-label="QR-код для входа в Telegram" width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

type Method = 'qr' | 'phone';

function LoginStep({ status, onDone, onChangeKeys }: { status: Status; onDone: () => void; onChangeKeys: () => void }) {
  const [method, setMethod] = useState<Method>('qr');
  const [step, setStep] = useState<'start' | 'qr' | 'code' | 'password'>('start');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [info, setInfo] = useState<Login | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const apply = useCallback(
    (r: Login) => {
      setInfo(r);
      if (r.step === 'done') {
        setPassword('');
        onDone();
      } else if (r.step === 'error') {
        setError(r.message ?? 'Вход не удался');
        setStep('start');
      } else setStep(r.step);
    },
    [onDone],
  );
  const run = useCallback(
    async (fn: () => Promise<Login>) => {
      setBusy(true);
      setError('');
      try {
        apply(await fn());
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    [apply],
  );
  // QR: new codes, the password and the end come from the part by themselves.
  const onLogin = useCallback(
    (name: string, data: unknown) => {
      if (name === 'login') apply(data as Login);
    },
    [apply],
  );
  usePcEvents(onLogin);
  const startQr = useCallback(() => void run(() => pc<Login>('qrStart')), [run]);
  useEffect(() => {
    if (method !== 'qr') return;
    startQr();
    // Leaving the QR (another way, or the screen closed): the part stops waiting for the phone.
    return () => void pc('qrCancel').catch(() => undefined);
  }, [method, startQr]);
  const switchTo = (m: Method) => {
    setError('');
    setInfo(null);
    setStep('start');
    setMethod(m);
  };

  return (
    <section className="q-card q-stack">
      <div className="tg-step">
        <MessageCircle size={20} className="tg-accent" />
        <h2>{status.keys === 'publisher' ? 'Вход в Telegram' : 'Шаг 2. Вход в Telegram'}</h2>
      </div>
      {step !== 'password' && (
        <div className="tg-methods" role="tablist" aria-label="Как войти">
          <button type="button" role="tab" aria-selected={method === 'qr'} className="tg-tab" onClick={() => switchTo('qr')}>
            По QR-коду
          </button>
          <button type="button" role="tab" aria-selected={method === 'phone'} className="tg-tab" onClick={() => switchTo('phone')}>
            По номеру телефона
          </button>
        </div>
      )}
      {method === 'qr' && step !== 'password' && (
        <div className="tg-qr-box">
          {info?.step === 'qr' && info.url ? <QrCode text={info.url} /> : <div className="tg-qr tg-qr-empty">{busy ? 'Готовлю код…' : 'Нет кода'}</div>}
          <ol className="tg-howto">
            <li>Откройте Telegram на телефоне.</li>
            <li>
              <b>Настройки → Устройства → Подключить устройство</b>.
            </li>
            <li>Наведите камеру на этот код. Код обновляется сам примерно раз в 30 секунд.</li>
          </ol>
          {step === 'start' && !busy && (
            <div>
              <button type="button" className="q-btn" onClick={startQr}>
                Показать новый код
              </button>
            </div>
          )}
        </div>
      )}
      {method === 'phone' && step !== 'code' && step !== 'password' && (
        <form
          className="q-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => pc<Login>('sendCode', { phone }));
          }}
        >
          <label className="q-label">
            Номер телефона аккаунта
            <input className="q-input tg-narrow" type="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+79991234567" />
          </label>
          <div>
            <button type="submit" className="q-btn q-btn-primary" disabled={busy || !phone.trim()}>
              Получить код
            </button>
          </div>
        </form>
      )}
      {method === 'phone' && step === 'code' && (
        <form
          className="q-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => pc<Login>('signIn', { code }));
          }}
        >
          <p className="q-muted">{info?.viaApp ? 'Код пришёл в Telegram на другом вашем устройстве (чат «Telegram»).' : 'Код пришёл по SMS.'}</p>
          <label className="q-label">
            Код
            <input className="q-input tg-narrow" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="12345" />
          </label>
          <div className="q-row">
            <button type="submit" className="q-btn q-btn-primary" disabled={busy || !code.trim()}>
              Войти
            </button>
            <button type="button" className="q-btn" onClick={() => setStep('start')}>
              Другой номер
            </button>
          </div>
        </form>
      )}
      {step === 'password' && (
        <form
          className="q-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => pc<Login>('password', { password }));
          }}
        >
          <p className="q-muted">
            {info?.wrong ? 'Пароль не подошёл — попробуйте ещё раз. ' : ''}У аккаунта включён облачный пароль (двухэтапная проверка).{info?.hint ? ` Подсказка: «${info.hint}».` : ''}
          </p>
          <label className="q-label">
            Облачный пароль
            <input className="q-input tg-narrow" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <div>
            <button type="submit" className="q-btn q-btn-primary" disabled={busy || !password}>
              Войти
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="tg-error" role="alert">
          {error}
        </p>
      )}
      <p className="q-subtle">
        <ShieldCheck size={12} /> Код, номер и пароль идут прямо в Telegram с этого ПК. ИИ их не видит и войти сам не может. Вход появится в Telegram в «Настройки → Устройства» как «Quadro Hub».
      </p>
      <div className="q-row tg-wrap">
        <button type="button" className="tg-link" onClick={onChangeKeys}>
          {status.keys === 'publisher' ? 'Войти со своими ключами api_id и api_hash' : 'Изменить api_id и api_hash'}
        </button>
        {status.keys === 'own' && status.publisherKeys && <QuadroKeysButton onDone={onDone} />}
      </div>
    </section>
  );
}

/** Back to Quadro's keys: the own keys' session ends (signing in again). */
function QuadroKeysButton({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState('');
  return (
    <>
      <button
        type="button"
        className="tg-link"
        onClick={() =>
          void pc('useQuadroKeys').then(
            () => onDone(),
            (e) => setError(errorText(e)),
          )
        }
      >
        Вернуться к ключам Quadro
      </button>
      {error && <span className="tg-error">{error}</span>}
    </>
  );
}

function SignedIn({ status, onChanged, onOwnKeys }: { status: Status; onChanged: () => void; onOwnKeys: () => void }) {
  const [tab, setTab] = useState<Tab>('access');
  const [journalSeen, setJournalSeen] = useState<Read[] | null>(null);
  return (
    <>
      <div className="q-row tg-me">
        <span className="q-badge">
          <Check size={12} /> Подключён: {status.me?.name}
          {status.me?.username ? ` · @${status.me.username}` : ''}
        </span>
      </div>
      <div className="tg-tabs" role="tablist" aria-label="Разделы">
        {(
          [
            ['access', 'Доступ для ИИ'],
            ['journal', 'Что читал ИИ'],
            ['account', 'Аккаунт'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className="tg-tab" onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'access' && <Access onChanged={onChanged} />}
      {tab === 'journal' && <Journal initial={journalSeen} onLoaded={setJournalSeen} />}
      {tab === 'account' && <Account status={status} onChanged={onChanged} onOwnKeys={onOwnKeys} />}
    </>
  );
}

function Access({ onChanged }: { onChanged: () => void }) {
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | 'allowed' | 'user' | 'group' | 'channel' | 'bot'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async (refresh = false) => {
    setError('');
    try {
      setChats(await pc<Chat[]>('chats', { refresh }));
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => void load(), [load]);
  const toggle = async (chat: Chat) => {
    setBusy(chat.id);
    setError('');
    try {
      await pc('setAccess', { id: chat.id, allowed: !chat.allowed });
      setChats((list) => (list ?? []).map((c) => (c.id === chat.id ? { ...c, allowed: !c.allowed } : c)));
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (chats ?? []).filter((c) => (kind === 'all' ? true : kind === 'allowed' ? c.allowed : c.kind === kind) && (!q || c.title.toLowerCase().includes(q) || c.username?.toLowerCase().includes(q)));
  }, [chats, query, kind]);
  const allowed = (chats ?? []).filter((c) => c.allowed).length;
  return (
    <section className="q-stack">
      <div className="q-card q-stack">
        <p className="q-muted">
          Отметьте чаты, которые ИИ может читать — вместе с файлами, картинками и ссылками. По умолчанию — ни одного. Остальные чаты ИИ не видит, даже их названия.
        </p>
        <div className="tg-filters">
          <label className="tg-search">
            <Search size={16} className="q-muted" />
            <input className="q-input" aria-label="Найти чат" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти чат" />
          </label>
          <select className="q-select tg-kind" aria-label="Какие чаты" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="all">Все чаты</option>
            <option value="allowed">Разрешённые ИИ</option>
            <option value="group">Группы</option>
            <option value="user">Личные</option>
            <option value="channel">Каналы</option>
            <option value="bot">Боты</option>
          </select>
          <button type="button" className="q-btn" onClick={() => void load(true)} aria-label="Обновить список">
            <RefreshCw size={16} /> Обновить
          </button>
        </div>
        <p className="q-subtle">Разрешено ИИ: {allowed}</p>
      </div>
      {error && (
        <p className="tg-error" role="alert">
          {error}
        </p>
      )}
      {!chats ? (
        <p className="q-muted">Загружаю чаты…</p>
      ) : shown.length === 0 ? (
        <p className="q-muted">Ничего не найдено.</p>
      ) : (
        <ul className="q-list">
          {shown.map((c) => {
            const K = KIND[c.kind];
            return (
              <li key={c.id} className="tg-chat">
                <K.icon size={18} className={c.allowed ? 'tg-accent' : 'q-muted'} />
                <div className="tg-grow">
                  <div className="tg-name">{c.title}</div>
                  <div className="q-subtle">
                    {K.label}
                    {c.username ? ` · @${c.username}` : ''}
                    {c.lastAt ? ` · ${when(c.lastAt)}` : ''}
                  </div>
                </div>
                <label className="tg-switch">
                  <input type="checkbox" role="switch" aria-label={`ИИ может читать «${c.title}»`} checked={c.allowed} disabled={busy === c.id} onChange={() => void toggle(c)} />
                  <span aria-hidden="true" />
                  <span className="tg-switch-label">{c.allowed ? 'ИИ читает' : 'Закрыт'}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Journal({ initial, onLoaded }: { initial: Read[] | null; onLoaded: (r: Read[]) => void }) {
  const [list, setList] = useState<Read[] | null>(initial);
  const [error, setError] = useState('');
  useEffect(() => {
    pc<Read[]>('journal', { limit: 200 }).then(
      (r) => {
        setList(r);
        onLoaded(r);
      },
      (e) => setError(errorText(e)),
    );
  }, [onLoaded]);
  const onRead = useCallback((name: string, data: unknown) => {
    if (name === 'read') setList((old) => [data as Read, ...(old ?? [])].slice(0, 200));
  }, []);
  usePcEvents(onRead);
  const clear = async () => {
    try {
      await pc('clearJournal');
      setList([]);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <section className="q-stack">
      <p className="q-muted">Каждое обращение ИИ к Telegram: когда, что делал, в каких чатах и сколько. Само содержимое сюда не пишется. Журнал хранится только на этом ПК.</p>
      {error && <p className="tg-error">{error}</p>}
      {!list ? (
        <p className="q-muted">Загружаю…</p>
      ) : list.length === 0 ? (
        <div className="q-card tg-center">
          <History size={24} className="q-muted" />
          <h2>ИИ ещё ничего не читал</h2>
        </div>
      ) : (
        <>
          <ul className="q-list">
            {list.map((r, i) => (
              <li key={`${r.at}-${i}`} className="tg-read">
                <span className="q-subtle tg-time">{when(r.at)}</span>
                <div className="tg-grow">
                  <div>
                    <b>{TOOL[r.tool] ?? r.tool}</b>
                    {r.query ? ` «${r.query}»` : ''}
                    {r.chats.length ? ` — ${r.chats.map((c) => `«${c}»`).join(', ')}` : ''}
                  </div>
                  <div className="q-subtle">
                    {r.error ? <span className="tg-error">Отказ: {r.error}</span> : [r.messages ? `${r.messages} сообщ.` : '', r.files ? `${r.files} файл` : '', r.bytes ? kb(r.bytes) : ''].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div>
            <button type="button" className="q-btn" onClick={() => void clear()}>
              Очистить журнал
            </button>
          </div>
        </>
      )}
    </section>
  );
}

const EXAMPLE = 'Посмотри в Telegram чат «UGC работа» и личку с заказчиком за октябрь–ноябрь и составь список работ, за которые мне ещё не заплатили: что за работа, когда сдал, сколько договорились, есть ли подтверждение оплаты.';

function Account({ status, onChanged, onOwnKeys }: { status: Status; onChanged: () => void; onOwnKeys: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const logout = async () => {
    setBusy(true);
    setError('');
    try {
      await pc('logout', { keys: all });
      void quadro.ui.toast('Вы вышли из Telegram', 'success');
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="q-stack">
      <div className="q-card q-stack">
        <h2>Как спросить ИИ</h2>
        <p className="q-muted">
          Подключите свой ИИ к Quadro Hub и разрешите ему приложение «Telegram». ИИ увидит инструменты <code>telegram_chats</code>, <code>telegram_messages</code>, <code>telegram_search</code> и <code>telegram_file</code> — только для чтения
          разрешённых чатов. Например:
        </p>
        <textarea className="q-textarea" readOnly rows={3} value={EXAMPLE} aria-label="Пример просьбы к ИИ" onFocus={(e) => e.currentTarget.select()} />
      </div>
      <div className="q-card q-stack">
        <h2>Аккаунт</h2>
        <p className="q-muted">
          Вход: {status.me?.name}
          {status.me?.username ? ` (@${status.me.username})` : ''} · разрешено чатов: {status.allowed}
        </p>
        {!confirm ? (
          <div>
            <button type="button" className="q-btn q-btn-danger" onClick={() => setConfirm(true)}>
              <LogOut size={16} /> Выйти из Telegram
            </button>
          </div>
        ) : (
          <div className="q-stack tg-confirm">
            <p>Сессия закроется в Telegram (исчезнет из «Устройств») и будет удалена с этого ПК. ИИ больше ничего не прочитает, пока вы не войдёте снова.</p>
            <label className="q-row">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Удалить также список разрешённых чатов и журнал
              {status.keys === 'own' ? ', свои api_id и api_hash' : ''}
            </label>
            <div className="q-row">
              <button type="button" className="q-btn q-btn-danger" disabled={busy} onClick={() => void logout()}>
                Выйти
              </button>
              <button type="button" className="q-btn" onClick={() => setConfirm(false)}>
                Отмена
              </button>
            </div>
          </div>
        )}
        {error && <p className="tg-error">{error}</p>}
      </div>
      <details className="q-card tg-more">
        <summary>Дополнительно</summary>
        <div className="q-stack">
          <p className="q-muted">
            Ключи приложения Telegram: {status.keys === 'own' ? `свои (api_id ${status.apiId})` : 'ключи Quadro'}.
            {status.keys === 'own' ? '' : ' Свои ключи с my.telegram.org нужны, только если с ключами Quadro что-то не так.'}
          </p>
          <div className="q-row tg-wrap">
            <button type="button" className="q-btn" onClick={onOwnKeys}>
              {status.keys === 'own' ? 'Изменить свои ключи' : 'Войти со своими ключами'}
            </button>
            {status.keys === 'own' && status.publisherKeys && <QuadroKeysButton onDone={onChanged} />}
          </div>
        </div>
      </details>
    </section>
  );
}

/** What helps when my.telegram.org says «ERROR» or «Too many attempts» (checked against TDLib's answers and users' reports, 20.11.2026). */
function KeysHelp() {
  return (
    <details className="tg-help">
      <summary>Не получается на my.telegram.org? «ERROR» или «Too many attempts»</summary>
      <h3>«ERROR» при «Create application»</h3>
      <ul>
        <li>
          <b>Выключите VPN и прокси</b> — это самая частая причина (так советуют разработчики Telegram). Если без VPN сайт не открывается, включите VPN <b>той же страны, что и номер</b>.
        </li>
        <li>
          <b>Другая сеть:</b> раздайте мобильный интернет с телефона и откройте сайт ещё раз.
        </li>
        <li>
          <b>Другой браузер:</b> браузер телефона или режим инкогнито без расширений — блокировщики рекламы мешают форме.
        </li>
        <li>
          <b>Поля по минимуму:</b> App title и Short name — латиницей без пробелов, например «QuadroHub» и «quadrohub» (короткое имя — 5–32 знака). Platform — Desktop. <b>URL и Description оставьте пустыми.</b>
        </li>
      </ul>
      <h3>«Too many attempts»</h3>
      <ul>
        <li>Это временный запрет Telegram на частые попытки. Он бывает даже с первой попытки и проходит сам.</li>
        <li>
          <b>Не нажимайте снова:</b> каждая новая попытка продлевает запрет. Подождите около суток и сделайте одну аккуратную попытку по советам выше.
        </li>
      </ul>
      <h3>Ещё</h3>
      <ul>
        <li>На один номер Telegram даёт одно приложение. Если вы его уже создавали, откройте «API development tools» и скопируйте api_id и api_hash оттуда.</li>
        <li>Если номер совсем новый, Telegram иногда отказывает первые дни — попробуйте позже.</li>
      </ul>
    </details>
  );
}
