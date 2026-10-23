// Enforces the bundle budgets from the spec after every build.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));

function gz(files) {
  return files.reduce((n, f) => n + gzipSync(readFileSync(join(dist, f))).length, 0);
}
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p.slice(dist.length));
  }
  return out;
}
// CRXJS emits a tiny loader per content script that dynamic-imports the real
// chunk(s); count everything that loader can pull in (all non-popup JS in assets/).
const all = walk(dist);
const popupHtml = readFileSync(join(dist, manifest.action.default_popup), 'utf8');
const popupJs = [...popupHtml.matchAll(/(?:src|href)="\/?([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const contentJs = all.filter((f) => f.endsWith('.js') && !popupJs.includes(f) && !f.includes('service-worker') && !f.includes('popup'));

const budgets = [
  ['content script', contentJs, 40 * 1024],
  ['popup', popupJs, 60 * 1024],
];
let failed = false;
for (const [name, files, max] of budgets) {
  const size = gz(files);
  const ok = size <= max;
  failed ||= !ok;
  console.log(`${ok ? '✓' : '✗'} ${name}: ${(size / 1024).toFixed(1)} KB gzipped (budget ${max / 1024} KB) — ${files.join(', ')}`);
}
if (failed) process.exit(1);
