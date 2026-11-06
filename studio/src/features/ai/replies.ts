import { record } from '../../shared/validation';

// OpenAI-compatible providers agree on the shape of a chat completion but not on
// the details that decide whether a reply is usable. Reasoning models spend
// output tokens on thinking and can stop before the answer, some providers send
// content as a list of parts, and many models wrap the JSON they were asked for
// in prose, code fences or <think> blocks. These pure functions turn a provider
// payload into either the reply text or a message a site owner can act on.

export const MAX_REPLY = 200_000;
const MAX_PARTS = 64;
const MAX_DETAIL = 300;
const MAX_ERROR_BODY = 4000;

export type ReplyResult = { readonly kind: 'reply'; readonly content: string } | { readonly kind: 'failure'; readonly message: string };
export type AnswerResult = { readonly kind: 'answer'; readonly answer: Record<string, unknown> } | { readonly kind: 'invalid' };

export const OUT_OF_TOKENS = 'The model ran out of output tokens before finishing its reply. Choose a lower effort, or raise AI_MAX_TOKENS on the server.';

/** The reply text of the first choice, or why there is none. */
export function completionReply(payload: unknown): ReplyResult {
  const choices = objectOf(payload)?.['choices'];
  const choice = Array.isArray(choices) ? objectOf(choices[0]) : undefined;
  if (!choice) {
    return { kind: 'failure', message: 'The AI provider returned no reply.' };
  }
  const finish = choice['finish_reason'];
  const content = textContent(objectOf(choice['message'])?.['content']);
  if (finish === 'length') {
    return { kind: 'failure', message: OUT_OF_TOKENS };
  }
  if (finish === 'content_filter') {
    return { kind: 'failure', message: "The provider's content filter blocked the reply." };
  }
  if (!content.trim()) {
    return { kind: 'failure', message: 'The model returned an empty reply. Try again, or choose another model.' };
  }
  if (content.length > MAX_REPLY) {
    return { kind: 'failure', message: 'The model reply is too large.' };
  }
  return { kind: 'reply', content };
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** The arguments as the model wrote them: a JSON text, parsed by the tool. */
  readonly arguments: string;
}
export type TurnResult =
  | ReplyResult
  | {
      readonly kind: 'tools';
      readonly calls: readonly ToolCall[];
      readonly content: string;
      /** Reasoning some providers (DeepSeek in thinking mode) need echoed back within a tool loop. */
      readonly reasoning: string;
    };

export const TOOL_LIMITS = {
  callsPerTurnMax: 8,
  argumentsCharsMax: 1_200_000,
  idCharsMax: 200,
} as const satisfies Record<string, number>;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** A reply that may call tools: the calls of the first choice, or its text as `completionReply` reads it. */
export function completionTurn(payload: unknown): TurnResult {
  const choices = objectOf(payload)?.['choices'];
  const choice = Array.isArray(choices) ? objectOf(choices[0]) : undefined;
  const message = objectOf(choice?.['message']);
  const calls = message?.['tool_calls'];
  if (!Array.isArray(calls) || !calls.length) {
    return completionReply(payload);
  }
  if (choice?.['finish_reason'] === 'length') {
    return { kind: 'failure', message: OUT_OF_TOKENS };
  }
  if (calls.length > TOOL_LIMITS.callsPerTurnMax) {
    return { kind: 'failure', message: `The model called more than ${TOOL_LIMITS.callsPerTurnMax} tools at once.` };
  }
  const parsed = calls.map(toolCall);
  if (parsed.some((call) => call === undefined)) {
    return { kind: 'failure', message: 'The model called a tool in a form the server cannot read.' };
  }
  const reasoning = message?.['reasoning_content'];
  return {
    kind: 'tools',
    calls: parsed.filter((call): call is ToolCall => call !== undefined),
    content: textContent(message?.['content']).slice(0, MAX_REPLY),
    reasoning: typeof reasoning === 'string' ? reasoning.slice(0, MAX_REPLY) : '',
  };
}

function toolCall(value: unknown): ToolCall | undefined {
  const call = objectOf(value);
  const target = objectOf(call?.['function']);
  const id = call?.['id'];
  const name = target?.['name'];
  const input = target?.['arguments'];
  if (typeof id !== 'string' || !id || id.length > TOOL_LIMITS.idCharsMax || typeof name !== 'string' || !TOOL_NAME.test(name)) {
    return undefined;
  }
  // Some providers send the arguments as an object rather than as JSON text.
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  return text.length > TOOL_LIMITS.argumentsCharsMax ? undefined : { id, name, arguments: text || '{}' };
}

/** Content is a string, or (in some providers) a list of typed parts. */
function textContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .slice(0, MAX_PARTS)
    .map((part: unknown) => {
      if (typeof part !== 'object' || part === null || !('text' in part)) {
        return '';
      }
      return typeof part.text === 'string' ? part.text : '';
    })
    .join('');
}

/**
 * The JSON object a reply carries. Tries the reply as given (without reasoning
 * blocks and fences), then the span from its first `{` to its last `}`, so
 * prose before or after the object doesn't fail the request.
 */
export function parseAnswer(content: string): AnswerResult {
  const stripped = content
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  const candidates = start >= 0 && end > start ? [stripped, stripped.slice(start, end + 1)] : [stripped];
  for (const candidate of candidates) {
    const answer = jsonObject(candidate);
    if (answer) {
      return { kind: 'answer', answer };
    }
  }
  return { kind: 'invalid' };
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? record(value) : undefined;
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    return objectOf(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** A bounded, single-line description of a failed provider response. */
export function providerFailure(status: number, body: string): string {
  const text = body.slice(0, MAX_ERROR_BODY);
  let detail = text;
  const parsed = jsonObject(text);
  if (parsed) {
    const error = parsed['error'];
    const nested = objectOf(error)?.['message'] ?? error;
    const message = nested ?? parsed['message'];
    detail = typeof message === 'string' ? message : '';
  }
  // Control characters would let a provider break the line the UI shows.
  detail = detail
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, MAX_DETAIL);
  return detail ? `AI provider error (${status}): ${detail}` : `AI provider unavailable (${status}). Check the server's AI configuration.`;
}
