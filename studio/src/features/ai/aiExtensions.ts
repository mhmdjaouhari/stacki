// What a host integration adds to the AI chat: `studio({ ai: { tools, context } })`.
//
// Studio knows the site's source and what its pages render, but not what a CMS
// behind them holds: its collections and fields, its settings, its entries. A
// host that runs Studio inside a CMS (as the EmDash plugin does) knows that, and
// passes it here, so Studio stays CMS-neutral:
//
// - `context` providers add short sections to the first message of every
//   request, such as the CMS's content model in a few lines;
// - `tools` let the model ask for more when it needs it, such as the entries of
//   one collection. They are offered only to models that use native tool calling
//   (AI_TOOL_MODELS).
//
// Both must be read-only: nothing the model calls may change content. What they
// return is data written by editors, sent to the model as data, never as
// instructions, and it is bounded here whatever the host returns.

export interface AiContextRequest {
  /** The project file the person is editing, such as `src/pages/index.astro`. */
  readonly file: string;
  /** The page on the canvas, when there is one: its path and query. */
  readonly page?: string;
  readonly signal: AbortSignal;
}
export interface AiContextSection {
  readonly title: string;
  readonly content: string;
}
export interface AiTool {
  /** Lower-case letters, digits and underscores, starting with a letter; must not shadow a built-in tool. */
  readonly name: string;
  /** What the tool returns and when to call it, for the model. */
  readonly description: string;
  /** The JSON Schema of its arguments, an object schema. */
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Runs the tool with the model's arguments, unvalidated: the tool parses them. The result is sent as JSON. */
  readonly run: (input: unknown, context: { readonly signal: AbortSignal }) => Promise<unknown>;
}
export interface AiExtensions {
  readonly context?: readonly ((request: AiContextRequest) => Promise<readonly AiContextSection[]>)[];
  readonly tools?: readonly AiTool[];
}

export const EXTENSION_LIMITS = {
  providersMax: 8,
  sectionsMax: 8,
  sectionTitleCharsMax: 100,
  sectionCharsMax: 8000,
  toolsMax: 16,
  descriptionCharsMax: 1000,
  resultCharsMax: 50_000,
  callMsMax: 15_000,
} as const satisfies Record<string, number>;

const TOOL_NAME = /^[a-z][a-z0-9_]{1,40}$/;

/** Checks what a host passed, once, when Studio starts: a broken extension is a configuration error. */
export function parseAiExtensions(value: AiExtensions | undefined, reserved: readonly string[]): AiExtensions | undefined {
  if (value === undefined) {
    return undefined;
  }
  const context = value.context ?? [];
  const tools = value.tools ?? [];
  if (context.length > EXTENSION_LIMITS.providersMax) {
    throw new Error(`studio({ ai }): at most ${EXTENSION_LIMITS.providersMax} context providers`);
  }
  if (tools.length > EXTENSION_LIMITS.toolsMax) {
    throw new Error(`studio({ ai }): at most ${EXTENSION_LIMITS.toolsMax} tools`);
  }
  const names = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name) || reserved.includes(tool.name) || names.has(tool.name)) {
      throw new Error(`studio({ ai }): invalid or duplicate tool name "${String(tool.name).slice(0, 60)}"`);
    }
    if (typeof tool.run !== 'function' || !tool.description || tool.description.length > EXTENSION_LIMITS.descriptionCharsMax) {
      throw new Error(
        `studio({ ai }): tool "${tool.name}" needs a run function and a description of at most ${EXTENSION_LIMITS.descriptionCharsMax} characters`,
      );
    }
    if (tool.parameters['type'] !== 'object') {
      throw new Error(`studio({ ai }): tool "${tool.name}" parameters must be an object schema`);
    }
    names.add(tool.name);
  }
  return { context, tools };
}

/** Runs `work` with a deadline, aborting it when the request ends or the deadline passes. */
export async function withDeadline<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(EXTENSION_LIMITS.callMsMax)]);
  const aborted = new Promise<never>((_, reject) => {
    combined.addEventListener('abort', () => reject(new Error('The extension took too long')), { once: true });
  });
  return Promise.race([work(combined), aborted]);
}

/** A host value as bounded JSON text for the model. */
export function boundedJSON(value: unknown, charsMax: number): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? 'null';
  } catch {
    text = JSON.stringify(String(value));
  }
  return text.length > charsMax ? `${text.slice(0, charsMax)}…(cut at ${charsMax} characters)` : text;
}
