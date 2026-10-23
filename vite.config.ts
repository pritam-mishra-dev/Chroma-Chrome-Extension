import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig(({ mode }) => ({
  // CRXJS builds standalone content scripts in a sub-build that always runs in
  // production env, so import.meta.env.DEV can't tell dev from prod there.
  define: { __CHROMA_DEV__: JSON.stringify(mode !== 'production') },
  plugins: [
    crx({
      manifest,
      contentScripts: {
        // One self-contained IIFE instead of CRXJS's default loader +
        // dynamic import(): the loader's import() of a chrome-extension://
        // URL and Vite's injected <link rel=modulepreload> tags both log
        // "Unsafe attempt to load URL" errors in YouTube's console.
        standaloneFiles: ['src/content/index.ts'],
      },
    }),
  ],
  // Preact via esbuild's automatic JSX runtime — avoids pulling Babel in
  // through @preact/preset-vite just to compile a single popup.
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  resolve: {
    alias: { react: 'preact/compat', 'react-dom': 'preact/compat' },
  },
  build: {
    target: 'chrome121',
    sourcemap: false,
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
    cors: { origin: [/chrome-extension:\/\//] },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
}) as import('vite').UserConfig & { test?: unknown });
