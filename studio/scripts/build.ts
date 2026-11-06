import { browserBoundary } from './browserBoundary';
import { prepareCloudflareAssets } from './cloudflareAssets';
import { build } from 'esbuild';
import { stackiFavicon } from '../src/shared/stackiBrand';
import { prepareSiteCache } from './siteCache';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { LIMITS } from '../vendor/stacki/shared/core/limits';

await prepareSiteCache();
await mkdir('dist', { recursive: true });
await prepareCloudflareAssets('dist');
await build({
  entryPoints: ['src/app/main.tsx'],
  bundle: true,
  outfile: 'dist/studio.js',
  platform: 'browser',
  minify: true,
  format: 'esm',
  jsx: 'automatic',
  sourcemap: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  // The UI fonts (main.tsx) ship beside studio.css, in dist/fonts.
  loader: { '.woff2': 'file', '.woff': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  plugins: [browserBoundary],
});
await build({
  entryPoints: ['src/features/preview/previewClient.ts'],
  bundle: true,
  outfile: 'dist/preview.js',
  external: ['/@vite/client'],
  platform: 'browser',
  minify: true,
  format: 'esm',
});
await build({
  entryPoints: ['vendor/stacki/electron/previewClient/morphClient.ts'],
  bundle: true,
  outfile: 'dist/morph.js',
  platform: 'browser',
  minify: true,
  format: 'esm',
  define: {
    AVB_PREVIEW_LIMITS: JSON.stringify({
      previewMarkersMax: LIMITS.previewMarkersMax,
      previewMorphWorkMax: LIMITS.previewMorphWorkMax,
    }),
  },
});
await build({
  entryPoints: ['src/server/integration.ts'],
  bundle: true,
  outfile: 'dist/integration.mjs',
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
await writeFile(
  'dist/index.html',
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Stacki</title><link rel="icon" type="image/svg+xml" href="${stackiFavicon}"><link rel="stylesheet" href="/studio/studio.css"></head><body><div id="root"></div><script type="module" src="/studio/studio.js"></script></body></html>`,
);
await copyFile('vendor/stacki/LICENSE', 'dist/STACKI-LICENSE');
await copyFile('vendor/phosphor/LICENSE', 'dist/PHOSPHOR-LICENSE');
await build({
  entryPoints: ['scripts/cli.ts'],
  bundle: true,
  outfile: 'dist/cli.mjs',
  platform: 'node',
  format: 'esm',
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' },
});
await build({
  entryPoints: ['scripts/container.ts'],
  bundle: true,
  outfile: 'dist/container.mjs',
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
console.log('Studio, integration, and preview clients built.');

await build({
  entryPoints: ['src/features/preview/previewMiddleware.ts'],
  bundle: true,
  outfile: 'dist/previewMiddleware.mjs',
  platform: 'node',
  format: 'esm',
  packages: 'external',
});

await build({
  entryPoints: ['src/features/preview/variantRuntime.ts'],
  bundle: true,
  outfile: 'dist/variantRuntime.mjs',
  platform: 'node',
  format: 'esm',
  packages: 'external',
});
