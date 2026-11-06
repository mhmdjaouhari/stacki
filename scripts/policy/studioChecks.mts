// Route the hosted package through its own compiler and strict lint rules.
// Direct Node invocations also work on Windows without spawning npm.cmd.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChild, type ChildResult } from './child.mts';

export function studioAffected(files: readonly string[]): boolean {
  return files.some((file) => /^(studio|src|shared|electron)\//.test(file));
}

export function checkStudio(root: string, format: 'write' | 'check'): ChildResult {
  return runChild(process.execPath, [fileURLToPath(import.meta.url), `--${format}`], {
    cwd: root,
  });
}

function verifyStudio(root: string): number {
  const cwd = path.join(root, 'studio');
  const dependency = (file: string): string => path.join(cwd, 'node_modules', file);
  const tsx = dependency('tsx/dist/cli.mjs');
  const compiler = dependency('typescript/bin/tsc');
  // Each tool keeps what it learned between runs, as the root gate's type check
  // and Prettier do (scripts/gate/runTests.ts): cold, the studio program alone
  // took a minute and its lint another, on every commit that touched src/.
  // tsc re-checks every file whose text or dependencies changed, so a warm run
  // reaches a cold one's verdict. Prettier and ESLint key on content, not
  // modification times, because assemble rewrites vendor/ and a checkout
  // rewrites times without changing a byte. CI starts without these caches.
  const cache = dependency('.cache/studio-checks');
  const incremental = (name: string): readonly string[] => ['--incremental', '--tsBuildInfoFile', path.join(cache, `${name}.tsbuildinfo`)];
  const commands: readonly (readonly string[])[] = [
    [tsx, 'scripts/assemble.ts'],
    [compiler, '--noEmit', ...incremental('studio')],
    [compiler, '-p', 'tsconfig.worker.json', ...incremental('worker')],
    [
      dependency('eslint/bin/eslint.js'),
      '--cache',
      '--cache-strategy',
      'content',
      '--cache-location',
      path.join(cache, 'eslint') + path.sep,
      '--max-warnings',
      '0',
      '.',
    ],
    [
      dependency('prettier/bin/prettier.cjs'),
      process.argv.includes('--write') ? '--write' : '--check',
      '--cache',
      '--cache-strategy',
      'content',
      '--cache-location',
      path.join(cache, 'prettier.json'),
      '.',
    ],
  ];
  const suites = fs
    .readdirSync(path.join(cwd, 'test'))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `test/${name}`);
  const full = process.argv.includes('--full')
    ? [
        [tsx, '--test', ...suites],
        [tsx, 'scripts/build.ts'],
      ]
    : [];
  for (const argumentsList of [...commands, ...full]) {
    const result = runChild(process.execPath, argumentsList, { cwd });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status !== 0) {
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = verifyStudio(path.resolve(import.meta.dirname, '../..'));
}
