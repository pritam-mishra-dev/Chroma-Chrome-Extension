// Renders the popup at 2x next to a live YouTube tab, and exercises its
// controls end to end (popup → storage → content script → page).
//
//   CHROME_PATH=/path/to/chrome-for-testing node scripts/popup-shot.mjs
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL(process.env.E2E_DIST ?? '../dist/', import.meta.url));
const OUT = process.env.E2E_OUT ?? fileURLToPath(new URL('../e2e-output/', import.meta.url));
const VIDEO = process.env.E2E_VIDEO ?? 'aqz-KE-bpKQ';
const AT = Number(process.env.E2E_AT ?? 60);
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
  pipe: true,
  enableExtensions: [DIST],
  args: ['--autoplay-policy=no-user-gesture-required', '--lang=en-US'],
  defaultViewport: { width: 1400, height: 900 },
});

const yt = await browser.newPage();
await yt.setCookie({ name: 'PREF', value: 'f6=400&hl=en', domain: '.youtube.com', path: '/' });
await yt.goto(`https://www.youtube.com/watch?v=${VIDEO}&t=${AT}s`, { waitUntil: 'networkidle2', timeout: 60000 });
await yt.evaluate(() => {
  const v = document.querySelector('#movie_player video');
  if (v) { v.muted = true; v.play().catch(() => {}); }
});
await sleep(6000);

const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
const extId = new URL(sw.url()).host;
const worker = await sw.worker();
const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: '*://*.youtube.com/*' }))[0]?.id);

const popup = await browser.newPage();
await popup.setViewport({ width: 340, height: 600, deviceScaleFactor: 2 });
await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await popup.goto(`chrome-extension://${extId}/src/popup/index.html?tab=${tabId}`);
await sleep(2000);

const info = await popup.evaluate(() => ({
  status: document.querySelector('.status')?.textContent,
  accent: getComputedStyle(document.documentElement).getPropertyValue('--accent'),
  height: document.documentElement.scrollHeight,
}));
check('popup connects to the YouTube tab', /Sampling|thumbnail/.test(info.status ?? ''), info.status);
check('popup wears the live palette', info.accent !== '#8c6cff', info.accent);
check('popup fits Chrome’s 600 px popup limit', info.height <= 600, `${info.height}px`);
await popup.screenshot({ path: `${OUT}/popup.png`, fullPage: true });

// Swatch copy → toast
await popup.click('.swatch');
await sleep(300);
const toast = await popup.$eval('.toast', (t) => t.className + ' ' + t.textContent);
check('clicking a swatch shows a copy toast', /show/.test(toast) && /#[0-9A-F]{6}/.test(toast), toast.trim());

// Mode → Custom: page should switch to the custom color
await popup.click('.segmented button:nth-of-type(3)');
await sleep(400);
check('custom mode shows the color picker', !!(await popup.$('.custom-color input[type=color]')));
await sleep(2000);
const custom = await yt.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--chroma-accent').trim());
await popup.screenshot({ path: `${OUT}/popup-custom.png`, fullPage: true });
check('page follows custom mode', /^(#|rgb)/.test(custom), custom);
await popup.click('.segmented button:nth-of-type(1)');

// Master toggle off → html.chroma-on removed instantly
await popup.click('.header .switch');
await sleep(500);
const off = await yt.evaluate(() => document.documentElement.classList.contains('chroma-on'));
check('master toggle turns theming off', off === false);
await popup.click('.header .switch');
await sleep(800);
const on = await yt.evaluate(() => document.documentElement.classList.contains('chroma-on'));
check('master toggle turns it back on', on === true);

// Keyboard command path: same storage write the service worker does.
const before = await worker.evaluate(async () => (await chrome.storage.sync.get('chroma.settings'))['chroma.settings'].enabled);
await worker.evaluate(async () => {
  const s = (await chrome.storage.sync.get('chroma.settings'))['chroma.settings'];
  await chrome.storage.sync.set({ 'chroma.settings': { ...s, enabled: !s.enabled } });
});
await sleep(500);
const popupSwitch = await popup.$eval('.header .switch', (b) => b.getAttribute('aria-checked'));
check('popup reflects external toggles live', popupSwitch === String(!before), `aria-checked=${popupSwitch}`);
await worker.evaluate(async () => {
  const s = (await chrome.storage.sync.get('chroma.settings'))['chroma.settings'];
  await chrome.storage.sync.set({ 'chroma.settings': { ...s, enabled: true } });
});

await yt.screenshot({ path: `${OUT}/watch-with-popup-source.png` });
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed. Screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
