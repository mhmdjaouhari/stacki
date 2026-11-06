// Goal: a proposal that wouldn't apply or compile is caught before the person sees it,
// with a message and line the model can act on, and a good one passes untouched.
// Method: checkSources runs on candidate sources of each checked kind, valid and broken
// (Astro markup, Astro frontmatter, TypeScript, JSON, CSS, an oversized file);
// checkProposal runs on a temporary project with changes that apply, are stale,
// are ambiguous, create a file, or overwrite one; appliedSource is checked directly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appliedSource, checkSources, CHECK_LIMITS } from '../src/features/ai/checks';
import { checkProposal } from '../src/features/ai/proposalSources';

const PAGE = 'src/pages/index.astro';

test('valid candidates of every kind pass', async () => {
  assert.deepEqual(
    await checkSources([
      { file: PAGE, source: '---\nconst title: string = "Hi";\n---\n<h1>{title}</h1>\n' },
      { file: 'src/lib/site.ts', source: 'export const site = { name: "InSyndic" } as const;\n' },
      { file: 'src/data/site.json', source: '{ "name": "InSyndic" }' },
      { file: 'src/styles/site.css', source: 'h1 { color: red; }\n' },
      { file: 'src/content/post.md', source: '# Not checked\n' },
    ]),
    [],
  );
});

test('broken candidates come back with a message and, where known, a line', async () => {
  const problems = await checkSources([
    { file: PAGE, source: '---\nconst title = ;\n---\n<h1>{title}</h1>\n' },
    { file: 'src/lib/site.ts', source: 'export const site = {\n  name: "InSyndic",\n' },
    { file: 'src/data/site.json', source: '{ "name": }' },
    { file: 'src/styles/site.css', source: 'h1 {\n  color: red;\n' },
  ]);
  const byFile = (file: string) => problems.filter((problem) => problem.file === file);
  assert.equal(byFile(PAGE)[0]?.line, 2, 'frontmatter lines count from the file, after the opening fence');
  assert.ok(byFile('src/lib/site.ts').length > 0);
  assert.match(byFile('src/data/site.json')[0]?.message ?? '', /JSON|Unexpected/);
  assert.deepEqual([byFile('src/styles/site.css')[0]?.line, byFile('src/styles/site.css')[0]?.message], [1, 'Unclosed block']);
  const markup = await checkSources([{ file: PAGE, source: '<h1>Title</h1>\n<p>{ count + }</p>\n' }]);
  assert.match(markup[0]?.message ?? '', /^In the template: /, 'a broken expression in markup is caught');
  assert.equal(markup[0]?.line, undefined, "the compiled module's lines aren't the file's");
  const large = await checkSources([{ file: 'src/data/big.json', source: `"${'x'.repeat(1_000_001)}"` }]);
  assert.match(large[0]?.message ?? '', /larger than 1 MB/);
});

test('problems are capped, and so are their messages', async () => {
  const files = Array.from({ length: 30 }, (_, index) => ({ file: `src/data/${index}.json`, source: '{' }));
  const problems = await checkSources(files);
  assert.equal(problems.length, CHECK_LIMITS.problemsMax);
  assert.ok(problems.every((problem) => problem.message.length <= CHECK_LIMITS.messageCharsMax));
});

test('changes are applied exactly once, or explain why not', async () => {
  assert.equal(appliedSource('<h1>A</h1>', { file: PAGE, before: 'A', after: 'B' }), '<h1>B</h1>');
  assert.equal(appliedSource(undefined, { file: PAGE, before: '', after: 'new' }), 'new');
  assert.equal(appliedSource('<p>$&</p>', { file: PAGE, before: '$&', after: '$1' }), '<p>$1</p>', 'replacement patterns stay literal');
  assert.throws(() => appliedSource('<h1>A</h1><h1>A</h1>', { file: PAGE, before: '<h1>A</h1>', after: '' }), /stale or ambiguous/);
  assert.throws(() => appliedSource('<h1>A</h1>', { file: PAGE, before: 'Z', after: '' }), /stale or ambiguous/);
  assert.throws(() => appliedSource('<h1>A</h1>', { file: PAGE, before: '', after: 'x' }), /cannot be overwritten/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-ai-checks-'));
  try {
    await mkdir(path.join(root, 'src/pages'), { recursive: true });
    await writeFile(path.join(root, PAGE), '<h1>Welcome</h1>\n');
    assert.deepEqual(await checkProposal(root, [{ file: PAGE, before: 'Welcome', after: 'Hello' }]), []);
    assert.deepEqual(await checkProposal(root, [{ file: 'src/pages/new.astro', before: '', after: '<p>New</p>\n' }]), []);
    assert.deepEqual(await checkProposal(root, [{ file: PAGE, before: 'Gone', after: 'Hello' }]), [
      { file: PAGE, message: 'AI change is stale or ambiguous. Ask it to regenerate.' },
    ]);
    assert.deepEqual(await checkProposal(root, [{ file: 'src/pages/missing.astro', before: 'x', after: 'y' }]), [
      { file: 'src/pages/missing.astro', message: 'File does not exist' },
    ]);
    const broken = await checkProposal(root, [{ file: PAGE, before: '<h1>Welcome</h1>', after: '---\nconst = 1;\n---\n<h1>Welcome</h1>' }]);
    assert.equal(broken[0]?.file, PAGE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
