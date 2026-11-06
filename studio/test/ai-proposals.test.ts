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
