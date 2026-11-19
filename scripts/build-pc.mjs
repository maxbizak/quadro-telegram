// The part on the PC as one file of the package: pc/part.ts with GramJS and @quadrohub/pc-sdk bundled in, CommonJS
// (an installed part's folder has no package.json: .cjs is read as CommonJS).
//   node scripts/build-pc.mjs [outfile]   → dist/pc/part.cjs
// The part's process has no network of its own (the program's part-guard closes net, tls, http, WebSocket): teleproto's TCP,
// proxy and socks routes are replaced by stubs — it talks through host.net.websocket (pc/host-websocket.ts).
// No code made at run time: teleproto compiles its TL readers with `new Function` and falls back to reading field by field when
// that throws — the bundle takes the fallback (the Catalog's review flags `new Function` as eval).
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CLOSED = ['net', 'tls', 'http', 'https', 'http2', 'dns', 'dgram', 'socks', 'websocket', 'ws', 'node-localstorage'];
const stubs = {
  name: 'closed-modules',
  setup(b) {
    b.onResolve({ filter: new RegExp(`^(node:)?(${CLOSED.join('|')})$`) }, (a) => ({ path: a.path.replace(/^node:/, ''), namespace: 'closed' }));
    b.onLoad({ filter: /.*/, namespace: 'closed' }, (a) => ({
      contents: `const no = () => { throw new Error(${JSON.stringify(`${a.path}: сеть части — только через программу`)}); };
module.exports = new Proxy({}, { get: (_, k) => (k === '__esModule' ? false : k === 'default' ? module.exports : class { constructor() { no(); } }) });`,
      loader: 'js',
    }));
  },
};

const noCodegen = {
  name: 'no-codegen',
  setup(b) {
    b.onLoad({ filter: /teleproto[\\/]tl[\\/]runtime[\\/]fieldCodec\.js$/ }, (a) => {
      const src = readFileSync(a.path, 'utf8');
      const n = src.split('new Function(').length - 1;
      if (n !== 2) throw new Error(`teleproto fieldCodec.js: ждали 2 «new Function(», нашли ${n} — проверьте запасной путь`);
      return { contents: `const __noCodegen = () => { throw new Error('no code generation in Quadro parts'); };
${src.replaceAll('new Function(', '__noCodegen(')}`, loader: 'js' };
    });
  },
};

export async function buildPart(outfile = join(root, 'dist', 'pc', 'part.cjs')) {
  await build({
    entryPoints: [join(root, 'pc', 'part.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    legalComments: 'eof',
    logLevel: 'warning',
    plugins: [stubs, noCodegen],
  });
  return outfile;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) console.log(`part → ${await buildPart(process.argv[2])}`);
