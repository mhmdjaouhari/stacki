// Goal: provider payloads become either reply text or a message a site owner can
// act on, never an exception from deep inside parsing. Method: feed the pure
// functions in replies.ts the shapes real OpenAI-compatible providers return
// (string and part-list content, reasoning blocks, fenced and prose-wrapped JSON,
// cut-off and filtered replies, JSON and plain-text error bodies) and the
// malformed shapes they must survive.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionReply, MAX_REPLY, OUT_OF_TOKENS, parseAnswer, providerFailure } from '../src/features/ai/replies';
import { outputTokens } from '../src/features/ai/agent';

const choice = (message: unknown, finish: unknown = 'stop') => ({ choices: [{ message, finish_reason: finish }] });

test('reply text comes from string content or from text parts', () => {
  assert.deepEqual(completionReply(choice({ content: '{"summary":"ok"}' })), { kind: 'reply', content: '{"summary":"ok"}' });
  assert.deepEqual(completionReply(choice({ content: [{ type: 'text', text: '{"a":' }, { type: 'image' }, { type: 'text', text: '1}' }] })), {
    kind: 'reply',
    content: '{"a":1}',
  });
});

test('cut-off, filtered, empty, oversized and malformed replies fail with a reason', () => {
  assert.deepEqual(completionReply(choice({ content: '{"summ' }, 'length')), { kind: 'failure', message: OUT_OF_TOKENS });
  assert.match(failure(choice({ content: 'x' }, 'content_filter')), /content filter/);
  assert.match(failure(choice({ content: '   ' })), /empty reply/);
  assert.match(failure(choice({ content: null, reasoning_content: 'thinking…' })), /empty reply/);
  assert.match(failure(choice({ content: 'x'.repeat(MAX_REPLY + 1) })), /too large/);
  for (const payload of [null, 'text', [], {}, { choices: [] }, { choices: ['x'] }, { choices: [{}] }]) {
    assert.equal(completionReply(payload).kind, 'failure', JSON.stringify(payload));
  }
});

test('the JSON object is found inside reasoning blocks, fences and surrounding prose', () => {
  const object = { summary: 'Done', changes: [] };
  const json = JSON.stringify(object);
  for (const content of [
    json,
    '```json\n' + json + '\n```',
    '<think>Let me look at {the file}.</think>\n' + json,
    'Here is the proposal:\n' + json + '\nLet me know if you want more.',
  ]) {
    assert.deepEqual(parseAnswer(content), { kind: 'answer', answer: object }, content);
  }
});

test('replies without a JSON object are invalid', () => {
  for (const content of ['', 'I changed the title.', '[1, 2]', '"text"', '{"summary": "unterminated', '} reversed {']) {
    assert.deepEqual(parseAnswer(content), { kind: 'invalid' }, content);
  }
});

test('provider failures carry the provider message, bounded and on one line', () => {
  assert.equal(providerFailure(400, '{"error":{"message":"Unknown model"}}'), 'AI provider error (400): Unknown model');
  assert.equal(providerFailure(401, '{"message":"Bad key"}'), 'AI provider error (401): Bad key');
  assert.equal(providerFailure(429, '{"error":"Rate limited"}'), 'AI provider error (429): Rate limited');
  assert.equal(providerFailure(502, 'upstream\r\ndown'), 'AI provider error (502): upstream down');
  assert.match(providerFailure(503, ''), /unavailable \(503\)/);
  assert.match(providerFailure(500, '{"error":{"code":1}}'), /unavailable \(500\)/);
  assert.ok(providerFailure(400, 'x'.repeat(10_000)).length < 400);
});

test('the output budget defaults, accepts bounded whole numbers and rejects the rest', () => {
  assert.equal(outputTokens(undefined), 16_384);
  assert.equal(outputTokens(' '), 16_384);
  assert.equal(outputTokens('64000'), 64_000);
  for (const value of ['1023', '393217', '1.5', 'many', '-1']) {
    assert.throws(() => outputTokens(value), /AI_MAX_TOKENS/, value);
  }
});

function failure(payload: unknown): string {
  const result = completionReply(payload);
  assert.equal(result.kind, 'failure');
  return result.kind === 'failure' ? result.message : '';
}
