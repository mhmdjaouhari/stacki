// Goal: the proposal store only sends requests the server's configuration
// allows, and applied changes can be undone and redone on disk without ever
// overwriting someone else's edit. Method: configure a real local provider
// through the same environment variables the server reads, open real
// collaboration rooms on a temporary project, and check the requests that reach
// the provider and the files left on disk.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRooms } from '../src/features/collaboration/rooms';
import { ProposalStore } from '../src/features/ai/proposalStore';
import { aiRoute } from '../src/features/ai/aiRoutes';
import { record } from '../src/shared/validation';

const ENVIRONMENT = ['AI_BASE_URL', 'AI_MODEL', 'AI_MODELS', 'AI_EFFORTS', 'AI_API_KEY', 'AI_MAX_TOKENS'] as const;

interface Change {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}
const PAGE = 'src/pages/index.astro';
const ABOUT = 'src/pages/about.astro';
const HERO = 'src/components/Hero.astro';

// A provider that replies with `answers` in order (repeating the last) and records every request body.
async function fixture(answers: readonly unknown[] = [{ summary: 'Proposed', changes: [] }]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-ai-proposals-'));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await writeFile(path.join(root, PAGE), '<h1>Welcome</h1>\n<p>Intro</p>\n');
  await writeFile(path.join(root, ABOUT), '<h1>About</h1>\n');
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      bodies.push(record(JSON.parse(body)));
      const content = JSON.stringify(answers[Math.min(bodies.length, answers.length) - 1]);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const saved = ENVIRONMENT.map((name) => [name, process.env[name]] as const);
  process.env['AI_BASE_URL'] = `http://127.0.0.1:${address.port}`;
  process.env['AI_MODEL'] = 'deepseek-v4-flash';
  process.env['AI_MODELS'] = 'glm-5.2';
  process.env['AI_EFFORTS'] = 'deepseek-v4-flash=low,high,max';
  const rooms = createRooms(root);
  const store = new ProposalStore(root, rooms);
  return {
    root,
    bodies,
    store,
    read: (file: string) => readFile(path.join(root, file), 'utf8').catch(() => undefined),
    write: (file: string, source: string) => writeFile(path.join(root, file), source),
    /** Propose and apply; returns the record undo and redo take. */
    apply: async () => {
      const proposal = record(await store.create(request({ model: 'deepseek-v4-flash' })));
      const applied = record(await store.apply({ id: proposal['id'] }));
      assert.equal(applied['applied'], true);
      return applied['changes'];
    },
    close: async () => {
      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      await rooms.resetWorkspace();
      rooms.sockets.close();
      server.closeAllConnections();
      server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const request = (fields: Record<string, unknown>) => ({ file: PAGE, prompt: 'Improve the title', ...fields });
const proposal = (...changes: readonly Change[]) => ({ summary: 'Proposed', changes });

test('only an effort the chosen model lists reaches the provider', async () => {
  const setup = await fixture();
  try {
    await setup.store.create(request({ model: 'deepseek-v4-flash', effort: 'max' }));
    await setup.store.create(request({ model: 'deepseek-v4-flash' }));
    assert.equal(setup.bodies[0]?.['reasoning_effort'], 'max');
    assert.equal('reasoning_effort' in (setup.bodies[1] ?? {}), false);
    for (const fields of [
      { model: 'deepseek-v4-flash', effort: 'medium' },
      { model: 'glm-5.2', effort: 'low' },
      { model: 'deepseek-v4-flash', effort: 'x'.repeat(17) },
      { model: 'deepseek-v4-flash', effort: 3 },
    ]) {
      await assert.rejects(setup.store.create(request(fields)), Error, JSON.stringify(fields));
    }
    assert.equal(setup.bodies.length, 2);
  } finally {
    await setup.close();
  }
});

test('a reply records its steps and how it was made, and streams them as server-sent events', async () => {
  const edit = proposal({ file: ABOUT, before: '<h1>About</h1>', after: '<h1>About us</h1>' });
  // Two runs of the same exchange: one through the store, one through the route.
  const setup = await fixture([{ read: [ABOUT] }, edit, { read: [ABOUT] }, edit]);
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      void aiRoute(setup.store, undefined, request, response, '/studio/api/ai/propose', () => Promise.resolve(body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const streamed: string[] = [];
    const reply = record(
      await setup.store.create(request({ model: 'deepseek-v4-flash', effort: 'high' }), undefined, undefined, (step) => streamed.push(step.label)),
    );
    const steps = reply['steps'];
    assert.ok(Array.isArray(steps));
    assert.deepEqual(
      steps.map((step: unknown) => record(step)['label']),
      streamed,
    );
    assert.deepEqual(streamed, ['Thinking about the request', 'Read pages/about.astro', 'Thinking', 'Checked 1 changed file: no problems']);
    const meta = record(reply['meta']);
    assert.deepEqual([meta['model'], meta['effort'], typeof meta['durationMs']], ['deepseek-v4-flash', 'high', 'number']);
    // The same request over the route, as a stream: steps, then the reply.
    const response = await fetch(`http://127.0.0.1:${address.port}/studio/api/ai/propose`, {
      method: 'POST',
      headers: { Accept: 'text/event-stream' },
      body: JSON.stringify(request({ model: 'deepseek-v4-flash' })),
    });
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const events = [...(await response.text()).matchAll(/^event: (\w+)$/gm)].map((match) => match[1]);
    assert.deepEqual(events, ['step', 'step', 'step', 'step', 'result']);
    // A failure after the headers went out is an event too.
    const failed = await fetch(`http://127.0.0.1:${address.port}/studio/api/ai/propose`, {
      method: 'POST',
      headers: { Accept: 'text/event-stream' },
      body: JSON.stringify(request({ model: 'unknown-model' })),
    });
    assert.match(await failed.text(), /event: error\ndata: \{"error":"Choose a configured AI model"\}/);
  } finally {
    server.close();
    await setup.close();
  }
});

test('the provider gets the rendered page, the selection and the owner guidance', async () => {
  const setup = await fixture();
  try {
    await mkdir(path.join(setup.root, '.stacki'), { recursive: true });
    await setup.write('.stacki/ai.md', 'The title comes from the CMS settings.\n');
    const sources = { render: () => Promise.resolve('<h1>InSyndic</h1>'), sample: () => Promise.resolve({ value: null }) };
    await setup.store.create(request({ model: 'deepseek-v4-flash', page: '/', selection: { start: 0, end: 16, label: '<h1>' } }), undefined, sources);
    const messages = setup.bodies[0]?.['messages'];
    assert.ok(Array.isArray(messages));
    const [system, guidance, user] = messages.map((message: unknown) => String(record(message)['content']));
    assert.match(system ?? '', /"page" is an outline/);
    assert.match(guidance ?? '', /site owner wrote these instructions[\s\S]*The title comes from the CMS settings\./);
    assert.deepEqual(record(JSON.parse(user ?? '{}'))['context'], {
      page: { path: '/', outline: 'h1: InSyndic' },
      selection: { label: '<h1>', lines: '1', source: '<h1>Welcome</h1>' },
    });
    // Without the dev server's sources and the owner's file, the request is as before.
    await setup.write('.stacki/ai.md', '');
    await setup.store.create(request({ model: 'deepseek-v4-flash' }));
    const plain = setup.bodies[1]?.['messages'];
    assert.ok(Array.isArray(plain));
    assert.equal(plain.length, 2);
    assert.equal('context' in record(JSON.parse(String(record(plain[1])['content']))), false);
  } finally {
    await setup.close();
  }
});

test('a proposal carries a line diff per file, and a change that cannot apply shows why', async () => {
  const setup = await fixture([
    { read: [ABOUT] },
    proposal(
      { file: PAGE, before: '<p>Intro</p>', after: '<p>Intro</p>\n<p>More</p>' },
      { file: ABOUT, before: '<h1>Missing</h1>', after: '<h1>About us</h1>' },
    ),
  ]);
  try {
    const reply = record(await setup.store.create(request({ model: 'deepseek-v4-flash' })));
    assert.deepEqual(reply['diffs'], [
      {
        kind: 'changed',
        file: PAGE,
        created: false,
        added: 1,
        removed: 0,
        omitted: 0,
        hunks: [{ oldStart: 1, newStart: 1, lines: [' <h1>Welcome</h1>', ' <p>Intro</p>', '+<p>More</p>'] }],
      },
      { kind: 'failed', file: ABOUT, message: 'AI change is stale or ambiguous. Ask it to regenerate.' },
    ]);
    // Diffing reads the files and leaves them as they were.
    assert.equal(await setup.read(PAGE), '<h1>Welcome</h1>\n<p>Intro</p>\n');
  } finally {
    await setup.close();
  }
});

test('the review gets whole files: from a live proposal, then from the applied record', async () => {
  const setup = await fixture([proposal({ file: PAGE, before: '<h1>Welcome</h1>', after: '<h1>Hello</h1>' })]);
  try {
    const reply = record(await setup.store.create(request({ model: 'deepseek-v4-flash' })));
    const id = String(reply['id']);
    const original = '<h1>Welcome</h1>\n<p>Intro</p>\n';
    const changed = '<h1>Hello</h1>\n<p>Intro</p>\n';
    assert.deepEqual(await setup.store.proposalFile(id, PAGE), { file: PAGE, previous: original, next: changed });
    await assert.rejects(setup.store.proposalFile(id, ABOUT), /not part of the proposal/);
    await assert.rejects(setup.store.proposalFile('unknown', PAGE), /expired/);
    await assert.rejects(setup.store.proposalFile(id, '../secret.astro'), /Invalid project path/);
    const applied = record(await setup.store.apply({ id }));
    const changes = applied['changes'];
    assert.ok(Array.isArray(changes));
    const first: unknown = changes.at(0);
    await assert.rejects(setup.store.proposalFile(id, PAGE), /expired/);
    // Edits made since the change show on both sides; only the change differs.
    await setup.write(PAGE, `${changed}<footer>Later</footer>\n`);
    assert.deepEqual(await setup.store.changeFile({ change: first, state: 'applied' }), {
      file: PAGE,
      previous: `${original}<footer>Later</footer>\n`,
      next: `${changed}<footer>Later</footer>\n`,
    });
    await setup.store.revert({ direction: 'undo', changes });
    assert.deepEqual(await setup.store.changeFile({ change: first, state: 'undone' }), {
      file: PAGE,
      previous: `${original}<footer>Later</footer>\n`,
      next: `${changed}<footer>Later</footer>\n`,
    });
    // The changed region is gone: the whole file can't be shown, and the reason says so.
    await setup.write(PAGE, '<h1>Rewritten</h1>\n');
    await assert.rejects(setup.store.changeFile({ change: first, state: 'undone' }), /changed since/);
    await assert.rejects(setup.store.changeFile({ change: first, state: 'sideways' }), /Invalid change record/);
  } finally {
    await setup.close();
  }
});

test('an applied change undoes and redoes on disk, and a stale record changes nothing', async () => {
  const setup = await fixture([proposal({ file: PAGE, before: '<h1>Welcome</h1>', after: '<h1>Hello there</h1>' })]);
  try {
    const changes = await setup.apply();
    assert.equal(await setup.read(PAGE), '<h1>Hello there</h1>\n<p>Intro</p>\n');
    assert.deepEqual(await setup.store.revert({ direction: 'undo', changes }), { reverted: true });
    assert.equal(await setup.read(PAGE), '<h1>Welcome</h1>\n<p>Intro</p>\n');
    // Undoing twice finds the region already reverted.
    assert.deepEqual(await setup.store.revert({ direction: 'undo', changes }), { reverted: false, conflicts: [PAGE] });
    assert.deepEqual(await setup.store.revert({ direction: 'redo', changes }), { reverted: true });
    assert.equal(await setup.read(PAGE), '<h1>Hello there</h1>\n<p>Intro</p>\n');
    await assert.rejects(setup.store.revert({ direction: 'sideways', changes }));
  } finally {
    await setup.close();
  }
});

test('editing from a message undoes every later change, newest first, or nothing', async () => {
  const first = proposal({ file: PAGE, before: '<h1>Welcome</h1>', after: '<h1>Hello</h1>' });
  const second = proposal({ file: PAGE, before: '<h1>Hello</h1>', after: '<h1>Hello there</h1>' }, { file: HERO, before: '', after: '<section />\n' });
  const setup = await fixture([first, second]);
  try {
    const firstChanges = await setup.apply();
    const secondChanges = await setup.apply();
    assert.equal(await setup.read(PAGE), '<h1>Hello there</h1>\n<p>Intro</p>\n');
    // Oldest first can't apply: the first record's region no longer exists until the second is undone.
    assert.deepEqual(await setup.store.undoSeries({ sets: [firstChanges, secondChanges] }), { reverted: false, conflicts: [PAGE] });
    assert.equal(await setup.read(HERO), '<section />\n', 'a conflict writes nothing');
    assert.deepEqual(await setup.store.undoSeries({ sets: [secondChanges, firstChanges] }), { reverted: true, files: 2 });
    assert.equal(await setup.read(PAGE), '<h1>Welcome</h1>\n<p>Intro</p>\n');
    assert.equal(await setup.read(HERO), undefined, 'the created file is removed again');
    for (const sets of [[], 'x', Array.from({ length: 21 }, () => firstChanges)]) {
      await assert.rejects(setup.store.undoSeries({ sets }), /Invalid change record/);
    }
  } finally {
    await setup.close();
  }
});

test('files mentioned with @ are read up front, and may be edited without reading them again', async () => {
  const setup = await fixture([proposal({ file: ABOUT, before: '<h1>About</h1>', after: '<h1>About us</h1>' })]);
  try {
    const reply = record(
      await setup.store.create(request({ model: 'deepseek-v4-flash', prompt: 'Make @src/pages/about.astro, and @src/missing.astro, warmer' })),
    );
    assert.equal((reply['changes'] as unknown[]).length, 1);
    const messages = setup.bodies[0]?.['messages'];
    assert.ok(Array.isArray(messages));
    const user = record(JSON.parse(String(record(messages.at(-1))['content'])));
    assert.deepEqual(user['mentioned'], [{ file: ABOUT, source: '<h1>About</h1>\n' }]);
  } finally {
    await setup.close();
  }
});

test('a conflict in one file leaves every file untouched', async () => {
  const setup = await fixture([
    { read: [ABOUT] },
    proposal({ file: PAGE, before: '<h1>Welcome</h1>', after: '<h1>Hello</h1>' }, { file: ABOUT, before: '<h1>About</h1>', after: '<h1>About us</h1>' }),
  ]);
  try {
    const changes = await setup.apply();
    await setup.write(ABOUT, '<h1>About the team</h1>\n');
    assert.deepEqual(await setup.store.revert({ direction: 'undo', changes }), { reverted: false, conflicts: [ABOUT] });
    assert.equal(await setup.read(PAGE), '<h1>Hello</h1>\n<p>Intro</p>\n');
    assert.equal(await setup.read(ABOUT), '<h1>About the team</h1>\n');
  } finally {
    await setup.close();
  }
});

test('undo removes a file the change created, and redo creates it again', async () => {
  const setup = await fixture([proposal({ file: HERO, before: '', after: '<section>Hero</section>\n' })]);
  try {
    const changes = await setup.apply();
    assert.equal(await setup.read(HERO), '<section>Hero</section>\n');
    assert.deepEqual(await setup.store.revert({ direction: 'undo', changes }), { reverted: true });
    assert.equal(await setup.read(HERO), undefined);
    assert.deepEqual(await setup.store.revert({ direction: 'redo', changes }), { reverted: true });
    assert.equal(await setup.read(HERO), '<section>Hero</section>\n');
  } finally {
    await setup.close();
  }
});

test('a revert whose result is invalid JSON is a conflict, not a broken file', async () => {
  const data = 'src/data/site.json';
  const setup = await fixture([{ read: [data] }, proposal({ file: data, before: '"Welcome"', after: '"Hello"' })]);
  try {
    await mkdir(path.join(setup.root, 'src/data'), { recursive: true });
    await setup.write(data, '{ "title": "Welcome" }\n');
    const changes = await setup.apply();
    assert.ok(Array.isArray(changes));
    // A forged record whose "before" is broken JSON must not reach the file.
    const forged = changes.map((change: unknown) => ({ ...record(change), before: '{ "title": ' }));
    assert.deepEqual(await setup.store.revert({ direction: 'undo', changes: forged }), { reverted: false, conflicts: [data] });
    assert.equal(await setup.read(data), '{ "title": "Hello" }\n');
  } finally {
    await setup.close();
  }
});
