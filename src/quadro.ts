import { useCallback, useEffect, useState } from 'react';
import type { JsonValue, QuadroContext, QuadroError } from './quadro-types';

// React on top of the bridge (window.quadro, the classic script /pkg-sdk/v1/quadro.js loaded before this code).

export const quadro = window.quadro;

/** Hub's context (app, user, theme, locale), or the error outside Hub (NOT_IN_HUB). */
export function useQuadro(): { ctx: QuadroContext | null; error: QuadroError | null } {
  const [ctx, setCtx] = useState<QuadroContext | null>(quadro?.context ?? null);
  const [error, setError] = useState<QuadroError | null>(quadro ? null : Object.assign(new Error('Нет моста quadro.js'), { code: 'NOT_IN_HUB' }));
  useEffect(() => {
    if (!quadro) return;
    quadro.ready.then(setCtx, (e: QuadroError) => setError(e));
  }, []);
  return { ctx, error };
}

/** The values of the package's settings (read once the bridge is ready). */
export function useSettings(): Record<string, JsonValue> | null {
  const [values, setValues] = useState<Record<string, JsonValue> | null>(null);
  useEffect(() => {
    if (!quadro) return;
    quadro.ready.then(() => quadro.settings.get()).then(setValues, () => setValues({}));
  }, []);
  return values;
}

/** One value of the package's storage, like useState: `[value, save, loaded]`; `save` writes it to Hub. */
export function useKv<T extends JsonValue>(key: string, initial: T): [T, (next: T) => Promise<void>, boolean] {
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!quadro) return;
    let alive = true;
    quadro.ready
      .then(() => quadro.kv.get(key))
      .then((stored) => {
        // A key never written comes back as null: keep the initial value then.
        if (alive && stored !== undefined && stored !== null) setValue(stored as T);
      })
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [key]);
  const save = useCallback(
    async (next: T) => {
      setValue(next);
      await quadro.kv.set(key, next);
    },
    [key],
  );
  return [value, save, loaded];
}

/** Events of its own part on the PC (host.events.emit there): fn(name, data) while the screen is open. */
export function usePcEvents(fn: (name: string, data: unknown) => void): void {
  useEffect(() => {
    if (!quadro) return;
    if (typeof quadro.pc.on === 'function') return quadro.pc.on(fn);
    // A Hub before quadro.pc.on: the same events come as the bridge event «pc» ({ name, data }).
    return quadro.on('pc', (e) => {
      const ev = e as { name?: string; data?: unknown } | null;
      if (ev && typeof ev.name === 'string') fn(ev.name, ev.data);
    });
  }, [fn]);
}

/** A failed call's words for a person. */
export function errorText(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  if (err?.code === 'NOT_IN_PROGRAM') return 'Это действие работает только в программе Quadro Hub на ПК';
  // The program's IPC wraps the part's words: «Error invoking remote method 'pcpart:call': RpcError: <words>».
  const words = (err?.message ?? '').replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:[A-Z]\w*Error|Error):\s*/, '');
  return words || 'Что-то пошло не так';
}
