import { fileDiff, NO_FINAL_NEWLINE, type DiffHunk, type FileDiff } from './lineDiff';
import type { ProposedChange } from './agent';

// The compact diff under a proposal, sized for the chat sidebar: one row per file
// with its +/− counts, and the changed hunks inline. The hunks flow in the message
// and long lines wrap, so nothing scrolls inside the transcript's own scroll.

type LineNumbers = 'file' | 'none';

// `numbers` is 'none' for diffs of bare substrings, whose line numbers aren't the file's.
export function ChatDiff({ diffs, numbers }: { readonly diffs: readonly FileDiff[]; readonly numbers: LineNumbers }) {
  return (
    <div className={numbers === 'none' ? 'chat-diff is-unnumbered' : 'chat-diff'}>
      {diffs.map((diff, index) => (
        <FileSection key={diff.file} diff={diff} open={index === 0} />
      ))}
    </div>
  );
}

/** Diffs for a proposal saved before the server sent them: its substrings, without the file around them. */
export function substringDiffs(changes: readonly ProposedChange[]): readonly FileDiff[] {
  return changes.map((change) => fileDiff({ file: change.file, previous: change.before === '' ? undefined : change.before, next: change.after }));
}

export function diffTotals(diffs: readonly FileDiff[]): { readonly added: number; readonly removed: number } {
  let added = 0;
  let removed = 0;
  for (const diff of diffs) {
    if (diff.kind === 'changed') {
      added += diff.added;
      removed += diff.removed;
    }
  }
  return { added, removed };
}

export function DiffCounts({ added, removed }: { readonly added: number; readonly removed: number }) {
  return (
    <span className="chat-diff-counts" aria-label={`${added} added, ${removed} removed`}>
      <span className="is-added">+{added}</span> <span className="is-removed">−{removed}</span>
    </span>
  );
}

function FileSection({ diff, open }: { readonly diff: FileDiff; readonly open: boolean }) {
  const name = diff.file.replace(/^src\//, '');
  if (diff.kind === 'failed') {
    return (
      <div className="chat-diff-file is-failed">
        <div className="chat-diff-summary">
          <span className="chat-diff-name">{name}</span>
          <span className="chat-diff-failure">Can't apply</span>
        </div>
        <p className="chat-diff-message">{diff.message}</p>
      </div>
    );
  }
  return (
    <details className="chat-diff-file" open={open}>
      <summary className="chat-diff-summary">
        <span className="chat-diff-name" title={diff.file}>
          {name}
        </span>
        {diff.created && <span className="chat-diff-badge">new</span>}
        <DiffCounts added={diff.added} removed={diff.removed} />
      </summary>
      {diff.hunks.map((hunk) => (
        <Hunk key={`${hunk.oldStart}:${hunk.newStart}`} hunk={hunk} />
      ))}
      {diff.omitted > 0 && (
        <p className="chat-diff-message">
          {diff.omitted} more line{diff.omitted === 1 ? '' : 's'} not shown
        </p>
      )}
      {!diff.hunks.length && <p className="chat-diff-message">No line changes</p>}
    </details>
  );
}

// One number column: the new line number, or the old one for a removed line. Two
// columns would take a sixth of the narrow pane.
function Hunk({ hunk }: { readonly hunk: DiffHunk }) {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return (
    <div className="chat-diff-hunk" role="table" aria-label={`Lines from ${hunk.newStart}`}>
      {hunk.lines.map((line, index) => {
        const marker = line.charAt(0);
        const text = line.slice(1);
        if (line === NO_FINAL_NEWLINE) {
          return (
            <div key={index} className="chat-diff-line is-note" role="row">
              <span role="cell" />
              <code role="cell">No newline at end of file</code>
            </div>
          );
        }
        const kind = marker === '+' ? 'is-added' : marker === '-' ? 'is-removed' : 'is-context';
        const number = marker === '-' ? oldLine : newLine;
        if (marker !== '+') {
          oldLine++;
        }
        if (marker !== '-') {
          newLine++;
        }
        return (
          <div key={index} className={`chat-diff-line ${kind}`} role="row">
            <span role="cell" className="chat-diff-number" data-marker={marker === ' ' ? '' : marker}>
              {number}
            </span>
            <code role="cell">{text || ' '}</code>
          </div>
        );
      })}
    </div>
  );
}
