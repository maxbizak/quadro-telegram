// Before packing dist/: nothing that must never be published. publisher.dev.json holds the publisher's values for the author
// mode (api_id, api_hash) — in a public package they would be «published» and Telegram would cut them for everyone.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const bad = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/^publisher(\..*)?\.json$/i.test(e.name) || /\.(key|pem)$/i.test(e.name)) bad.push(relative(dist, p));
  }
};
if (!existsSync(dist)) throw new Error('нет dist/ — сначала npm run build');
walk(dist);
// The part's code must carry no api_hash-looking value of its own.
const part = readFileSync(join(dist, 'pc', 'part.cjs'), 'utf8');
for (const m of part.matchAll(/["'`]([0-9a-f]{32})["'`]/g)) bad.push(`pc/part.cjs: строка как api_hash (${m[1].slice(0, 6)}…)`);
if (bad.length) {
  console.error(`Нельзя упаковывать:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log('dist/ можно упаковывать: значений издателя и ключей нет');
