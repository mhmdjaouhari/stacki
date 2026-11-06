// Goal: the steps a reply records are short, ordered, bounded, and say what happened in plain
// words, both in the JSON protocol and with tools.
// Method: stepRecorder runs with a clock that moves and with more steps than it keeps; the labels
// are checked directly; and a tool loop against a scripted local provider records its steps.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkLabel, fileList, STEP_LIMITS, stepRecorder } from '../src/features/ai/progress';
import { propose } from '../src/features/ai/agent';

test('the recorder keeps the first steps, bounded, and forwards every one', () => {
  const forwarded: string[] = [];
  const recorder = stepRecorder(Date.now() - 1500, (step) => forwarded.push(step.label));
  recorder.progress(`  Read\n ${'x'.repeat(500)}  `);
  for (let index = 0; index < STEP_LIMITS.stepsMax + 10; index++) {
    recorder.progress(`Step ${index}`);
  }
  const steps = recorder.steps();
  assert.equal(steps.length, STEP_LIMITS.stepsMax);
  assert.equal(forwarded.length, STEP_LIMITS.stepsMax + 11);
  assert.equal(steps[0]?.label.length, STEP_LIMITS.labelCharsMax);
  assert.match(steps[0]?.label ?? '', /^Read x/);
  assert.ok((steps[0]?.atMs ?? 0) >= 1500);
  assert.throws(() => stepRecorder(Number.NaN), /Assertion failed/);
});

test('labels say what happened', () => {
  assert.equal(checkLabel(0, 0, true), 'Answered without changes');
  assert.equal(checkLabel(2, 0, true), 'Checked 2 changed files: no problems');
  assert.equal(checkLabel(1, 1, true), 'Checked the proposal: 1 problem; asked the model to fix them');
  assert.equal(checkLabel(1, 3, false), 'Checked the proposal: 3 problems remain');
  assert.equal(fileList(['src/a.astro', 'src/b.astro']), 'a.astro, b.astro');
  assert.equal(fileList(['src/a', 'src/b', 'src/c', 'src/d', 'src/e']), 'a, b, c and 2 more');
});

test('a tool loop records each call in words', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-ai-progress-'));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Home</h1>\n');
  const replies = [
    {
      content: null,
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'search_source', arguments: '{"query":"Home"}' } },
        { id: 'b', type: 'function', function: { name: 'list_files', arguments: '{"prefix":"src/pages/"}' } },
        { id: 'c', type: 'function', function: { name: 'emdash_entries', arguments: 'not json' } },
      ],
    },
    { content: 'The page has one heading.' },
  ];
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const message = replies[Math.min(calls++, replies.length - 1)];
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const labels: string[] = [];
  try {
    await propose(
      root,
      'src/pages/index.astro',
      'Describe the page',
      { endpoint: `http://127.0.0.1:${address.port}`, apiKey: '', model: 'local', tools: true },
      undefined,
      undefined,
      (label) => labels.push(label),
    );
    assert.deepEqual(labels, ['Thinking about the request', 'Searched for "Home"', 'Listed files under src/pages/', 'Asked emdash_entries', 'Thinking']);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
