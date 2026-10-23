import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

const icons = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

export default defineManifest({
  manifest_version: 3,
  name: 'Chroma — Ambient Theme for YouTube',
  short_name: 'Chroma',
  version: pkg.version,
  description:
    'Recolors YouTube in real time from the video you are watching. Accents, progress bar, glow and scrollbar follow every scene.',
  // 121 is the first release with standard scrollbar-color/scrollbar-width.
  minimum_chrome_version: '121',
  icons,
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Chroma',
    default_icon: icons,
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['*://*.youtube.com/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      // Embedded players on third-party sites are out of scope; top frame only.
      all_frames: false,
    },
  ],
  permissions: ['storage'],
  host_permissions: ['*://*.youtube.com/*', 'https://i.ytimg.com/*'],
  commands: {
    'toggle-chroma': {
      suggested_key: {
        default: 'Alt+Shift+C',
        // MacCtrl = the physical Control key; Cmd+Shift+C is taken by DevTools.
        mac: 'MacCtrl+Shift+C',
      },
      description: 'Toggle Chroma on/off',
    },
  },
});
