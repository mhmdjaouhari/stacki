// Goal: Studio serves its build's files and UI fonts, and nothing else from the build directory.
// Method: check the allowlist against the names the build emits and against names it must refuse.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStudioAsset, isStudioFont } from '../src/shared/studioAssets';

test('the build files and the bundled UI fonts are served', () => {
  for (const name of ['index.html', 'studio.js', 'studio.css', 'preview.js', 'morph.js']) {
    assert.equal(isStudioAsset(name), true, name);
  }
  for (const name of ['fonts/inter-latin-wght-normal-NIZQ5HXR.woff2', 'fonts/iosevka-latin-400-normal-4ZQ2BS7M.woff']) {
    assert.equal(isStudioFont(name), true, name);
    assert.equal(isStudioAsset(name), true, name);
  }
});

test('other files in the build directory are refused', () => {
  for (const name of [
    'studio.js.map',
    'integration.mjs',
    'cli.mjs',
    'STACKI-LICENSE',
    'fonts/',
    'fonts/inter.ttf',
    'fonts/../integration.mjs',
    'fonts/nested/inter.woff2',
    '../fonts/inter.woff2',
    'fonts/inter.woff2.map',
  ]) {
    assert.equal(isStudioAsset(name), false, name);
  }
});
