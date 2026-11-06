// Goal: the chat's line diff of a proposed change reads like `git diff` (hunks with
// three lines of context, 1-based starts, "\ No newline at end of file" notes), is
// minimal, and never grows past its caps.
// Method: exact hunks for small hand-written sources, including CRLF, a missing
// final newline, created and emptied files; a seeded randomized loop compares the
// added and removed counts with a brute-force longest common subsequence, which
// any minimal line diff must match; oversized inputs check the caps and the
// whole-middle fallback; the parser is fed the server's output and invalid shapes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIFF_LIMITS, NO_FINAL_NEWLINE, fileDiff, parseFileDiffs, proposalDiffs, shownLines } from '../src/features/ai/lineDiff';

const FILE = 'src/pages/index.astro';
const lines = (count: number, prefix = 'line') => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join('');

test('a one-line change shows three lines of context on each side', () => {
  const previous = lines(10);
  const diff = fileDiff({ file: FILE, previous, next: previous.replace('line 5\n', 'line five\n') });
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.created, false);
  assert.deepEqual(diff.hunks, [
    { oldStart: 2, newStart: 2, lines: [' line 2', ' line 3', ' line 4', '-line 5', '+line five', ' line 6', ' line 7', ' line 8'] },
  ]);
});

test('changes far apart become separate hunks, and close ones merge', () => {
  const previous = lines(30);
  const apart = fileDiff({ file: FILE, previous, next: previous.replace('line 2\n', '').replace('line 25\n', 'line 25\nadded\n') });
  assert.deepEqual(
    apart.hunks.map((hunk) => [hunk.oldStart, hunk.newStart, hunk.lines.length]),
    [
      [1, 1, 5],
      [23, 22, 7],
    ],
  );
  const close = fileDiff({ file: FILE, previous, next: previous.replace('line 10\n', 'ten\n').replace('line 16\n', 'sixteen\n') });
  assert.equal(close.hunks.length, 1);
});

test('created, emptied and unchanged files', () => {
  const created = fileDiff({ file: FILE, previous: undefined, next: 'a\nb\n' });
  assert.equal(created.created, true);
  assert.deepEqual(created.hunks, [{ oldStart: 0, newStart: 1, lines: ['+a', '+b'] }]);
  const emptied = fileDiff({ file: FILE, previous: 'a\nb\n', next: '' });
  assert.deepEqual(emptied.hunks, [{ oldStart: 1, newStart: 0, lines: ['-a', '-b'] }]);
  assert.equal(emptied.removed, 2);
  const createdEmpty = fileDiff({ file: FILE, previous: undefined, next: '' });
  assert.deepEqual([createdEmpty.added, createdEmpty.removed, createdEmpty.hunks.length], [0, 0, 0]);
  const same = fileDiff({ file: FILE, previous: 'a\n', next: 'a\n' });
  assert.deepEqual([same.added, same.removed, same.hunks.length], [0, 0, 0]);
});

test('a missing final newline is a change of the last line, with a note', () => {
  const gained = fileDiff({ file: FILE, previous: 'a\nb', next: 'a\nb\n' });
  assert.deepEqual(gained.hunks, [{ oldStart: 1, newStart: 1, lines: [' a', '-b', NO_FINAL_NEWLINE, '+b'] }]);
  const appended = fileDiff({ file: FILE, previous: 'a\n', next: 'a\nb' });
  assert.deepEqual(appended.hunks, [{ oldStart: 1, newStart: 1, lines: [' a', '+b', NO_FINAL_NEWLINE] }]);
  const context = fileDiff({ file: FILE, previous: 'a\nb', next: 'z\nb' });
  assert.deepEqual(context.hunks[0]?.lines, ['-a', '+z', ' b', NO_FINAL_NEWLINE]);
});

test('CRLF lines show without the CR, and a line-ending change still shows', () => {
  const crlf = fileDiff({ file: FILE, previous: 'a\r\nb\r\nc\r\n', next: 'a\r\nB\r\nc\r\n' });
  assert.deepEqual(crlf.hunks[0]?.lines, [' a', '-b', '+B', ' c']);
  const endings = fileDiff({ file: FILE, previous: 'a\r\n', next: 'a\n' });
  assert.deepEqual(endings.hunks[0]?.lines, ['-a', '+a']);
});

test('the counts match a minimal diff on random edits', () => {
  let seed = 7;
  const random = (limit: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % limit;
  };
  const pick = () => 'abcdef'[random(6)] ?? 'a';
  for (let round = 0; round < 300; round++) {
    const previous = Array.from({ length: random(25) }, pick);
    const next = [...previous];
    for (let edit = random(8); edit > 0; edit--) {
      const at = random(next.length + 1);
      if (random(2) && next.length) {
        next.splice(Math.min(at, next.length - 1), 1);
      } else {
        next.splice(at, 0, pick());
      }
    }
    const diff = fileDiff({ file: FILE, previous: previous.map((line) => `${line}\n`).join(''), next: next.map((line) => `${line}\n`).join('') });
    const common = longestCommonSubsequence(previous, next);
    assert.equal(diff.removed, previous.length - common, `round ${round}`);
    assert.equal(diff.added, next.length - common, `round ${round}`);
    const shown = diff.hunks.flatMap((hunk) => hunk.lines);
    assert.equal(shown.filter((line) => line.startsWith('+')).length, diff.added);
    assert.equal(shown.filter((line) => line.startsWith('-')).length, diff.removed);
  }
});

test('caps: lines per file, per proposal, line length, and the replaced-middle fallback', () => {
  const big = fileDiff({ file: FILE, previous: '', next: lines(500) });
  assert.equal(shownLines(big), DIFF_LIMITS.fileLinesMax);
  assert.equal(big.omitted, 500 - DIFF_LIMITS.fileLinesMax);
  assert.equal(big.added, 500);
  const files = Array.from({ length: 8 }, (_, index) => ({ file: `src/pages/p${index}.astro`, previous: '', next: lines(300) }));
  const diffs = proposalDiffs(files);
  assert.equal(
    diffs.reduce((total, diff) => total + shownLines(diff), 0),
    DIFF_LIMITS.totalLinesMax,
  );
  assert.equal(shownLines(diffs[7] ?? big), 0);
  const long = fileDiff({ file: FILE, previous: '', next: `${'x'.repeat(5000)}\n` });
  assert.equal(long.hunks[0]?.lines[0]?.length, DIFF_LIMITS.lineCharsMax + 2);
  // Every line differs and there are more edits than the cap: the middle shows replaced whole.
  const rewritten = fileDiff({ file: FILE, previous: lines(800, 'old'), next: lines(800, 'new') });
  assert.deepEqual([rewritten.removed, rewritten.added], [800, 800]);
  assert.throws(() => fileDiff({ file: FILE, previous: '', next: '' }, -1), /Assertion failed/);
});

test('failed files carry their reason, and the parser accepts what the server sends', () => {
  const diffs = proposalDiffs([
    { file: FILE, previous: 'a\n', next: 'b\n' },
    { file: 'src/components/Hero.astro', failure: 'AI change is stale or ambiguous. Ask it to regenerate.' },
  ]);
  assert.equal(diffs[1]?.kind, 'failed');
  assert.deepEqual(parseFileDiffs(JSON.parse(JSON.stringify(diffs))), diffs);
});

test('the parser rejects invalid shapes', () => {
  const valid = { kind: 'changed', file: FILE, created: false, added: 1, removed: 0, omitted: 0, hunks: [{ oldStart: 1, newStart: 1, lines: ['+a'] }] };
  assert.equal(parseFileDiffs([valid]).length, 1);
  for (const invalid of [
    'diff',
    [{ ...valid, kind: 'other' }],
    [{ ...valid, file: '../secret.astro' }],
    [{ ...valid, created: 'no' }],
    [{ ...valid, added: -1 }],
    [{ ...valid, removed: 1.5 }],
    [{ ...valid, hunks: [{ oldStart: 1, newStart: 1, lines: [] }] }],
    [{ ...valid, hunks: [{ oldStart: 1, newStart: 1, lines: ['a'] }] }],
    [{ ...valid, hunks: [{ oldStart: 1, newStart: 1, lines: [`+${'x'.repeat(DIFF_LIMITS.lineCharsMax + 5)}`] }] }],
    [{ kind: 'failed', file: FILE, message: 'x'.repeat(DIFF_LIMITS.messageCharsMax + 1) }],
    Array.from({ length: DIFF_LIMITS.filesMax + 1 }, () => valid),
  ]) {
    assert.throws(() => parseFileDiffs(invalid), /Invalid|Expected object|Unsupported/);
  }
});

function longestCommonSubsequence(previous: readonly string[], next: readonly string[]): number {
  const table = Array.from({ length: previous.length + 1 }, () => new Array<number>(next.length + 1).fill(0));
  for (let i = previous.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      const row = table[i] ?? [];
      row[j] = previous[i] === next[j] ? (table[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  return table[0]?.[0] ?? 0;
}
