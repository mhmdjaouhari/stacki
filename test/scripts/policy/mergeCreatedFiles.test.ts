// Goal: a merge commit's pre-commit checks only the files the merge created, and an ordinary commit is untouched.
// Method: a scratch repository merges a branch that changes two files while the base changes a third and one of
// the same two; the combined file is the only one the merge created, and outside a merge the answer is absent.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mergeCreatedFiles, stagedFiles } from '../../../scripts/policy/checks.mts';

function git(root: string, ...argumentsList: readonly string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...argumentsList], { cwd: root, stdio: 'ignore' });
}

function commitFiles(root: string, files: Readonly<Record<string, string>>, message: string): void {
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(root, name), text);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', message);
}

test('a merge checks the files it combined, not the ones it took whole from either side', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'stacki-merge-created-'));
  try {
    git(root, 'init', '-q', '-b', 'main');
    commitFiles(root, { 'combined.ts': 'one\ntwo\nthree\nfour\nfive\n', 'theirs.ts': 'base\n', 'ours.ts': 'base\n' }, 'base');
    git(root, 'switch', '-q', '-c', 'upstream');
    commitFiles(root, { 'combined.ts': 'one\ntwo\nthree\nfour\nFIVE\n', 'theirs.ts': 'upstream\n' }, 'upstream');
    git(root, 'switch', '-q', 'main');
    commitFiles(root, { 'combined.ts': 'ONE\ntwo\nthree\nfour\nfive\n', 'ours.ts': 'fork\n' }, 'fork');
    assert.equal(mergeCreatedFiles(root, stagedFiles(root)), undefined, 'no merge, no narrowing');
    git(root, 'merge', '-q', '--no-commit', 'upstream');
    const staged = stagedFiles(root);
    assert.deepEqual([...staged].sort(), ['combined.ts', 'theirs.ts']);
    assert.deepEqual(mergeCreatedFiles(root, staged), ['combined.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
