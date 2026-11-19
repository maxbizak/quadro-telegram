// Types of the bridge /pkg-sdk/v1/quadro.js (window.quadro) — what a package's screen may ask Hub. Every call goes through Hub's
// page, which checks it; a screen never reaches Hub by fetch (its sandbox has no cookies and an opaque origin).

export interface QuadroContext {
  app: { id: string; name: string; version: string };
  /** The view of the manifest this frame shows («main»). */
  view: string;
  /** A full screen or a widget on «Главная». */
  place: 'screen' | 'widget';
  theme: QuadroTheme;
  locale: string;
  user: { id: string; displayName: string; avatarUrl: string | null };
  /** Its part on the PC is here (the screen runs in the program and the part is installed). */
  pc?: boolean;
}

export interface QuadroTheme {
  mode: 'light' | 'dark';
  /** CSS variables of Hub's theme (--color-*, --radius-*, --font-sans): the bridge sets them on <html> itself. */
  tokens: Record<string, string>;
}

/** A failed call: `code` — NOT_IN_HUB, TIMEOUT, NOT_SUPPORTED, FORBIDDEN, TOO_LARGE… */
export interface QuadroError extends Error {
  code?: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface Quadro {
  version: 1;
  /** The context, once Hub answered; the theme is already applied to the page. Fails with NOT_IN_HUB outside Hub. */
  ready: Promise<QuadroContext>;
  context: QuadroContext | null;
  /** The package's own storage for this person: a value up to 256 KB. */
  kv: {
    /** null — nothing stored under this key yet. */
    get(key: string): Promise<JsonValue | null>;
    set(key: string, value: JsonValue): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<Array<{ key: string; value: JsonValue }>>;
  };
  /** The values of `settings` of the manifest (Hub draws their screen; secrets are never given to a screen). */
  settings: { get(): Promise<Record<string, JsonValue>> };
  /** Its own server part — coming (NOT_SUPPORTED for now). */
  api: { request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> };
  /** Its own part on the PC (only in the program; NOT_IN_PROGRAM in a browser). `on` — its events, returns «unsubscribe». */
  pc: {
    call<T = unknown>(method: string, params?: unknown): Promise<T>;
    on?(fn: (name: string, data: unknown) => void): () => void;
  };
  ui: {
    toast(text: string, kind?: 'info' | 'success' | 'error'): Promise<void>;
    /** Another view of this package. */
    navigate(view: string): Promise<void>;
    /** https only, in the person's browser. */
    openExternal(url: string): Promise<void>;
    /** The bridge sends the height itself (widgets follow their content). */
    setHeight(px: number): Promise<void>;
  };
  /** Hub's events: «theme» (the person changed the theme; the bridge applies it itself). Returns how to stop listening. */
  on(event: 'theme', fn: (theme: QuadroTheme) => void): () => void;
  on(event: string, fn: (data: unknown) => void): () => void;
}

declare global {
  interface Window {
    quadro: Quadro;
  }
}
