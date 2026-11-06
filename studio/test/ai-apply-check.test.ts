// Goal: after an AI change is applied, the pages it can affect are rendered again; a page it broke
// is reported with its error and doesn't count when it was already broken; the rendered text that
// changed is the evidence of what the change did; and the error behind a failed render is read
// from the dev server's HMR payload.
// Method: the pure helpers run on stand-in page responses (working, a 500, Astro's error overlay,
// a request that throws) and on HMR payloads, valid and not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { affectedPages, APPLY_CHECK_LIMITS, brokenPages, renderedChanges, renderPages, type PageResponse } from '../src/features/ai/applyCheck';
import { describeDevError, devError } from '../src/features/ai/devErrors';

test('the canvas page and each changed page with a fixed route are checked, bounded', () => {
  assert.deepEqual(affectedPages(['src/components/Hero.astro', 'src/pages/index.astro', 'src/pages/about.md', 'src/pages/blog/[slug].astro'], '/blog/hello'), [
    '/blog/hello',
    '/',
    '/about',
  ]);
  assert.deepEqual(affectedPages(['src/pages/docs/index.astro'], undefined), ['/docs']);
  const many = Array.from({ length: 9 }, (_, index) => `src/pages/p${index}.astro`);
  assert.equal(affectedPages(many, '/').length, APPLY_CHECK_LIMITS.pagesMax);
});

test('a page that rendered before and fails after is broken; one that failed already is not', async () => {
  const responses: Record<string, PageResponse | Error> = {
    '/': { status: 200, html: '<h1>Home</h1>' },
    '/about': { status: 200, html: '<h1>About</h1>' },
    '/old': { status: 500, html: '<title>Error</title>' },
  };
  const fetchFrom = (table: Record<string, PageResponse | Error>) => (path: string) => {
    const response = table[path];
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response ?? { status: 404, html: '' });
  };
  const before = await renderPages(['/', '/about', '/old'], fetchFrom(responses));
  const after = await renderPages(
    ['/', '/about', '/old'],
    fetchFrom({
      '/': { status: 500, html: '<title>ReferenceError</title>', error: 'Missing is not defined (src/pages/index.astro:14)' },
      '/about': { status: 200, html: '<vite-error-overlay></vite-error-overlay><title>SyntaxError</title>' },
      '/old': new Error('fetch failed'),
    }),
  );
  assert.deepEqual(brokenPages(before, after), [
    { path: '/', error: 'Status 500: ReferenceError: Missing is not defined (src/pages/index.astro:14)' },
    { path: '/about', error: 'Status 200: SyntaxError' },
  ]);
});

test('the rendered text that changed is listed per page', async () => {
  const before = await renderPages(['/'], () => Promise.resolve({ status: 200, html: '<h1>Welcome</h1><p>Intro</p>' }));
  const after = await renderPages(['/'], () => Promise.resolve({ status: 200, html: '<h1>Hello</h1><p>Intro</p>' }));
  assert.deepEqual(renderedChanges(before, after), [{ path: '/', added: 1, removed: 1, lines: ['-h1: Welcome', '+h1: Hello'] }]);
  assert.deepEqual(renderedChanges(before, before), []);
});

test("Astro's HMR error payload gives the message, file and line", () => {
  const error = devError({
    type: 'error',
    err: { message: '\u001b[31mMissing is not defined\u001b[39m', loc: { file: '/site/src/pages/index.astro', line: 14 } },
  });
  assert.ok(error);
  assert.equal(describeDevError(error, '/site'), 'Missing is not defined (src/pages/index.astro:14)');
  assert.equal(describeDevError({ message: 'Boom', atMs: 0 }, '/site'), 'Boom');
  for (const payload of [undefined, { type: 'update' }, { type: 'error' }, { type: 'error', err: { message: '' } }, 'error']) {
    assert.equal(devError(payload), undefined, JSON.stringify(payload));
  }
});
