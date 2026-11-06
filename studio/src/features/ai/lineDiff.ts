import { assert } from '../../../vendor/stacki/shared/core/assert';
import { record, sourcePath, string } from '../../shared/validation';

// Line diffs of proposed changes, for reading in the chat. A proposal is a
// substring edit, so the model's `before` and `after` show neither the lines
// around the change nor where it sits in the file; the server knows each file's
// whole old and new source and sends this compact diff with the proposal
// instead: per file, the added and removed counts, and the changed hunks with
// a little context, the way `git diff` shows them.
//
// Everything is bounded. The common head and tail of the two sources are
// trimmed first, so the usual small edit diffs only its changed lines; the
// middle runs through Myers' algorithm with a cap on edits and lines, and a
// change past the cap shows as the whole middle removed and re-added. The
// hunks are capped per file and per proposal, since they travel in the reply
// and are stored with the chat in the browser.

/** A hunk line starts with ' ' (context), '+' (added), '-' (removed) or '\' (a note, as in `git diff`). */
export type DiffLine = string;
export interface DiffHunk {
  /** 1-based line where the hunk starts in the old source; 0 when the hunk starts in an empty old source. */
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly DiffLine[];
}
export type FileDiff =
  | {
      readonly kind: 'changed';
      readonly file: string;
      readonly created: boolean;
      readonly added: number;
      readonly removed: number;
      readonly hunks: readonly DiffHunk[];
      /** Diff lines left out by the caps. */
      readonly omitted: number;
    }
  /** The change can't be applied as proposed, for example because its `before` is no longer in the file. */
  | { readonly kind: 'failed'; readonly file: string; readonly message: string };
export interface DiffSource {
  readonly file: string;
  /** Undefined when the change creates the file. */
  readonly previous: string | undefined;
  readonly next: string;
}

export const DIFF_LIMITS = {
  contextLines: 3,
  /** Myers' work grows with lines times edits; past either bound the middle is shown replaced whole. */
  editsMax: 1000,
  middleLinesMax: 20_000,
  fileLinesMax: 200,
  totalLinesMax: 1000,
  lineCharsMax: 300,
  filesMax: 20,
  messageCharsMax: 300,
} as const satisfies Record<string, number>;

export const NO_FINAL_NEWLINE = '\\ No newline at end of file';

/** The diffs of a proposal's files, in order, sharing one line budget. */
export function proposalDiffs(sources: readonly (DiffSource | { readonly file: string; readonly failure: string })[]): readonly FileDiff[] {
  assert(sources.length <= DIFF_LIMITS.filesMax, 'proposal diff: too many files');
  let budget: number = DIFF_LIMITS.totalLinesMax;
  const diffs = sources.map((source): FileDiff => {
    if ('failure' in source) {
      return { kind: 'failed', file: source.file, message: source.failure.slice(0, DIFF_LIMITS.messageCharsMax) };
    }
    const diff = fileDiff(source, Math.min(budget, DIFF_LIMITS.fileLinesMax));
    budget -= shownLines(diff);
    return diff;
  });
  assert(budget >= 0, 'proposal diff: line budget overspent');
  return diffs;
}

/** One file's diff, showing at most `linesMax` hunk lines. */
export function fileDiff(source: DiffSource, linesMax: number = DIFF_LIMITS.fileLinesMax): FileDiff & { readonly kind: 'changed' } {
  assert(Number.isSafeInteger(linesMax), 'file diff: line cap must be an integer');
  assert(linesMax >= 0, 'file diff: line cap must not be negative');
  const previous = splitLines(source.previous ?? '');
  const next = splitLines(source.next);
  const operations = diffOperations(previous.keys, next.keys);
  const { hunks, omitted } = buildHunks(operations, previous, next, linesMax);
  let added = 0;
  let removed = 0;
  for (const operation of operations) {
    if (operation === INSERT) {
      added++;
    } else if (operation === DELETE) {
      removed++;
    }
  }
  return { kind: 'changed', file: source.file, created: source.previous === undefined, added, removed, hunks, omitted };
}

export function parseFileDiffs(value: unknown): readonly FileDiff[] {
  if (!Array.isArray(value) || value.length > DIFF_LIMITS.filesMax) {
    throw new Error('Invalid proposal diff');
  }
  let lines = 0;
  const diffs = value.map((item: unknown): FileDiff => {
    const diff = record(item);
    const file = sourcePath(diff['file']);
    if (diff['kind'] === 'failed') {
      return { kind: 'failed', file, message: string(diff['message'], DIFF_LIMITS.messageCharsMax) };
    }
    if (diff['kind'] !== 'changed' || typeof diff['created'] !== 'boolean') {
      throw new Error('Invalid proposal diff');
    }
    const hunks = parseHunks(diff['hunks']);
    lines += hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
    return {
      kind: 'changed',
      file,
      created: diff['created'],
      added: count(diff['added']),
      removed: count(diff['removed']),
      hunks,
      omitted: count(diff['omitted']),
    };
  });
  // Notes ("\ No newline…") may add one line per side beyond the shown budget.
  if (lines > DIFF_LIMITS.totalLinesMax + 2 * value.length) {
    throw new Error('Invalid proposal diff');
  }
  return diffs;
}

/** The hunk lines a diff shows, not counting notes. */
export function shownLines(diff: FileDiff): number {
  if (diff.kind === 'failed') {
    return 0;
  }
  return diff.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => !line.startsWith('\\')).length, 0);
}

// Operations are bytes so a whole file's script stays one small typed array.
const EQUAL = 0;
const INSERT = 1;
const DELETE = 2;
type Operations = Uint8Array;

interface Lines {
  /** Each line's text for display: without its line break, and without a CR before it. */
  readonly texts: readonly string[];
  /** Interned per diff by `keyOf`: equal keys mean equal lines, including the line break. */
  readonly keys: readonly string[];
  readonly finalNewline: boolean;
}

// A line's key keeps its terminator, so a change from CRLF to LF, or a final line
// gaining or losing its newline, still shows as a changed line.
function splitLines(text: string): Lines {
  if (text === '') {
    return { texts: [], keys: [], finalNewline: true };
  }
  const parts = text.split('\n');
  const finalNewline = parts[parts.length - 1] === '';
  if (finalNewline) {
    parts.pop();
  }
  const keys = parts.map((part, index) => (index < parts.length - 1 || finalNewline ? `${part}\n` : part));
  const texts = parts.map((part) => (part.endsWith('\r') ? part.slice(0, -1) : part));
  assert(keys.length === texts.length, 'split lines: keys and texts differ in length');
  return { texts, keys, finalNewline };
}

function diffOperations(previous: readonly string[], next: readonly string[]): Operations {
  let head = 0;
  while (head < previous.length && head < next.length && previous[head] === next[head]) {
    head++;
  }
  let tail = 0;
  while (tail < previous.length - head && tail < next.length - head && previous[previous.length - 1 - tail] === next[next.length - 1 - tail]) {
    tail++;
  }
  const middle = middleOperations(intern(previous.slice(head, previous.length - tail), next.slice(head, next.length - tail)));
  const operations = new Uint8Array(head + middle.length + tail);
  operations.set(middle, head); // The head and tail stay EQUAL (zero).
  assert(countOf(operations, DELETE) + countOf(operations, EQUAL) === previous.length, 'diff: operations must cover the old lines');
  assert(countOf(operations, INSERT) + countOf(operations, EQUAL) === next.length, 'diff: operations must cover the new lines');
  return operations;
}

function intern(previous: readonly string[], next: readonly string[]): { readonly a: Int32Array; readonly b: Int32Array } {
  const ids = new Map<string, number>();
  const idOf = (line: string) => {
    const known = ids.get(line);
    if (known !== undefined) {
      return known;
    }
    ids.set(line, ids.size);
    return ids.size - 1;
  };
  return { a: Int32Array.from(previous, idOf), b: Int32Array.from(next, idOf) };
}

function middleOperations({ a, b }: { readonly a: Int32Array; readonly b: Int32Array }): Operations {
  if (a.length + b.length <= DIFF_LIMITS.middleLinesMax) {
    const script = myers(a, b, Math.min(DIFF_LIMITS.editsMax, a.length + b.length));
    if (script) {
      return script;
    }
  }
  // Too large to diff within the bounds: every old line removed, every new line added.
  const replaced = new Uint8Array(a.length + b.length);
  replaced.fill(DELETE, 0, a.length);
  replaced.fill(INSERT, a.length);
  return replaced;
}

// Myers' O((N+M)·D) greedy algorithm. `trace[d]` keeps the furthest-reaching x per
// diagonal k in [-d-1, d+1] before round d, which is all the backtrack reads, so
// memory is O(D²) for D edits rather than O((N+M)·D).
function myers(a: Int32Array, b: Int32Array, editsMax: number): Operations | undefined {
  assert(editsMax <= a.length + b.length, 'myers: edit cap beyond the possible edits');
  const offset = editsMax + 1;
  const v = new Int32Array(2 * editsMax + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= editsMax; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0)) ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= a.length && y >= b.length) {
        return backtrack(trace, a.length, b.length);
      }
    }
  }
  return undefined;
}

function backtrack(trace: readonly Int32Array[], previousCount: number, nextCount: number): Operations {
  const reversed: number[] = [];
  let x = previousCount;
  let y = nextCount;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    assert(v !== undefined, 'myers: missing trace round');
    const at = (k: number) => v[k + d + 1] ?? 0;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      reversed.push(EQUAL);
      x--;
      y--;
    }
    if (d > 0) {
      reversed.push(x === previousX ? INSERT : DELETE);
      x = previousX;
      y = previousY;
    }
  }
  assert(x === 0, 'myers: backtrack must reach the start of the old lines');
  assert(y === 0, 'myers: backtrack must reach the start of the new lines');
  return Uint8Array.from(reversed.reverse());
}

// Hunks group changes closer than twice the context, as `git diff` does. Lines past
// `linesMax` are counted in `omitted` rather than shown.
function buildHunks(operations: Operations, previous: Lines, next: Lines, linesMax: number): { readonly hunks: DiffHunk[]; readonly omitted: number } {
  const context = DIFF_LIMITS.contextLines;
  const ranges = hunkRanges(operations, context);
  const hunks: DiffHunk[] = [];
  let shown = 0;
  let omitted = 0;
  let oldIndex = 0;
  let newIndex = 0;
  let position = 0;
  for (const [start, end] of ranges) {
    for (; position < start; position++) {
      oldIndex++;
      newIndex++; // Only equal lines lie between hunks.
    }
    const lines: DiffLine[] = [];
    const oldStart = oldIndex;
    const newStart = newIndex;
    for (; position < end; position++) {
      const operation = operations[position];
      assert(operation !== undefined, 'hunks: range beyond the operations');
      if (shown >= linesMax) {
        omitted++;
      } else {
        shown++;
        lines.push(...renderLine(operation, oldIndex, newIndex, previous, next));
      }
      if (operation !== INSERT) {
        oldIndex++;
      }
      if (operation !== DELETE) {
        newIndex++;
      }
    }
    if (lines.length) {
      hunks.push({ oldStart: hunkStart(oldStart, previous), newStart: hunkStart(newStart, next), lines });
    }
  }
  assert(shown <= linesMax, 'hunks: shown lines beyond the cap');
  return { hunks, omitted };
}

function hunkRanges(operations: Operations, context: number): [number, number][] {
  const ranges: [number, number][] = [];
  for (let index = 0; index < operations.length; index++) {
    if (operations[index] === EQUAL) {
      continue;
    }
    const start = Math.max(0, index - context);
    const end = Math.min(operations.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) {
      last[1] = end;
    } else {
      ranges.push([start, end]);
    }
  }
  return ranges;
}

function renderLine(operation: number, oldIndex: number, newIndex: number, previous: Lines, next: Lines): DiffLine[] {
  switch (operation) {
    case EQUAL:
      return withNote(` ${clip(next.texts[newIndex])}`, newIndex === next.texts.length - 1 && !next.finalNewline);
    case INSERT:
      return withNote(`+${clip(next.texts[newIndex])}`, newIndex === next.texts.length - 1 && !next.finalNewline);
    case DELETE:
      return withNote(`-${clip(previous.texts[oldIndex])}`, oldIndex === previous.texts.length - 1 && !previous.finalNewline);
    default:
      throw new Error(`Assertion failed: unknown diff operation ${String(operation)}`);
  }
}

function withNote(line: DiffLine, lastWithoutNewline: boolean): DiffLine[] {
  return lastWithoutNewline ? [line, NO_FINAL_NEWLINE] : [line];
}

function clip(text: string | undefined): string {
  assert(text !== undefined, 'diff: line index beyond the source');
  return text.length > DIFF_LIMITS.lineCharsMax ? `${text.slice(0, DIFF_LIMITS.lineCharsMax)}…` : text;
}

// Like `git diff`, a hunk in an empty source starts at line 0.
function hunkStart(index: number, lines: Lines): number {
  return lines.texts.length ? index + 1 : 0;
}

function countOf(operations: Operations, operation: number): number {
  let total = 0;
  for (const value of operations) {
    if (value === operation) {
      total++;
    }
  }
  return total;
}

function parseHunks(value: unknown): readonly DiffHunk[] {
  if (!Array.isArray(value) || value.length > DIFF_LIMITS.totalLinesMax) {
    throw new Error('Invalid proposal diff');
  }
  return value.map((item: unknown) => {
    const hunk = record(item);
    const lines = hunk['lines'];
    if (!Array.isArray(lines) || !lines.length || lines.length > DIFF_LIMITS.fileLinesMax + 2) {
      throw new Error('Invalid proposal diff');
    }
    return {
      oldStart: count(hunk['oldStart']),
      newStart: count(hunk['newStart']),
      lines: lines.map((line: unknown) => {
        const text = string(line, DIFF_LIMITS.lineCharsMax + 2);
        if (!/^[ +\-\\]/.test(text)) {
          throw new Error('Invalid proposal diff');
        }
        return text;
      }),
    };
  });
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid proposal diff');
  }
  return value;
}
