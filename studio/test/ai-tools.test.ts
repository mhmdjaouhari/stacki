// Goal: models with native tool calling read through bounded, read-only tools and finish
// with a checked proposal; a proposal that wouldn't compile goes back to the model to fix,
// a bounded number of times, in both protocols; a host's extension tools and context are
// offered, bounded, and can't break a request; and malformed tool calls fail clearly.
// Method: a local provider plays back scripted completions (text or tool calls) and keeps
// every request body; propose runs on a temporary project against it, and the test reads
// the tools offered, the tool results sent back, and the proposal returned. Extension
// parsing and the tool-call parser are checked on their own with valid and invalid input.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { propose } from '../src/features/ai/agent';
import { BUILT_IN_TOOL_NAMES } from '../src/features/ai/agentTools';
import { parseAiExtensions, type AiExtensions } from '../src/features/ai/aiExtensions';
import { gatherContext } from '../src/features/ai/aiContext';
import { completionTurn } from '../src/features/ai/replies';
import { captureScreenshot, chromeArguments, screenshotBrowser } from '../src/features/ai/screenshots';
import { record } from '../src/shared/validation';

const PAGE = 'src/pages/index.astro';
const HERO = 'src/components/Hero.astro';

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-ai-tools-'));
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await mkdir(path.join(root, 'src/components'), { recursive: true });
  await writeFile(path.join(root, PAGE), '---\nimport Hero from "../components/Hero.astro";\n---\n<Hero />\n');
  await writeFile(path.join(root, HERO), '<section class="hero">\n  <h1>Welcome home</h1>\n</section>\n');
  return root;
}

// Completions in order (the last repeats); every request body is kept.
async function scripted(replies: readonly unknown[]) {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      bodies.push(record(JSON.parse(body)));
      const message = replies[Math.min(bodies.length, replies.length) - 1];
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    bodies,
    options: { endpoint: `http://127.0.0.1:${address.port}`, apiKey: '', model: 'local', tools: true },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
const calls = (...list: readonly (readonly [string, unknown])[]) => ({
  content: null,
  reasoning_content: 'thinking',
  tool_calls: list.map(([name, input], index) => ({ id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(input) } })),
});
const change = (after: string) => ({ file: HERO, before: '<h1>Welcome home</h1>', after });
const messagesOf = (body: Record<string, unknown> | undefined) => {
  const messages = body?.['messages'];
  assert.ok(Array.isArray(messages));
  return messages.map((message: unknown) => record(message));
};

test('the model reads, proposes a broken change, gets the problems, and fixes it', async () => {
  const root = await project();
  const provider = await scripted([
    calls(['read_file', { paths: [HERO] }], ['search_source', { query: 'welcome' }]),
    calls(['propose_changes', { summary: 'Warmer title', changes: [change('<h1>{ greeting + }</h1>')] }]),
    calls(['propose_changes', { summary: 'Warmer title', changes: [change('<h1>Welcome, neighbour</h1>')] }]),
  ]);
  try {
    const proposal = await propose(root, PAGE, 'Make the hero warmer', provider.options);
    assert.deepEqual(proposal, { summary: 'Warmer title', changes: [change('<h1>Welcome, neighbour</h1>')] });
    const first = provider.bodies[0];
    assert.deepEqual(
      (first?.['tools'] as readonly { function: { name: string } }[]).map((tool) => tool.function.name),
      // The screenshot tool is only for vision models with a browser configured.
      BUILT_IN_TOOL_NAMES.filter((name) => name !== 'screenshot'),
    );
    assert.equal(first?.['tool_choice'], 'auto');
    const second = messagesOf(provider.bodies[1]);
    const assistant = second.find((message) => message['role'] === 'assistant' && message['tool_calls']);
    assert.equal(assistant?.['reasoning_content'], 'thinking', 'reasoning goes back within the tool loop');
    const results = second.filter((message) => message['role'] === 'tool');
    assert.deepEqual(
      results.map((message) => message['tool_call_id']),
      ['call-0', 'call-1'],
    );
    assert.match(String(results[0]?.['content']), /Welcome home/);
    assert.deepEqual(JSON.parse(String(results[1]?.['content'])), [{ file: HERO, line: 2, text: '<h1>Welcome home</h1>' }]);
    const rejected = JSON.parse(String(messagesOf(provider.bodies[2]).at(-1)?.['content'])) as { accepted: boolean; problems: { file: string }[] };
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.problems[0]?.file, HERO);
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('after two fix rounds the proposal comes back with its problems; editing unread files is refused', async () => {
  const root = await project();
  const broken = calls(['propose_changes', { summary: 'Broken', changes: [change('<h1>{ greeting + }</h1>')] }]);
  const unread = calls(['propose_changes', { summary: 'Unread', changes: [change('<h1>Hi</h1>')] }]);
  const provider = await scripted([unread, calls(['read_file', { paths: [HERO] }]), broken]);
  try {
    const proposal = await propose(root, PAGE, 'Break it', provider.options);
    assert.equal(proposal.summary, 'Broken');
    assert.equal(proposal.problems?.[0]?.file, HERO);
    // Unread, read, then three broken proposals: the first two go back to be fixed.
    assert.equal(provider.bodies.length, 5);
    assert.match(String(messagesOf(provider.bodies[1]).at(-1)?.['content']), /has not read/);
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a plain answer is a reply without changes, and tool errors go back as results', async () => {
  const root = await project();
  const provider = await scripted([
    calls(['read_file', { paths: ['../outside.astro'] }], ['render_page', { path: '/' }], ['unknown_tool', {}]),
    { content: 'The hero sits in Hero.astro.' },
  ]);
  try {
    assert.deepEqual(await propose(root, PAGE, 'Where is the hero?', provider.options), { summary: 'The hero sits in Hero.astro.', changes: [] });
    const results = messagesOf(provider.bodies[1]).filter((message) => message['role'] === 'tool');
    assert.deepEqual(
      results.map((message) => Object.keys(record(JSON.parse(String(message['content']))))),
      [['error'], ['error'], ['error']],
    );
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a host's tools are offered and bounded, and its failures stay inside the tool result", async () => {
  const root = await project();
  const received: unknown[] = [];
  const extensions = parseAiExtensions(
    {
      tools: [
        {
          name: 'cms_entries',
          description: 'Entries of a collection',
          parameters: { type: 'object', properties: { collection: { type: 'string' } } },
          run: (input) => {
            received.push(input);
            return Promise.resolve({ entries: ['x'.repeat(80_000)] });
          },
        },
        { name: 'cms_broken', description: 'Always fails', parameters: { type: 'object' }, run: () => Promise.reject(new Error('CMS offline')) },
      ],
    },
    BUILT_IN_TOOL_NAMES,
  );
  assert.ok(extensions);
  const provider = await scripted([calls(['cms_entries', { collection: 'posts' }], ['cms_broken', {}]), { content: 'Done.' }]);
  try {
    const sources = { render: () => Promise.resolve(''), sample: () => Promise.resolve({ value: null }), extensions };
    await propose(root, PAGE, 'List posts', provider.options, { images: [], history: [], sources });
    assert.deepEqual(received, [{ collection: 'posts' }]);
    const offered = (provider.bodies[0]?.['tools'] as readonly { function: { name: string } }[]).map((tool) => tool.function.name);
    assert.deepEqual(offered.slice(-2), ['cms_entries', 'cms_broken']);
    const results = messagesOf(provider.bodies[1]).filter((message) => message['role'] === 'tool');
    assert.ok(String(results[0]?.['content']).length <= 50_100);
    assert.match(String(results[0]?.['content']), /cut at 50000 characters/);
    assert.deepEqual(JSON.parse(String(results[1]?.['content'])), { error: 'CMS offline' });
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('host context sections are added to the request, bounded, and a failing provider says so', async () => {
  const root = await project();
  try {
    const extensions: AiExtensions = {
      context: [
        () => Promise.resolve([{ title: 'Content model', content: `posts: title, body${' x'.repeat(10_000)}` }]),
        () => Promise.reject(new Error('CMS offline')),
      ],
    };
    const context = await gatherContext(root, PAGE, {}, { render: () => Promise.resolve(''), sample: () => Promise.resolve({ value: null }), extensions });
    assert.equal(context.host?.[0]?.title, 'Content model');
    assert.equal(context.host?.[0]?.content.length, 8001);
    assert.deepEqual(context.host?.[1], { title: 'Unavailable context', content: 'CMS offline' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the JSON protocol gets the same check and fix round', async () => {
  const root = await project();
  const json = (value: unknown) => ({ content: JSON.stringify(value) });
  const provider = await scripted([
    json({ read: [HERO] }),
    json({ summary: 'Broken', changes: [change('<h1>{ greeting + }</h1>')] }),
    json({ summary: 'Fixed', changes: [change('<h1>Hello</h1>')] }),
  ]);
  try {
    const proposal = await propose(root, PAGE, 'Change the title', { ...provider.options, tools: false });
    assert.deepEqual(proposal, { summary: 'Fixed', changes: [change('<h1>Hello</h1>')] });
    assert.equal('tools' in (provider.bodies[0] ?? {}), false);
    assert.match(String(messagesOf(provider.bodies[2]).at(-1)?.['content']), /"problems"/);
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a vision model gets screenshots as images after the tool results; other models never see the tool', async () => {
  const root = await project();
  const shot = 'data:image/png;base64,iVBORw0KGgo=';
  const shots: string[] = [];
  const sources = {
    render: () => Promise.resolve(''),
    sample: () => Promise.resolve({ value: null }),
    screenshot: (path: string) => {
      shots.push(path);
      return Promise.resolve(shot);
    },
  };
  const provider = await scripted([calls(['screenshot', { path: '/' }], ['screenshot', { path: 'https://example.com' }]), { content: 'Looks fine.' }]);
  try {
    await propose(root, PAGE, 'How does it look?', { ...provider.options, vision: true }, { images: [], history: [], sources });
    const offered = (provider.bodies[0]?.['tools'] as readonly { function: { name: string } }[]).map((tool) => tool.function.name);
    assert.ok(offered.includes('screenshot'));
    assert.deepEqual(shots, ['/']);
    const messages = messagesOf(provider.bodies[1]);
    const results = messages.filter((message) => message['role'] === 'tool').map((message) => Object.keys(record(JSON.parse(String(message['content'])))));
    assert.deepEqual(results, [['ok', 'note'], ['error']]);
    const pictures = messages.at(-1);
    assert.equal(pictures?.['role'], 'user');
    assert.deepEqual((pictures?.['content'] as unknown[])[1], { type: 'image_url', image_url: { url: shot } });
    // Without vision, the same sources offer no screenshot tool.
    await propose(root, PAGE, 'How does it look?', provider.options, { images: [], history: [], sources });
    const plain = (provider.bodies.at(-1)?.['tools'] as readonly { function: { name: string } }[]).map((tool) => tool.function.name);
    assert.equal(plain.includes('screenshot'), false);
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('screenshots need an existing absolute browser path, and only capture the local dev server', async () => {
  assert.equal(screenshotBrowser(''), undefined);
  assert.equal(screenshotBrowser(undefined), undefined);
  assert.throws(() => screenshotBrowser('chromium'), /absolute path/);
  assert.throws(() => screenshotBrowser('/no/such/chrome'), /absolute path/);
  assert.equal(screenshotBrowser(process.execPath), process.execPath);
  const args = chromeArguments('/tmp/shot', '/tmp/shot/shot.png', 'http://127.0.0.1:4350/', 0.5);
  assert.ok(args.includes('--headless=new'));
  assert.ok(args.includes('--screenshot=/tmp/shot/shot.png'));
  assert.equal(args.at(-1), 'http://127.0.0.1:4350/');
  await assert.rejects(captureScreenshot(process.execPath, 'https://example.com/', 'model'), /Assertion failed/);
});

test('two changes to one file go back to be combined, in both protocols, and still fail when they never are', async () => {
  const root = await project();
  const json = (value: unknown) => ({ content: JSON.stringify(value) });
  const twice = {
    summary: 'Two edits',
    changes: [change('<h1>Hello</h1>'), { file: HERO, before: '<section class="hero">', after: '<section class="hero big">' }],
  };
  const once = {
    summary: 'One edit',
    changes: [{ file: HERO, before: '<section class="hero">\n  <h1>Welcome home</h1>', after: '<section class="hero big">\n  <h1>Hello</h1>' }],
  };
  const provider = await scripted([json({ read: [HERO] }), json(twice), json(once)]);
  try {
    const proposal = await propose(root, PAGE, 'Make the hero bigger', { ...provider.options, tools: false });
    assert.equal(proposal.summary, 'One edit');
    const correction = String(messagesOf(provider.bodies[2]).at(-1)?.['content']);
    assert.match(correction, /src\/components\/Hero\.astro has several: make one change whose before runs from the first edited line to the last/);
  } finally {
    await provider.close();
  }
  const stubborn = await scripted([json({ read: [HERO] }), json(twice)]);
  try {
    await assert.rejects(propose(root, PAGE, 'Make the hero bigger', { ...stubborn.options, tools: false }), /one change per file/);
    assert.equal(stubborn.bodies.length, 4, 'one read, then the proposal and two corrections');
  } finally {
    await stubborn.close();
  }
  // With tools, a proposal written as plain JSON gets the same correction.
  const plain = await scripted([calls(['read_file', { paths: [HERO] }]), json(twice), calls(['propose_changes', once])]);
  try {
    assert.equal((await propose(root, PAGE, 'Make the hero bigger', plain.options)).summary, 'One edit');
  } finally {
    await plain.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('host extensions are validated once, when Studio starts', () => {
  const run = () => Promise.resolve(null);
  const valid = { name: 'cms_schema', description: 'Schema', parameters: { type: 'object' }, run };
  assert.equal(parseAiExtensions(undefined, BUILT_IN_TOOL_NAMES), undefined);
  assert.deepEqual(parseAiExtensions({ tools: [valid] }, BUILT_IN_TOOL_NAMES)?.tools, [valid]);
  for (const tools of [
    [{ ...valid, name: 'read_file' }],
    [valid, valid],
    [{ ...valid, name: 'Bad-Name' }],
    [{ ...valid, description: '' }],
    [{ ...valid, parameters: { type: 'string' } }],
    Array.from({ length: 17 }, (_, index) => ({ ...valid, name: `tool_${index}` })),
  ]) {
    assert.throws(() => parseAiExtensions({ tools }, BUILT_IN_TOOL_NAMES), /studio\(\{ ai \}\)/, JSON.stringify(tools.map((tool) => tool.name)));
  }
});

test('tool calls are parsed strictly', () => {
  const turn = (message: unknown, finish = 'tool_calls') => completionTurn({ choices: [{ message, finish_reason: finish }] });
  const call = { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"paths":[]}' } };
  assert.deepEqual(turn({ content: null, tool_calls: [call] }), {
    kind: 'tools',
    calls: [{ id: 'a', name: 'read_file', arguments: '{"paths":[]}' }],
    content: '',
    reasoning: '',
  });
  assert.deepEqual(
    turn({ tool_calls: [{ ...call, function: { name: 'read_file', arguments: { paths: [] } } }] }).kind,
    'tools',
    'object arguments are accepted',
  );
  assert.equal(turn({ content: 'text' }, 'stop').kind, 'reply');
  for (const bad of [{ ...call, id: '' }, { ...call, function: { name: 'Read File', arguments: '{}' } }, { id: 'a' }]) {
    assert.equal(turn({ tool_calls: [bad] }).kind, 'failure', JSON.stringify(bad));
  }
  assert.equal(turn({ tool_calls: Array.from({ length: 9 }, () => call) }).kind, 'failure');
  assert.equal(turn({ tool_calls: [call] }, 'length').kind, 'failure');
});
