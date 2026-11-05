import { record, string } from '../../shared/validation';

export interface ChatImage {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}
export interface ChatContext {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}
export interface ChatInput {
  readonly images: readonly ChatImage[];
  readonly history: readonly ChatContext[];
}
export interface ModelConfiguration {
  readonly models: readonly string[];
  readonly defaultModel: string;
  /** Reasoning-effort levels per model, in display order. A model without an entry takes no effort setting. */
  readonly efforts: Readonly<Record<string, readonly string[]>>;
}
// Providers name their effort levels differently (DeepSeek: low/high/max;
// OpenAI: low/medium/high), so the levels come from configuration rather than
// a fixed list, and are sent unchanged as `reasoning_effort`.
const MAX_EFFORT_MODELS = 30;
const MAX_EFFORT_LEVELS = 8;
const EFFORT_LEVEL = /^[a-z][a-z0-9_-]{0,15}$/;
// Reasoning models count their thinking against max_tokens, so a small budget
// ends the reply before the answer. The default leaves room for both; the bound
// is the largest output any supported provider accepts.
export const DEFAULT_OUTPUT_TOKENS = 16_384;
const MIN_OUTPUT_TOKENS = 1024;
const MAX_OUTPUT_TOKENS = 393_216;
export function modelConfiguration(model?: string, models?: string, efforts?: string): ModelConfiguration {
  const values = [
    ...new Set(
      [model, ...(models ?? '').split(',')]
        .filter(Boolean)
        .map((value) => string(value, 160).trim())
        .filter(Boolean),
    ),
  ];
  if (values.length > 30) {
    throw new Error('Configure at most 30 AI models');
  }
  return { models: values, defaultModel: model?.trim() ?? '', efforts: effortConfiguration(efforts, values) };
}
/** AI_EFFORTS lists levels per model: `deepseek-v4-flash=low,high,max; gpt-6-luna=low,medium,high`. */
export function effortConfiguration(value: string | undefined, models: readonly string[]): ModelConfiguration['efforts'] {
  const entries = (value ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length > MAX_EFFORT_MODELS) {
    throw new Error(`Configure efforts for at most ${MAX_EFFORT_MODELS} AI models`);
  }
  // fromEntries defines own properties, so a model named __proto__ cannot reach the prototype.
  return Object.fromEntries(
    entries.map((entry) => {
      const separator = entry.lastIndexOf('=');
      const model = entry.slice(0, Math.max(separator, 0)).trim();
      if (separator <= 0 || !models.includes(model)) {
        throw new Error(`AI_EFFORTS names a model that is not configured: ${model.slice(0, 160)}`);
      }
      const levels = [
        ...new Set(
          entry
            .slice(separator + 1)
            .split(',')
            .map((level) => level.trim())
            .filter(Boolean),
        ),
      ];
      return [model, effortLevelsOf(levels, model)];
    }),
  );
}
function effortLevelsOf(levels: readonly unknown[], model: string): readonly string[] {
  if (!levels.length || levels.length > MAX_EFFORT_LEVELS) {
    throw new Error(`Configure 1 to ${MAX_EFFORT_LEVELS} effort levels for ${model.slice(0, 160)}`);
  }
  return levels.map((level) => {
    if (typeof level !== 'string' || !EFFORT_LEVEL.test(level)) {
      throw new Error(`Invalid effort level for ${model.slice(0, 160)}`);
    }
    return level;
  });
}
/** The effort levels a model accepts; none when the configuration doesn't list it. */
export function effortLevels(configuration: Pick<ModelConfiguration, 'efforts'>, model: string): readonly string[] {
  return Object.hasOwn(configuration.efforts, model) ? (configuration.efforts[model] ?? []) : [];
}
export function outputTokens(value: string | undefined): number {
  if (!value?.trim()) {
    return DEFAULT_OUTPUT_TOKENS;
  }
  const tokens = Number(value);
  if (!Number.isInteger(tokens) || tokens < MIN_OUTPUT_TOKENS || tokens > MAX_OUTPUT_TOKENS) {
    throw new Error(`AI_MAX_TOKENS must be a whole number from ${MIN_OUTPUT_TOKENS} to ${MAX_OUTPUT_TOKENS}`);
  }
  return tokens;
}
export function parseModels(value: unknown): ModelConfiguration {
  const input = record(value);
  if (!Array.isArray(input['models']) || input['models'].length > 30) {
    throw new Error('Invalid model configuration');
  }
  const models = input['models'].map((model) => string(model, 160));
  return {
    models,
    defaultModel: string(input['defaultModel'], 160),
    efforts: parseEfforts(input['efforts'], models),
  };
}
// Older backends send no efforts; every model then takes no effort setting.
function parseEfforts(value: unknown, models: readonly string[]): ModelConfiguration['efforts'] {
  if (value === undefined) {
    return {};
  }
  const input = record(value);
  const names = Object.keys(input);
  if (names.length > MAX_EFFORT_MODELS || names.some((model) => !models.includes(model))) {
    throw new Error('Invalid model configuration');
  }
  return Object.fromEntries(
    names.map((model) => {
      const levels = input[model];
      if (!Array.isArray(levels)) {
        throw new Error('Invalid model configuration');
      }
      return [model, effortLevelsOf(levels, model)];
    }),
  );
}
export function parseImages(value: unknown): readonly ChatImage[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 4) {
    throw new Error('Attach up to four images');
  }
  return value.map((value) => {
    const image = record(value);
    const url = string(image['url'], 180_000);
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) {
      throw new Error('Invalid image attachment');
    }
    return { id: string(image['id'], 100), name: string(image['name'], 200), url };
  });
}
export function parseChatInput(value: unknown): ChatInput {
  const input = record(value);
  const history = input['history'] ?? [];
  if (!Array.isArray(history) || history.length > 12 || JSON.stringify(history).length > 80_000) {
    throw new Error('Conversation context is too large');
  }
  return {
    images: parseImages(input['images']),
    history: history.map((value) => {
      const message = record(value);
      const role = message['role'];
      if (role !== 'user' && role !== 'assistant') {
        throw new Error('Invalid message role');
      }
      return { role, content: string(message['content'], 12_000) };
    }),
  };
}
