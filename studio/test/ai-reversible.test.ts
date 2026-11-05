// Goal: undo restores exactly the source a change replaced, redo restores the
// change, and anything that would overwrite someone else's edit is a conflict.
// Method: build records with reversibleChange from real before/after sources,
// then run revertStep on the result, on sources edited elsewhere, and on
// sources edited inside the changed region; a seeded randomized loop checks
// the round trip for arbitrary edits, and the parser is fed every invalid shape.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_REVERSIBLE_CHARS,
  MAX_REVERSIBLE_FILES,
  parseDirection,
  parseReversibleChanges,
  reversibleChange,
  reversibleChanges,
  revertStep,
  type ReversibleChange,
} from '../src/features/ai/reversible';

const FILE = 'src/pages/index.astro';

function source(step: ReturnType<typeof revertStep>): string | undefined {
  assert.equal(step.kind, 'source');
  return step.kind === 'source' ? step.source : undefined;
}
function roundTrip(previous: string, next: string): ReversibleChange {
  const change = reversibleChange(FILE, previous, next);
  assert.equal(source(revertStep(next, change, 'undo')), previous);
  assert.equal(source(revertStep(previous, change, 'redo')), next);
  return change;
}

test('replacements, insertions and deletions round-trip, including whole and empty files', () => {
  const page = '<h1>Welcome</h1>\n<p>Intro</p>\n<footer>Bye</footer>\n';
  roundTrip(page, page.replace('Welcome', 'Hello there'));
  roundTrip(page, page.replace('<p>Intro</p>\n', '<p>Intro</p>\n<p>More</p>\n'));
  // A pure deletion: the context makes the empty "after" locatable.
  const deletion = roundTrip(page, page.replace('<p>Intro</p>\n', ''));
  assert.notEqual(deletion.after, '');
  roundTrip(page, '');
  roundTrip('', page);
});

test('a created file is removed by undo only while unchanged, and recreated by redo only while absent', () => {
  const change = reversibleChange('src/components/Hero.astro', undefined, '<section>Hero</section>');
  assert.deepEqual(change, { file: 'src/components/Hero.astro', before: '', after: '<section>Hero</section>', created: true });
  assert.deepEqual(revertStep('<section>Hero</section>', change, 'undo'), { kind: 'source', source: undefined });
  assert.deepEqual(revertStep('<section>Hero!</section>', change, 'undo'), { kind: 'conflict' });
  assert.deepEqual(revertStep(undefined, change, 'redo'), { kind: 'source', source: '<section>Hero</section>' });
  assert.deepEqual(revertStep('', change, 'redo'), { kind: 'conflict' });
});

test('edits elsewhere in the file survive undo and redo; edits inside the region conflict', () => {
  const page = '<header>Top</header>\n' + '<p>filler</p>\n'.repeat(20) + '<h1>Welcome</h1>\n' + '<p>filler</p>\n'.repeat(20) + '<footer>Bye</footer>\n';
  const next = page.replace('Welcome', 'Hello');
  const change = reversibleChange(FILE, page, next);
  const edited = next.replace('Top', 'Masthead').replace('Bye', 'See you');
  assert.equal(source(revertStep(edited, change, 'undo')), page.replace('Top', 'Masthead').replace('Bye', 'See you'));
  assert.deepEqual(revertStep(next.replace('Hello', 'Howdy'), change, 'undo'), { kind: 'conflict' });
  assert.deepEqual(revertStep(undefined, change, 'undo'), { kind: 'conflict' });
  // Redo needs the original region, which undo restored; applying it twice is a conflict.
  assert.deepEqual(revertStep(next, change, 'redo'), { kind: 'conflict' });
});

test('context grows until the region is unique in a repetitive file', () => {
  const page = Array.from({ length: 200 }, (_, i) => `<li>item</li>${i === 150 ? '<b>x</b>' : ''}\n`).join('');
  const change = roundTrip(page, page.replace('<b>x</b>', '<b>y</b>'));
  assert.ok(change.before.length < page.length, 'the region stays smaller than the file');
  // A duplicate of the region elsewhere makes it ambiguous, so undo refuses.
  const next = page.replace('<b>x</b>', '<b>y</b>');
  assert.deepEqual(revertStep(next + change.after, change, 'undo'), { kind: 'conflict' });
});

test('arbitrary edits round-trip (seeded)', () => {
  let seed = 7;
  const random = (limit: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % limit;
  };
  const alphabet = 'ab<>/ \n';
  const text = (length: number) => Array.from({ length }, () => alphabet[random(alphabet.length)]).join('');
  for (let iteration = 0; iteration < 500; iteration++) {
    const previous = text(random(200));
    const start = random(previous.length + 1);
    const end = start + random(previous.length - start + 1);
    roundTrip(previous, previous.slice(0, start) + text(random(20)) + previous.slice(end));
  }
});

test('records are bounded, and the parser rejects every invalid shape', () => {
  const change = { file: FILE, before: '<h1>A</h1>', after: '<h1>B</h1>', created: false };
  assert.deepEqual(parseReversibleChanges([change]), [change]);
  assert.equal(parseDirection('undo'), 'undo');
  assert.throws(() => parseDirection('apply'));
  const many = Array.from({ length: MAX_REVERSIBLE_FILES + 1 }, (_, i) => ({ ...change, file: `src/pages/p${i}.astro` }));
  assert.equal(reversibleChanges(many), undefined);
  assert.equal(reversibleChanges([{ ...change, after: 'x'.repeat(MAX_REVERSIBLE_CHARS) }]), undefined);
  for (const value of [
    undefined,
    [],
    {},
    [change, change],
    many,
    [{ ...change, file: '../secret.astro' }],
    [{ ...change, file: 'src/pages/image.png' }],
    [{ ...change, created: 'yes' }],
    [{ ...change, before: 1 }],
    [{ ...change, after: 'x'.repeat(MAX_REVERSIBLE_CHARS) }],
  ]) {
    assert.throws(() => parseReversibleChanges(value), JSON.stringify(value)?.slice(0, 80));
  }
});
