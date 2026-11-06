// Goal: `@` in the composer finds the mention being typed at the caret, offers matching files with
// names that start with the text first, and inserts the chosen path cleanly.
// Method: the pure helpers run on drafts with the caret before, inside and after mentions, on
// addresses that aren't mentions, and on more matches than the list shows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertMention, MENTION_LIMITS, mentionOptions, mentionQuery } from '../src/features/ai/mentions';

const FILES = [
  'src/pages/index.astro',
  'src/components/Hero.astro',
  'src/components/HeroBanner.astro',
  'src/layouts/Base.astro',
  'src/components/SuperHero.astro',
];

test('a mention is an @ at the start or after a space, up to the caret', () => {
  assert.deepEqual(mentionQuery('@her', 4), { start: 0, text: 'her' });
  assert.deepEqual(mentionQuery('Make @src/comp bigger', 14), { start: 5, text: 'src/comp' });
  assert.deepEqual(mentionQuery('Make @', 6), { start: 5, text: '' });
  assert.equal(mentionQuery('mail me@example.com', 19), undefined, 'an @ inside a word is not a mention');
  assert.equal(mentionQuery('@hero done', 10), undefined, 'the caret has left the mention');
  assert.equal(mentionQuery(`@${'x'.repeat(MENTION_LIMITS.queryCharsMax + 1)}`, MENTION_LIMITS.queryCharsMax + 2), undefined);
});

test('names that start with the text come first, and the list is bounded', () => {
  assert.deepEqual(mentionOptions(FILES, 'hero'), ['src/components/Hero.astro', 'src/components/HeroBanner.astro', 'src/components/SuperHero.astro']);
  assert.deepEqual(mentionOptions(FILES, 'layouts/'), ['src/layouts/Base.astro']);
  const many = Array.from({ length: 30 }, (_, index) => `src/pages/p${index}.astro`);
  assert.equal(mentionOptions(many, '').length, MENTION_LIMITS.optionsMax);
});

test('choosing a file replaces the typed text and leaves the caret after it', () => {
  const draft = 'Make @her bigger';
  const query = mentionQuery(draft, 9);
  assert.ok(query);
  assert.deepEqual(insertMention(draft, query, 'src/components/Hero.astro'), { draft: 'Make @src/components/Hero.astro bigger', caret: 32 });
  const end = mentionQuery('See @ind', 8);
  assert.ok(end);
  assert.deepEqual(insertMention('See @ind', end, 'src/pages/index.astro'), { draft: 'See @src/pages/index.astro ', caret: 27 });
});
