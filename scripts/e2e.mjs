// End-to-end smoke test against live YouTube.
//
//   CHROME_PATH=/path/to/chrome-for-testing npm run e2e
//
// Branded Chrome (137+) ignores --load-extension, so this needs Chrome for
// Testing or Chromium: `npx @puppeteer/browsers install chrome@stable`.
// Loads dist/, plays a real video and asserts that the pipeline
// (detect → sample → palette → apply) actually recolors the page.

import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// dist-dev: same code as dist/, but with the dev-only per-sample timing logs we assert on.
const DIST = fileURLToPath(new URL(process.env.E2E_DIST ?? '../dist-dev/', import.meta.url));
const OUT = process.env.E2E_OUT ?? fileURLToPath(new URL('../e2e-output/', import.meta.url));
const EXE = process.env.CHROME_PATH;
const THEME = process.env.E2E_THEME ?? 'dark';
const VIDEO = process.env.E2E_VIDEO ?? 'aqz-KE-bpKQ'; // Big Buck Bunny (Blender Foundation, CC-BY)
if (!EXE) {
  console.error('Set CHROME_PATH to a Chrome for Testing / Chromium binary.');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: EXE,
  headless: process.env.HEADFUL ? false : true,
  pipe: true,
  enableExtensions: [DIST],
  args: ['--autoplay-policy=no-user-gesture-required', '--lang=en-US', '--window-size=1400,900'],
  defaultViewport: { width: 1400, height: 900 },
});

const errors = [];
const sampleMs = [];
const page = await browser.newPage();
page.on('console', (m) => {
  const t = /\[chroma\] sample ([\d.]+) ms main-thread, longest block ([\d.]+) ms \[([^\]]*)\] \(([^,]+), ([^)]+)\)/.exec(m.text());
  if (t) sampleMs.push({ total: Number(t[1]), worst: Number(t[2]), label: t[3], readback: t[4], via: t[5] });
  if (m.type() === 'error' && /chrome-extension:|chroma/i.test(m.text() + (m.location()?.url ?? ''))) errors.push(m.text());
});
page.on('pageerror', (e) => {
  if (/chroma|chrome-extension:/i.test(String(e.stack ?? e))) errors.push(String(e));
});
// f6=400 is YouTube's "dark theme" preference; omit it for light.
await page.setCookie({ name: 'PREF', value: THEME === 'dark' ? 'f6=400&hl=en' : 'hl=en', domain: '.youtube.com', path: '/' });

const state = () =>
  page.evaluate(() => {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const q = (s) => document.querySelector(s);
    const style = (s, p) => (q(s) ? getComputedStyle(q(s))[p] : null);
    return {
      classes: [...root.classList].filter((c) => c.startsWith('chroma')),
      dark: root.hasAttribute('dark'),
      accent: cs.getPropertyValue('--chroma-accent').trim(),
      link: cs.getPropertyValue('--chroma-link').trim(),
      mix: cs.getPropertyValue('--chroma-mix').trim(),
      tokenCss: q('#chroma-tokens')?.textContent.length ?? 0,
      progress: style('.ytp-play-progress', 'backgroundImage'),
      glow: style('#ytd-player', 'boxShadow'),
      linkColor: style('.ytAttributedStringLinkCallToActionColor', 'color'),
      scrollbar: cs.scrollbarColor + ' / ' + cs.scrollbarWidth,
      video: (() => {
        const v = q('#movie_player video.html5-main-video, #shorts-player video');
        return v ? { paused: v.paused, t: Math.round(v.currentTime) } : null;
      })(),
      path: location.pathname,
    };
  });

// ---------------------------------------------------------------- /watch
await page.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: 'networkidle2', timeout: 60000 });
await page.evaluate(() => {
  const v = document.querySelector('#movie_player video');
  if (v) { v.muted = true; v.play().catch(() => {}); }
});
await sleep(7000);
let s = await state();
console.log(JSON.stringify(s, null, 1));
check('chroma-on + chroma-active on <html>', s.classes.includes('chroma-on') && s.classes.includes('chroma-active'), s.classes.join(' '));
check('palette variables set', /^rgb|^#/.test(s.accent) && s.mix === '1', `accent ${s.accent}, mix ${s.mix}`);
check('YouTube color tokens discovered', s.tokenCss > 200, `${s.tokenCss} chars of token overrides`);
check('progress bar recolored', !!s.progress && !s.progress.includes('255, 0, 51'), s.progress?.slice(0, 90));
check('player glow present', !!s.glow && s.glow !== 'none', s.glow?.slice(0, 90));
check('links use themed color', !!s.linkColor && s.linkColor !== 'rgb(62, 166, 255)' && s.linkColor !== 'rgb(6, 95, 212)', s.linkColor ?? 'no link on page');
await page.screenshot({ path: `${OUT}/watch-${THEME}.png` });

// Palette should evolve as scenes change.
const seen = new Set();
for (let i = 0; i < 12; i++) {
  seen.add((await state()).accent);
  await sleep(1000);
}
check('palette follows the video', seen.size >= 2, `${seen.size} distinct accents over 12 s`);

// Performance: main-thread cost of the capture call itself, measured in the page.
const capture = await page.evaluate(async () => {
  const v = document.querySelector('#movie_player video');
  const times = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const p = createImageBitmap(v, 0, 0, v.videoWidth, v.videoHeight, { resizeWidth: 64, resizeHeight: 36, resizeQuality: 'low' });
    times.push(performance.now() - t0);
    (await p).close();
  }
  times.sort((a, b) => a - b);
  return { median: times[10], p95: times[18] };
});
check('capture call < 2 ms on main thread', capture.p95 < 2, `median ${capture.median.toFixed(2)} ms, p95 ${capture.p95.toFixed(2)} ms`);
if (sampleMs.length) {
  const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
  const worst = sampleMs.map((s) => s.worst);
  const total = sampleMs.map((s) => s.total);
  // The first sample pays one-off WebGL context + shader setup; it is reported but not held to the budget.
  const steady = worst.slice(1);
  check(
    'no main-thread block ≥ 2 ms per sample (steady state)',
    Math.max(...steady) < 2,
    `${sampleMs.length} samples · slow: ${sampleMs.slice(1).filter((s) => s.worst >= 2).map((s) => `${s.worst}ms@${s.label}`).join(' ') || 'none'} · longest block median ${pct(worst, 0.5).toFixed(2)} / max ${Math.max(...steady).toFixed(2)} ms (first sample ${worst[0].toFixed(2)} ms) · total per sample median ${pct(total, 0.5).toFixed(2)} ms`,
  );
  check('readback is asynchronous (WebGL)', sampleMs.every((s) => s.readback === 'webgl readback'), [...new Set(sampleMs.map((s) => s.readback))].join(', '));
  check('palette extraction runs off the main thread', sampleMs.every((s) => s.via === 'palette worker'), [...new Set(sampleMs.map((s) => s.via))].join(', '));
} else {
  check('dev timing logs captured', false, 'no [chroma] sample logs — is E2E_DIST a dev build?');
}

// ------------------------------------------------- SPA nav → home (fade out)
await page.evaluate(() => document.querySelector('ytd-topbar-logo-renderer a, a#logo')?.click());
// yt-navigate-finish lands once the home feed has rendered, then the 600 ms fade runs.
await sleep(3500);
s = await state();
check('home: fades back to stock', s.path === '/' && !s.classes.includes('chroma-active') && s.classes.includes('chroma-on'), `${s.path} ${s.classes.join(' ')}`);
await page.screenshot({ path: `${OUT}/home-${THEME}.png` });

// --------------------------------------------------------- back → /watch
await page.goBack();
await sleep(5000);
s = await state();
check('back button: re-themes the video', s.path === '/watch' && s.classes.includes('chroma-active'), s.classes.join(' '));

// ------------------------------------------------------------------ Shorts
await page.goto('https://www.youtube.com/shorts', { waitUntil: 'networkidle2', timeout: 60000 });
await sleep(7000);
s = await state();
check('shorts: themed from the active short', s.path.startsWith('/shorts/') && s.classes.includes('chroma-active'), `${s.path} ${s.classes.join(' ')}`);
await page.screenshot({ path: `${OUT}/shorts-${THEME}.png` });

// ------------------------------------------------------- search / channel
for (const url of ['https://www.youtube.com/results?search_query=blender+open+movie', 'https://www.youtube.com/@BlenderOfficial']) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  s = await state();
  check(`${new URL(url).pathname}: no theming without a video`, !s.classes.includes('chroma-active'), s.classes.join(' '));
}

check('zero console errors from the extension', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
