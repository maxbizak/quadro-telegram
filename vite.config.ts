import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// The package's screen, built for Hub's sandbox:
// - relative addresses (base './'): Hub serves the files from the package's own folder;
// - the bridge /pkg-sdk/v1/quadro.js and the UI kit /pkg-sdk/v1/quadro-ui.css come from Hub (`vite-ignore` in index.html);
// - out goes dist/ = the package: manifest.json + client/ (what `npm run qhapp -- pack dist …` signs).

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** The package's icon (kernel.md §12н): `icon` a path of an SVG or PNG in the package — copied to dist/ at the same path. */
function copyIcon(m: { icon?: unknown }): void {
  if (typeof m.icon !== 'string' || !/\.(svg|png)$/i.test(m.icon)) return;
  mkdirSync(dirname(here(`./dist/${m.icon}`)), { recursive: true });
  copyFileSync(here(`./${m.icon}`), here(`./dist/${m.icon}`));
}

/**
 * dist/manifest.json next to dist/client/ (and the icon): the folder is the whole package. QHAPP_MCP=0 — without the AI's tools (`mcp` and the
 * right pc.mcp), for a Hub whose manifest schema does not take them yet («Ядро 2», claude/v2-package-mcp).
 */
function manifest(): Plugin {
  return {
    name: 'qhapp-manifest',
    closeBundle() {
      mkdirSync(here('./dist'), { recursive: true });
      const m = JSON.parse(readFileSync(here('./manifest.json'), 'utf8')) as { mcp?: unknown; permissions?: string[]; icon?: unknown };
      copyIcon(m);
      if (process.env.QHAPP_MCP === '0') {
        delete m.mcp;
        m.permissions = (m.permissions ?? []).filter((p) => p !== 'pc.mcp');
      }
      writeFileSync(here('./dist/manifest.json'), `${JSON.stringify(m, null, 2)}
`);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [manifest()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    // One file of code and one of styles: easy to read in the review of the Catalog.
    assetsInlineLimit: 0,
    rollupOptions: { output: { entryFileNames: 'app.js', chunkFileNames: 'chunk-[hash].js', assetFileNames: '[name][extname]' } },
  },
});
