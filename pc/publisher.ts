/**
 * The publisher's keys («ключи Quadro»): the manifest's `publisherValues` api_id and api_hash — kept by the Catalog sealed, never
 * in the package; the program asks Hub for them before the part starts and puts them in `host.app.config.publisher`
 * (kernel §12б; in the author mode — publisher.dev.json of the package's folder). Absent or malformed — null: own keys.
 * Its own module: tests import it without starting the part.
 */
export function publisherKeysOf(config: unknown): { apiId: number; apiHash: string } | null {
  const v = (config as { publisher?: Record<string, unknown> } | null)?.publisher;
  const apiId = Number(String(v?.api_id ?? '').trim());
  const apiHash = String(v?.api_hash ?? '').trim().toLowerCase();
  return Number.isInteger(apiId) && apiId > 0 && apiId < 2 ** 31 && /^[0-9a-f]{32}$/.test(apiHash) ? { apiId, apiHash } : null;
}
