// Links of a message: addresses in its text (Telegram marks them as entities: Url — the text itself, TextUrl — a word with a hidden
// address), its buttons and its link preview; plus bare addresses Telegram did not mark. Each once, in order.

export interface EntityLike {
  kind: string;
  offset: number;
  length: number;
  url?: string;
}

const BARE = /\bhttps?:\/\/[^\s<>"'«»)]+[^\s<>"'«».,;:!?)]/gi;

/** Telegram counts offsets in UTF-16 units — the same as JavaScript strings. */
export function linksOf(text: string, entities: EntityLike[], extra: string[] = []): string[] {
  const out: string[] = [];
  const add = (u: string | undefined) => {
    if (!u) return;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`;
    if (!out.includes(url)) out.push(url);
  };
  for (const e of entities) {
    if (/MessageEntityTextUrl/.test(e.kind)) add(e.url);
    else if (/MessageEntityUrl/.test(e.kind)) add(text.slice(e.offset, e.offset + e.length));
  }
  for (const m of text.matchAll(BARE)) add(m[0]);
  for (const u of extra) add(u);
  return out;
}
