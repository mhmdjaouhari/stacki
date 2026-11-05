// Goal: the proposal store only sends requests the server's configuration
// allows. Method: configure a real local provider through the same environment
// variables the server reads, open real collaboration rooms on a temporary
// project, and check which requests reach the provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRooms } from '../src/features/collaboration/rooms';
import { ProposalStore } from '../src/features/ai/proposalStore';
import { record } from '../src/shared/validation';

const ENVIRONMENT = ['AI_BASE_URL', 'AI_MODEL', 'AI_MODELS', 'AI_EFFORTS', 'AI_API_KEY', 'AI_MAX_TOKENS'] as const;

// A provider that proposes the given changes and records every request body.
async function fixture(changes: readonly { readonly file: string; readonly before: string; readonly after: string }[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-ai-proposals-'));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Welcome</h1>\n<p>Intro</p>\n');
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      bodies.push(record(JSON.parse(body)));
      const content = JSON.stringify({ summary: 'Proposed', changes });
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
  return {
    root,
    bodies,
    store: new ProposalStore(root, rooms),
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

const request = (fields: Record<string, unknown>) => ({ file: 'src/pages/index.astro', prompt: 'Improve the title', ...fields });

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
