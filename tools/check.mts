// The repository's checks, in one place: the git hooks, CI and people run this.
//
//   node tools/check.mts            format, lint, types, then the Studio build
//   node tools/check.mts lint       one step: format | lint | types | build
//   node tools/check.mts --staged   format and lint only the staged files, then types
//
// Studio's assemble step copies the root sources into studio/vendor/stacki, the
// one program they type-check in (oxlint.config.ts says why), so it runs first;
// format, lint and types then run side by side.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const studio = path.join(root, 'studio');
const vendor = 'studio/vendor/stacki';
const bin = (name: string): string => path.join(root, 'node_modules/.bin', name);
const tsc = path.join(studio, 'node_modules/@typescript/native/bin/tsc');
const tsx = path.join(studio, 'node_modules/.bin/tsx');

type Step = 'format' | 'lint' | 'types' | 'build';
const STEPS: readonly Step[] = ['format', 'lint', 'types', 'build'];

interface Outcome {
  readonly step: string;
  readonly status: number;
  readonly output: string;
  readonly seconds: number;
}

function run(step: string, command: string, args: readonly string[], cwd = root): Promise<Outcome> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => resolve({ step, status: code ?? 1, output, seconds: (performance.now() - started) / 1000 }));
    child.on('error', (error) => resolve({ step, status: 1, output: String(error), seconds: 0 }));
  });
}

// Every file under a directory with one of the extensions, repository-relative.
function filesUnder(directory: string, extensions: RegExp): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && extensions.test(entry.name)) {
      found.push(path.relative(root, path.join(entry.parentPath, entry.name)));
    }
  }
  return found;
}

// The vendor copies are gitignored, and oxlint lints an ignored file only when
// it is named, so the copies are listed one by one.
function lintTargets(staged: readonly string[] | undefined): string[] {
  const vendored = filesUnder(vendor, /\.(?:tsx?|mts|mjs)$/);
  if (staged === undefined) {
    return ['studio/src', 'studio/scripts', 'tools', 'oxlint.config.ts', ...vendored];
  }
  const copies = new Set(vendored);
  return staged.flatMap((file) => {
    if (/^(?:src|shared|electron)\//.test(file)) {
      const copy = `${vendor}/${file}`;
      return copies.has(copy) ? [copy] : [];
    }
    return /\.(?:tsx?|mts|mjs)$/.test(file) && !file.startsWith('studio/dev-site/') ? [file] : [];
  });
}

async function lint(staged: readonly string[] | undefined): Promise<Outcome> {
  const targets = lintTargets(staged);
  if (targets.length === 0) {
    return { step: 'lint', status: 0, output: '', seconds: 0 };
  }
  const outcome = await run('lint', bin('oxlint'), ['--type-aware', '--deny-warnings', ...targets]);
  // Findings in a copy belong to the root file it was copied from.
  return { ...outcome, output: outcome.output.replaceAll(`${vendor}/`, '') };
}

function format(staged: readonly string[] | undefined): Promise<Outcome> {
  const targets = staged ?? ['.'];
  if (targets.length === 0) {
    return Promise.resolve({ step: 'format', status: 0, output: '', seconds: 0 });
  }
  const cache = ['--cache', '--cache-strategy', 'content', '--cache-location', 'node_modules/.cache/prettier.json'];
  return run('format', bin('prettier'), ['--check', '--log-level', 'warn', '--ignore-unknown', ...cache, ...targets]);
}

async function types(): Promise<Outcome> {
  const app = await run('types', 'node', [tsc, '-p', 'tsconfig.app.json'], studio);
  if (app.status !== 0) {
    return app;
  }
  const worker = await run('types', 'node', [tsc, '-p', 'tsconfig.worker.json'], studio);
  return { ...worker, seconds: app.seconds + worker.seconds };
}

async function stagedFiles(): Promise<string[]> {
  const listed = await run('git', 'git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
  return listed.output.split('\0').filter((file) => file.length > 0);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const staged = args.includes('--staged') ? await stagedFiles() : undefined;
  const named = args.filter((arg): arg is Step => STEPS.some((step) => step === arg));
  const steps = named.length > 0 ? named : staged === undefined ? STEPS : (['format', 'lint', 'types'] as const);

  if (steps.some((step) => step === 'lint' || step === 'types')) {
    const assembled = await run('assemble', tsx, ['scripts/assemble.ts'], studio);
    if (assembled.status !== 0) {
      process.stdout.write(assembled.output);
      return 1;
    }
  }
  const parallel: Promise<Outcome>[] = [];
  if (steps.includes('format')) {
    parallel.push(format(staged));
  }
  if (steps.includes('lint')) {
    parallel.push(lint(staged));
  }
  if (steps.includes('types')) {
    parallel.push(types());
  }
  const outcomes = await Promise.all(parallel);
  if (steps.includes('build') && outcomes.every((outcome) => outcome.status === 0)) {
    outcomes.push(await run('build', tsx, ['scripts/build.ts'], studio));
  }
  for (const outcome of outcomes) {
    const verdict = outcome.status === 0 ? 'ok  ' : 'FAIL';
    console.log(`${verdict} ${outcome.step} (${outcome.seconds.toFixed(1)}s)`);
    if (outcome.status !== 0) {
      console.log(outcome.output.trim() + '\n');
    }
  }
  return outcomes.every((outcome) => outcome.status === 0) ? 0 : 1;
}

process.exitCode = await main();
