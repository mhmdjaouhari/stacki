import { record, sourcePath, string, textChange, MAX_SOURCE } from '../../shared/validation';

// Undo and redo of an applied AI change. Applying records, per file, the
// smallest changed region plus just enough unchanged context around it to be
// unique in both the old and the new source. Undo swaps that region back and
// redo swaps it forward, so unrelated edits elsewhere in the file don't block
// either; a region that is missing or no longer unique is a conflict, and a
// conflict in any file leaves every file untouched.
//
// Storing regions rather than whole files keeps the record small enough to
// travel back in one Studio request, and makes pure deletions reversible: the
// context makes an empty "after" locatable.

export interface ReversibleChange {
  readonly file: string;
  readonly before: string;
  readonly after: string;
  /** The change created the file; undo removes it again. */
  readonly created: boolean;
}
export type Direction = 'undo' | 'redo';
/** `source` undefined means the file is removed. */
export type RevertStep = { readonly kind: 'source'; readonly source: string | undefined } | { readonly kind: 'conflict' };

export const MAX_REVERSIBLE_FILES = 20;
// A Studio request carries at most MAX_SOURCE + 1000 bytes; JSON escaping and
// the file names need the rest.
export const MAX_REVERSIBLE_CHARS = 800_000;
const FIRST_CONTEXT = 32;

/** The reversible record of one file's change, from its source before and after. */
export function reversibleChange(file: string, previous: string | undefined, next: string): ReversibleChange {
  if (previous === undefined) {
    return { file, before: '', after: next, created: true };
  }
  const { start, remove, insert } = textChange(previous, next);
  const end = start + remove;
  // Doubling the context reaches the whole file within log2(MAX_SOURCE) steps.
  for (let context = FIRST_CONTEXT; ; context *= 2) {
    const from = Math.max(0, start - context);
    const before = previous.slice(from, end + context);
    const after = previous.slice(from, start) + insert + previous.slice(end, end + context);
    const whole = from === 0 && end + context >= previous.length;
    if (whole || (unique(previous, before) && unique(next, after))) {
      return { file, before, after, created: false };
    }
  }
}

/** Records for every changed file, or undefined when they are too large to send back. */
export function reversibleChanges(changes: readonly ReversibleChange[]): readonly ReversibleChange[] | undefined {
  const size = changes.reduce((total, change) => total + change.before.length + change.after.length + change.file.length, 0);
  return changes.length <= MAX_REVERSIBLE_FILES && size <= MAX_REVERSIBLE_CHARS ? changes : undefined;
}

/** The file's source after undoing or redoing `change`, given its current source. */
export function revertStep(current: string | undefined, change: ReversibleChange, direction: Direction): RevertStep {
  if (change.created) {
    if (direction === 'undo') {
      return current === change.after ? { kind: 'source', source: undefined } : { kind: 'conflict' };
    }
    return current === undefined ? { kind: 'source', source: change.after } : { kind: 'conflict' };
  }
  if (current === undefined) {
    return { kind: 'conflict' };
  }
  const [from, to] = direction === 'undo' ? [change.after, change.before] : [change.before, change.after];
  // An empty region only arises for a whole file that was empty; then the whole file must match.
  if (from === '') {
    return current === '' ? { kind: 'source', source: to } : { kind: 'conflict' };
  }
  return unique(current, from) ? { kind: 'source', source: current.replace(from, () => to) } : { kind: 'conflict' };
}

export function parseDirection(value: unknown): Direction {
  if (value !== 'undo' && value !== 'redo') {
    throw new Error('Invalid direction');
  }
  return value;
}

export function parseReversibleChanges(value: unknown): readonly ReversibleChange[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_REVERSIBLE_FILES) {
    throw new Error('Invalid change record');
  }
  const changes = value.map((item: unknown) => {
    const change = record(item);
    const created = change['created'];
    if (typeof created !== 'boolean') {
      throw new Error('Invalid change record');
    }
    return { file: sourcePath(change['file']), before: string(change['before'], MAX_SOURCE), after: string(change['after'], MAX_SOURCE), created };
  });
  if (new Set(changes.map((change) => change.file)).size !== changes.length || !reversibleChanges(changes)) {
    throw new Error('Invalid change record');
  }
  return changes;
}

function unique(text: string, part: string): boolean {
  const first = text.indexOf(part);
  return first !== -1 && first === text.lastIndexOf(part);
}
