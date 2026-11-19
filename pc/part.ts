import './env';
import { connect, type PartHostApi } from '@quadrohub/pc-sdk';
import { mtprotoFactory } from './mtproto';
import { TelegramService } from './service';
import { Store } from './store';
import type { TgFactory } from './types';

// «Telegram»'s part on the PC (a package of the catalog like any author's): the person's MTProto client. Its screen signs in and
// chooses chats (host.rpc.handle — only its screen calls these); the AI reads through Hub's MCP (host.mcp.handle — only the AI
// calls these, and they never sign in, never see the phone, code or password, and read only the allowed chats).

export const SCREEN_METHODS = ['status', 'setKeys', 'sendCode', 'signIn', 'password', 'qrStart', 'qrCancel', 'logout', 'chats', 'setAccess', 'access', 'journal', 'clearJournal'] as const;
/** The AI's tools: manifest `mcp.tools[].handler` = `pc:<name>`. */
export const AI_TOOLS = ['chats', 'messages', 'search', 'file'] as const;

type Host = Pick<PartHostApi, 'app' | 'rpc' | 'lifecycle' | 'events'> & Partial<Pick<PartHostApi, 'mcp' | 'secrets' | 'net'>>;

/** `sealer` — Windows' sealing if this program has it (by default the host's, if any). */
export function serveTelegram(host: Host, factory?: TgFactory, sealer: Host['secrets'] | null = host.secrets ?? null): TelegramService {
  const store = new Store(host.app.dataDir, sealer);
  const open = host.net?.websocket;
  const service = new TelegramService({
    store,
    onRead: (entry) => host.events.emit('read', entry),
    onLogin: (state) => host.events.emit('login', state),
    factory:
      factory ??
      (open
        ? mtprotoFactory((url, protocols) => open(url, protocols))
        : async () => {
            throw new Error('Программа Quadro Hub не умеет открывать соединение для Telegram: обновите программу');
          }),
  });
  const obj = (x: unknown) => (x && typeof x === 'object' ? x : {});
  host.rpc.handle('status', () => service.status());
  host.rpc.handle('setKeys', (x) => service.setKeys(obj(x)));
  host.rpc.handle('sendCode', (x) => service.sendCode(obj(x)));
  host.rpc.handle('signIn', (x) => service.signIn(obj(x)));
  host.rpc.handle('password', (x) => service.password(obj(x)));
  host.rpc.handle('qrStart', () => service.qrStart());
  host.rpc.handle('qrCancel', () => service.qrCancel());
  host.rpc.handle('logout', (x) => service.logout(obj(x)));
  host.rpc.handle('chats', (x) => service.chats(obj(x)));
  host.rpc.handle('setAccess', (x) => service.setAccess(obj(x)));
  host.rpc.handle('access', () => service.access());
  host.rpc.handle('journal', (x) => service.journal(obj(x)));
  host.rpc.handle('clearJournal', () => service.clearJournal());
  if (host.mcp) {
    host.mcp.handle('chats', () => service.aiChats());
    host.mcp.handle('messages', (x, ctx) => service.aiMessages(x, ctx?.signal));
    host.mcp.handle('search', (x, ctx) => service.aiSearch(x, ctx?.signal));
    host.mcp.handle('file', (x, ctx) => service.aiFile(x, ctx?.signal));
  }
  host.lifecycle.onStop(() => service.stop());
  return service;
}

async function main(): Promise<void> {
  const host = await connect({ manualReady: true });
  // A program before host.secrets answers «нет такого действия»: then nothing of Telegram is kept, the screen says to update.
  const sealOk = await host.secrets.seal('quadro').then(
    () => true,
    () => false,
  );
  serveTelegram(host, undefined, sealOk ? host.secrets : null);
  host.lifecycle.ready();
}

// Started by the program (Node's IPC channel); imported by tests — nothing runs.
if (typeof process.send === 'function' || (process as unknown as { parentPort?: unknown }).parentPort) void main();
