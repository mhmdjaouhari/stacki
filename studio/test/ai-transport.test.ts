import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { propose } from '../src/features/ai/agent';
import { record } from '../src/shared/validation';

// A deliberately failing local provider verifies the real HTTP boundary without
// claiming a successful AI integration or incurring model charges.
async function provider(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-ai-transport-'));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Current source</h1>');
  return root;
}
test('selected model, image content, and history reach the real provider request', async () => {
  const root = await project();
  let captured: unknown;
  const server = await provider((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      captured = JSON.parse(body);
      response.writeHead(503).end();
    });
  });
  try {
    const image = { id: 'image', name: 'ref.png', url: 'data:image/png;base64,AAAA' };
    await assert.rejects(
      propose(
        root,
        'src/pages/index.astro',
        'Use this reference',
        {
          endpoint: server.endpoint,
          apiKey: '',
          model: 'selected-vision-model',
        },
        { images: [image], history: [{ role: 'assistant', content: 'Earlier discussion' }] },
      ),
      /503/,
    );
    const body = record(captured);
    assert.equal(body['model'], 'selected-vision-model');
    const messages = body['messages'];
    assert.ok(Array.isArray(messages));
    assert.deepEqual(messages[1], { role: 'assistant', content: 'Earlier discussion' });
    const content = record(messages[2])['content'];
    assert.ok(Array.isArray(content));
    assert.deepEqual(content[1], { type: 'image_url', image_url: { url: image.url } });
    assert.match(JSON.stringify(content[0]), /Current source/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('stopping one request aborts its provider fetch while another request can continue', async () => {
  const root = await project();
  const controller = new AbortController();
  let calls = 0;
  const server = await provider((_request, response) => {
    if (++calls === 1) {
      controller.abort();
    } else {
      response.writeHead(503).end();
    }
  });
  const options = { endpoint: server.endpoint, apiKey: '', model: 'local' };
  try {
    await assert.rejects(propose(root, 'src/pages/index.astro', 'First chat', options, undefined, controller.signal), { name: 'AbortError' });
    await assert.rejects(propose(root, 'src/pages/index.astro', 'Second chat', options), /503/);
    assert.equal(calls, 2);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Replies are played back in order; each request body is kept for assertions.
async function scripted(replies: readonly (readonly [number, unknown])[]) {
  const bodies: Record<string, unknown>[] = [];
  const server = await provider((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      bodies.push(record(JSON.parse(body)));
      const [status, payload] = replies[Math.min(bodies.length, replies.length) - 1] ?? [500, {}];
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
    });
  });
  return { server, bodies };
}
const answer = (content: string, finish = 'stop') => [200, { choices: [{ message: { content }, finish_reason: finish }] }] as const;
const proposal = JSON.stringify({ summary: 'No changes needed', changes: [] });

test('a reply wrapped in prose is accepted, and an unparsable one gets exactly one repair round', async () => {
  const root = await project();
  const { server, bodies } = await scripted([answer('I looked at the page.'), answer(`Sure!\n${proposal}\nAnything else?`)]);
  try {
    const options = { endpoint: server.endpoint, apiKey: '', model: 'local', maxTokens: 32_000 };
    assert.deepEqual(await propose(root, 'src/pages/index.astro', 'Check the title', options), { summary: 'No changes needed', changes: [] });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0]?.['max_tokens'], 32_000);
    const messages = bodies[1]?.['messages'];
    assert.ok(Array.isArray(messages));
    assert.match(JSON.stringify(messages.at(-1)), /not valid JSON/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a second unparsable reply fails with a clear message instead of a parse error', async () => {
  const root = await project();
  const { server, bodies } = await scripted([answer('Plain prose.'), answer('Still prose.'), answer(proposal)]);
  try {
    const options = { endpoint: server.endpoint, apiKey: '', model: 'local' };
    await assert.rejects(propose(root, 'src/pages/index.astro', 'Check the title', options), /did not reply with valid JSON/);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0]?.['max_tokens'], 16_384);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a cut-off reply and a provider error message reach the user', async () => {
  const root = await project();
  const { server } = await scripted([answer('{"summ', 'length'), [400, { error: { message: 'reasoning_effort is not supported' } }]]);
  try {
    const options = { endpoint: server.endpoint, apiKey: '', model: 'local' };
    await assert.rejects(propose(root, 'src/pages/index.astro', 'First', options), /ran out of output tokens/);
    await assert.rejects(propose(root, 'src/pages/index.astro', 'Second', options), /AI provider error \(400\): reasoning_effort is not supported/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
