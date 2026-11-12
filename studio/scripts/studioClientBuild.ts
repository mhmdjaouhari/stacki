// The editor client's build options, in one place. Studio builds `dist/studio.js` with
// them, and the demo builds its own copy with them plus one shared module, so the two
// bundles cannot drift apart in anything but that module.
import type { BuildOptions } from 'esbuild';
import { browserBoundary } from './browserBoundary';
import { forkCss } from './forkCss';

export const STUDIO_CLIENT_ENTRY = 'src/app/main.tsx';

// The oldest browsers Studio and the demo support. Naming them is what makes esbuild
// write the vendor prefixes WebKit still needs: Safari (macOS, iOS and iPadOS) ignores an
// unprefixed `user-select`, so without `-webkit-user-select` every panel, rail and handle
// marked unselectable turned blue with native text selection on a drag or a long press.
// `backdrop-filter` needs its prefix before Safari 18. esbuild's own default is `esnext`,
// which writes no prefixes at all. Desktop builds with Vite and is unaffected.
export const STUDIO_BROWSER_TARGET: readonly string[] = ['es2022', 'chrome120', 'firefox121', 'safari16.4'];

export const studioClientOptions: BuildOptions = {
  entryPoints: [STUDIO_CLIENT_ENTRY],
  bundle: true,
  platform: 'browser',
  minify: true,
  format: 'esm',
  jsx: 'automatic',
  target: [...STUDIO_BROWSER_TARGET],
  define: { 'process.env.NODE_ENV': '"production"' },
  // The UI fonts (main.tsx) ship beside the bundle's CSS, in fonts/.
  loader: { '.woff2': 'file', '.woff': 'file' },
  assetNames: 'fonts/[name]-[hash]',
  // forkCss: emdash-stacki's fork themes and sizes Studio's stylesheets as they bundle.
  plugins: [browserBoundary, forkCss],
};
