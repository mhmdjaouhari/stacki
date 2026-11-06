import { DEFAULT_OUTPUT_TOKENS } from './chatContracts';
import { record, sourcePath, string } from '../../shared/validation';
import { completionTurn, providerFailure, type ToolCall, type TurnResult } from './replies';
import type { Problem } from './checks';
import type { ProposedChange } from './proposalSources';

// One call to the provider's OpenAI-compatible /chat/completions, and the
// proposal both protocols end in.

export interface Proposal {
  readonly summary: string;
  readonly changes: readonly ProposedChange[];
  /** What the automatic check still found after the model's fix rounds; absent when the check passed. */
  readonly problems?: readonly Problem[];
}
export interface Options {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens?: number;
  /** Sent as `reasoning_effort`; absent leaves the provider's default. */
  readonly effort?: string;
  readonly containerToken?: string;
  /** Use the provider's native tool calling rather than the JSON protocol (AI_TOOL_MODELS). */
  readonly tools?: boolean;
  /** The model reads images, so the tools include screenshots (AI_VISION_MODELS). */
  readonly vision?: boolean;
}
export type Content =
  string | readonly ({ readonly type: 'text'; readonly text: string } | { readonly type: 'image_url'; readonly image_url: { readonly url: string } })[];
export type Message =
  | { readonly role: 'system' | 'user'; readonly content: Content }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly tool_calls?: readonly {
        readonly id: string;
        readonly type: 'function';
        readonly function: { readonly name: string; readonly arguments: string };
      }[];
      readonly reasoning_content?: string;
    }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };
export interface ToolDefinition {
  readonly type: 'function';
  readonly function: { readonly name: string; readonly description: string; readonly parameters: Readonly<Record<string, unknown>> };
}

// Thinking at high effort routinely takes minutes for a single completion.
const COMPLETION_TIMEOUT_MS = 180_000;
export const CONTEXT_CHARS_MAX = 1_500_000;

/** One completion; with `tools`, the reply may be tool calls instead of text. */
export async function completion(
  options: Options,
  messages: readonly Message[],
  signal: AbortSignal | undefined,
  tools?: readonly ToolDefinition[],
): Promise<TurnResult & { readonly kind: 'reply' | 'tools' }> {
  if (JSON.stringify(messages).length > CONTEXT_CHARS_MAX) {
    throw new Error('AI context limit reached. Try a more focused request.');
  }
  const response = await fetch(options.endpoint.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      ...(options.containerToken ? { 'x-studio-token': options.containerToken } : {}),
    },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(COMPLETION_TIMEOUT_MS)]) : AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
    body: JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens ?? DEFAULT_OUTPUT_TOKENS,
      ...(options.effort ? { reasoning_effort: options.effort } : {}),
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
      messages,
    }),
  });
  if (!response.ok) {
    throw new Error(providerFailure(response.status, await response.text().catch(() => '')));
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('The AI provider returned an unreadable reply.');
  }
  const turn = completionTurn(payload);
  if (turn.kind === 'failure') {
    throw new Error(turn.message);
  }
  return turn;
}

/** The assistant message that carried `calls`, as the next request must repeat it. */
export function toolCallMessage(calls: readonly ToolCall[], content: string, reasoning: string): Message {
  return {
    role: 'assistant',
    content: content || null,
    tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
    ...(reasoning ? { reasoning_content: reasoning } : {}),
  };
}

/** A proposal from the model's answer: at most 20 changes, one per file, only to files it has read. */
export function parseProposal(proposal: Record<string, unknown>, files: readonly string[], read: ReadonlySet<string>): Proposal {
  const changes = proposal['changes'] ?? [];
  if (!Array.isArray(changes) || changes.length > 20) {
    throw new Error('AI must propose at most 20 changes');
  }
  const validated = changes.map((input) => {
    const change = record(input);
    const file = sourcePath(change['file']);
    if (files.includes(file) && !read.has(file)) {
      throw new Error('AI tried to edit a file it has not read');
    }
    return { file, before: string(change['before']), after: string(change['after']) };
  });
  if (new Set(validated.map((change) => change.file)).size !== validated.length) {
    throw new Error('AI must return one change per file');
  }
  return { summary: string(proposal['summary'], 4000), changes: validated };
}
