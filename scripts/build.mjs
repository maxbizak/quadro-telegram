// The package in dist/: the screen (vite) and the part on the PC (esbuild).
//   node scripts/build.mjs            — the whole manifest (with the AI's tools)
//   node scripts/build.mjs --no-mcp   — without `mcp` and pc.mcp, for a Hub that does not take them yet
import { build } from 'vite';
import { buildPart } from './build-pc.mjs';

if (process.argv.includes('--no-mcp')) process.env.QHAPP_MCP = '0';
await build({ logLevel: 'warn' });
console.log(`part → ${await buildPart()}`);
