// Re-applies this fork's cut after an upstream merge: upstream keeps adding
// tests, desktop code and npm lockfiles, and a merge brings them back.
//
//   node tools/prune.mts           list what would go
//   node tools/prune.mts --write   git rm it
//
// What stays: the root sources Studio vendors (studio/scripts/shared-source.json,
// minus the files Studio replaces with adapters or module re-exports), Studio
// itself, and the fork's own tooling and docs.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const git = (...args: readonly string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const inventory: unknown = JSON.parse(readFileSync(path.join(root, 'studio/scripts/shared-source.json'), 'utf8'));
function inventoryPaths(key: 'files' | 'adapters' | 'modules'): ReadonlySet<string> {
  if (typeof inventory !== 'object' || inventory === null || !(key in inventory)) {
    throw new Error(`shared-source.json has no ${key}`);
  }
  const value: unknown = Reflect.get(inventory, key);
  const names = Array.isArray(value) ? value : typeof value === 'object' && value !== null ? Object.keys(value) : [];
  return new Set(names.filter((name): name is string => typeof name === 'string'));
}
const vendored = inventoryPaths('files');
const replaced = new Set([...inventoryPaths('adapters'), ...inventoryPaths('modules')]);

// Whole folders and single files the fork does not keep, with the reason.
const GONE: readonly (readonly [RegExp, string])[] = [
  [/^test\//, 'tests'],
  [/^studio\/test\//, 'tests'],
  [/^scripts\//, 'desktop and gate tooling'],
  [/^(?:resources|services|packages|\.pi|\.codex)\//, 'desktop app, services, create-stacki, agent hooks'],
  [/(?:^|\/)package-lock\.json$/, 'npm lockfile (pnpm-lock.yaml is the lockfile)'],
  [/^(?:index\.html|vite\.config\.mjs|eslint\.config\.mjs|tsconfig\.json)$/, 'desktop build and ESLint config'],
  [/^studio\/eslint\.config\.ts$/, 'ESLint config'],
  [/^(?:shared|electron)\/tsconfig[^/]*\.json$/, 'desktop build config'],
  [/^\.github\/workflows\/(?!check\.yml$)/, 'release workflows'],
  [/^\.claude\/settings\.json$/, 'agent hooks for the deleted gate'],
  // It runs scripts/policy/gitHooks.mts, and as CommonJS it fails under the fork's "type": "module".
  [/^\.githooks\/commit-msg$/, 'commit-msg hook for the deleted gate'],
  [/^docs\/(?:enforcement|releases|create-stacki|desktop-runtime|build-failure-audit|file-limit-proposal)\.md$/, 'docs for removed tooling'],
  [/^docs\/archive\//, 'docs for removed tooling'],
  [/^studio\/docs\/releases\.md$/, 'docs for removed tooling'],
];

function reason(file: string): string | undefined {
  if (/^(?:src|shared|electron)\//.test(file)) {
    if (!vendored.has(file)) {
      return 'desktop-only source';
    }
    return replaced.has(file) ? 'replaced in Studio by an adapter or module' : undefined;
  }
  // The dev site keeps its own npm lockfile: Studio installs it with npm ci.
  if (file.startsWith('studio/dev-site/')) {
    return undefined;
  }
  return GONE.find(([pattern]) => pattern.test(file))?.[1];
}

const tracked = git('ls-files', '-z')
  .split('\0')
  .filter((file) => file.length > 0);
const doomed = tracked.flatMap((file) => {
  const why = reason(file);
  return why === undefined ? [] : [{ file, why }];
});
const counts = new Map<string, number>();
for (const { why } of doomed) {
  counts.set(why, (counts.get(why) ?? 0) + 1);
}
for (const [why, count] of counts) {
  console.log(`${String(count).padStart(5)}  ${why}`);
}
if (doomed.length === 0) {
  console.log('Nothing to prune.');
} else if (process.argv.includes('--write')) {
  const files = doomed.map(({ file }) => file);
  const BATCH = 500;
  for (let start = 0; start < files.length; start += BATCH) {
    git('rm', '-q', '--', ...files.slice(start, start + BATCH));
  }
  console.log(`Removed ${files.length} files.`);
} else {
  console.log(`${doomed.length} files would go; run with --write to remove them.`);
}
