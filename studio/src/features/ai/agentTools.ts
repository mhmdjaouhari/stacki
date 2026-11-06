import { assert } from '../../../vendor/stacki/shared/core/assert';
import { record, sourcePath, string, MAX_SOURCE } from '../../shared/validation';
import { readSource } from '../project/projectServer';
import { renderPath } from '../preview/renderPushServer';
import { dataSamples, pageOutline, type ContextSources } from './aiContext';
import { boundedJSON, EXTENSION_LIMITS, withDeadline, type AiTool } from './aiExtensions';
import { checkProposal } from './proposalSources';
import { completion, parseProposal, toolCallMessage, type Message, type Options, type Proposal, type ToolDefinition } from './completions';
import { parseAnswer, type ToolCall } from './replies';
import { checkLabel, fileList, type Progress } from './progress';
import type { Problem } from './checks';

// The agent with native tool calling. The model reads what it needs through
// read-only tools and finishes by calling `propose_changes`, whose changes are
// checked before they are accepted: a proposal that wouldn't apply or compile
// goes back to the model with the problems, at most FIX_ROUNDS_MAX times, and
// whatever still fails is returned with the proposal for the person to see.

export const TOOL_LOOP_LIMITS = {
  roundsMax: 10,
  callsMax: 30,
  fixRoundsMax: 2,
  readFilesMax: 12,
  listedFilesMax: 2000,
  searchQueryCharsMax: 200,
  searchMatchesMax: 50,
  searchLineCharsMax: 200,
  resultCharsMax: 100_000,
} as const satisfies Record<string, number>;

export interface ToolLoopInput {
  readonly root: string;
  readonly files: readonly string[];
  /** Files the model has read; it may only edit those. */
  readonly read: Set<string>;
  readonly sources: ContextSources | undefined;
  readonly signal: AbortSignal | undefined;
  readonly progress: Progress;
}

export const BUILT_IN_TOOLS: readonly ToolDefinition[] = [
  tool('read_file', 'Read project files in full. Read a file before proposing a change to it.', {
    paths: {
      type: 'array',
      items: { type: 'string' },
      maxItems: TOOL_LOOP_LIMITS.readFilesMax,
      description: 'Project paths such as src/components/Hero.astro',
    },
  }),
  tool('list_files', 'List project source files, optionally under a folder.', {
    prefix: { type: 'string', description: 'A path prefix such as src/components/' },
  }),
  tool('search_source', 'Find a text in the project source, case-insensitively. Returns file, line and the line text.', {
    query: { type: 'string', maxLength: TOOL_LOOP_LIMITS.searchQueryCharsMax },
  }),
  tool('render_page', 'The text a page renders, as an outline, with every value from data filled in. Use it for any route, such as a post page.', {
    path: { type: 'string', description: 'The page path, such as / or /posts/hello' },
  }),
  tool('page_data', "What a page's or component's frontmatter data calls (const x = await call()) return.", { file: { type: 'string' } }),
  tool('check_changes', 'Check candidate changes without proposing them: whether each applies, and whether the files compile.', { changes: changesSchema() }),
  tool(
    'propose_changes',
    'Finish by proposing changes for the person to review, with a clear summary. Each change replaces a unique exact substring ("before") of a file you have read with "after"; one change per file, so edits in several places of one file are one change whose before spans from the first to the last; before="" creates a new file. The changes are checked; if they have problems you get them back to fix.',
    { summary: { type: 'string' }, changes: changesSchema() },
  ),
];
// Offered only to vision models (AI_VISION_MODELS) when a browser is configured (screenshots.ts).
const SCREENSHOT_TOOL = tool(
  'screenshot',
  'A picture of how a page looks, 960×600, sent to you as an image. Use it for layout, spacing and visual questions.',
  {
    path: { type: 'string', description: 'The page path, such as /' },
  },
);
export const BUILT_IN_TOOL_NAMES = [...BUILT_IN_TOOLS, SCREENSHOT_TOOL].map((definition) => definition.function.name);
// A screenshot is about 200 kB of base64; the context bound (1.5 MB) holds a few.
const SCREENSHOTS_MAX = 4;

export async function proposeWithTools(options: Options, messages: Message[], input: ToolLoopInput): Promise<Proposal> {
  const extensions = input.sources?.extensions?.tools ?? [];
  const screenshots = options.vision && input.sources?.screenshot ? input.sources.screenshot : undefined;
  const definitions = [
    ...BUILT_IN_TOOLS,
    ...(screenshots ? [SCREENSHOT_TOOL] : []),
    ...extensions.map((extension) => tool(extension.name, extension.description, extension.parameters, 'schema')),
  ];
  let calls = 0;
  let fixRounds = 0;
  let shots = 0;
  for (let round = 0; round < TOOL_LOOP_LIMITS.roundsMax; round++) {
    input.progress(round ? 'Thinking' : 'Thinking about the request');
    const turn = await completion(options, messages, input.signal, definitions);
    if (turn.kind === 'reply') {
      // No tool call: an answer in prose, or a proposal written as JSON by a model that ignored the tool.
      const parsed = parseAnswer(turn.content);
      if (parsed.kind === 'answer' && Array.isArray(parsed.answer['changes']) && parsed.answer['changes'].length) {
        let proposal: Proposal;
        try {
          proposal = parseProposal(parsed.answer, input.files, input.read);
        } catch (error) {
          if (fixRounds >= TOOL_LOOP_LIMITS.fixRoundsMax) {
            throw error;
          }
          fixRounds++;
          input.progress('The proposal was malformed; asked the model to correct it');
          messages.push(
            { role: 'assistant', content: turn.content },
            { role: 'user', content: JSON.stringify({ error: messageOf(error), instruction: 'Correct it and call propose_changes.' }) },
          );
          continue;
        }
        return { ...proposal, ...problemsField(await checkProposal(input.root, proposal.changes)) };
      }
      return {
        summary: string(parsed.kind === 'answer' && typeof parsed.answer['summary'] === 'string' ? parsed.answer['summary'] : turn.content, 4000),
        changes: [],
      };
    }
    messages.push(toolCallMessage(turn.calls, turn.content, turn.reasoning));
    // Tool results are text, so pictures follow the results in one user message.
    const pictures: { path: string; url: string }[] = [];
    for (const call of turn.calls) {
      calls++;
      if (calls > TOOL_LOOP_LIMITS.callsMax) {
        throw new Error('AI tool limit reached. Try a more focused request.');
      }
      if (call.name === 'propose_changes') {
        const outcome = await proposalOutcome(call, input, fixRounds < TOOL_LOOP_LIMITS.fixRoundsMax);
        if (outcome.kind === 'done') {
          return outcome.proposal;
        }
        fixRounds += outcome.kind === 'fix' ? 1 : 0;
        messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.reply });
      } else if (call.name === 'screenshot' && screenshots) {
        input.progress(toolLabel(call));
        const outcome = await takeScreenshot(call, screenshots, shots < SCREENSHOTS_MAX);
        if (outcome.kind === 'picture') {
          shots++;
          pictures.push(outcome.picture);
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.reply });
      } else {
        input.progress(toolLabel(call));
        messages.push({ role: 'tool', tool_call_id: call.id, content: await runTool(call, input, extensions) });
      }
    }
    if (pictures.length) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `Screenshots you asked for: ${pictures.map((picture) => picture.path).join(', ')}.` },
          ...pictures.map((picture) => ({ type: 'image_url' as const, image_url: { url: picture.url } })),
        ],
      });
    }
  }
  throw new Error('AI tool limit reached. Try a more focused request.');
}

type ProposalOutcome = { readonly kind: 'done'; readonly proposal: Proposal } | { readonly kind: 'fix' | 'invalid'; readonly reply: string };

// An invalid proposal (an unread file, a malformed change) goes back to the model as an error it can
// correct; a valid one with problems goes back while fix rounds remain, and is returned once they run out.
async function proposalOutcome(call: ToolCall, input: ToolLoopInput, canFix: boolean): Promise<ProposalOutcome> {
  let proposal: Proposal;
  try {
    proposal = parseProposal(record(JSON.parse(call.arguments)), input.files, input.read);
  } catch (error) {
    return { kind: 'invalid', reply: JSON.stringify({ accepted: false, error: messageOf(error) }) };
  }
  const problems = await checkProposal(input.root, proposal.changes);
  input.progress(checkLabel(proposal.changes.length, problems.length, canFix));
  if (problems.length && canFix) {
    const instruction =
      'The proposal was not accepted. Fix these problems (read the files again if they changed) and call propose_changes again with all the changes.';
    return { kind: 'fix', reply: JSON.stringify({ accepted: false, problems, instruction }) };
  }
  return { kind: 'done', proposal: { ...proposal, ...problemsField(problems) } };
}

type ScreenshotOutcome =
  { readonly kind: 'picture'; readonly picture: { path: string; url: string }; readonly reply: string } | { readonly kind: 'error'; readonly reply: string };

async function takeScreenshot(call: ToolCall, capture: NonNullable<ContextSources['screenshot']>, allowed: boolean): Promise<ScreenshotOutcome> {
  try {
    if (!allowed) {
      throw new Error(`At most ${SCREENSHOTS_MAX} screenshots per request`);
    }
    const path = renderPath({ path: record(JSON.parse(call.arguments))['path'] });
    if (!path) {
      throw new Error('Invalid page path');
    }
    return {
      kind: 'picture',
      picture: { path, url: await capture(path, 'model') },
      reply: JSON.stringify({ ok: true, note: 'The screenshot follows as an image.' }),
    };
  } catch (error) {
    return { kind: 'error', reply: JSON.stringify({ error: messageOf(error) }) };
  }
}

async function runTool(call: ToolCall, input: ToolLoopInput, extensions: readonly AiTool[]): Promise<string> {
  try {
    const args: unknown = JSON.parse(call.arguments);
    const extension = extensions.find((candidate) => candidate.name === call.name);
    if (extension) {
      const signal = input.signal ?? new AbortController().signal;
      return boundedJSON(await withDeadline(signal, (deadline) => extension.run(args, { signal: deadline })), EXTENSION_LIMITS.resultCharsMax);
    }
    return await builtInTool(call.name, record(args), input);
  } catch (error) {
    return JSON.stringify({ error: messageOf(error) });
  }
}

async function builtInTool(name: string, args: Record<string, unknown>, input: ToolLoopInput): Promise<string> {
  switch (name) {
    case 'read_file':
      return JSON.stringify(await readFiles(args['paths'], input));
    case 'list_files': {
      const prefix = args['prefix'] === undefined ? '' : string(args['prefix'], 500);
      return JSON.stringify(input.files.filter((file) => file.startsWith(prefix)).slice(0, TOOL_LOOP_LIMITS.listedFilesMax));
    }
    case 'search_source':
      return JSON.stringify(await searchSource(string(args['query'], TOOL_LOOP_LIMITS.searchQueryCharsMax), input));
    case 'render_page': {
      const path = renderPath({ path: args['path'] });
      if (!path || !input.sources) {
        throw new Error(path ? 'Pages cannot be rendered here' : 'Invalid page path');
      }
      return bounded(pageOutline(await input.sources.render(path)));
    }
    case 'page_data': {
      const file = sourcePath(args['file']);
      if (!input.sources) {
        throw new Error('Data cannot be sampled here');
      }
      return bounded(JSON.stringify((await dataSamples(file, await readSource(input.root, file), input.sources)) ?? []));
    }
    case 'check_changes': {
      const proposal = parseProposal({ summary: '', changes: args['changes'] }, [], input.read);
      const problems = await checkProposal(input.root, proposal.changes);
      return JSON.stringify(problems.length ? { problems } : { ok: true });
    }
    default:
      throw new Error(`Unknown tool ${name.slice(0, 64)}`);
  }
}

async function readFiles(value: unknown, input: ToolLoopInput) {
  if (!Array.isArray(value) || value.length > TOOL_LOOP_LIMITS.readFilesMax) {
    throw new Error(`Read 1 to ${TOOL_LOOP_LIMITS.readFilesMax} files at a time`);
  }
  return Promise.all(
    value.map(async (path: unknown) => {
      const file = sourcePath(path);
      if (!input.files.includes(file)) {
        return { file, error: 'File does not exist' };
      }
      input.read.add(file);
      return { file, source: await readSource(input.root, file) };
    }),
  );
}

async function searchSource(query: string, input: ToolLoopInput) {
  const needle = query.toLowerCase();
  assert(needle.length > 0, 'search: the query must not be empty');
  const matches: { file: string; line: number; text: string }[] = [];
  for (const file of input.files) {
    if (matches.length >= TOOL_LOOP_LIMITS.searchMatchesMax) {
      break;
    }
    const source = await readSource(input.root, file).catch(() => '');
    if (source.length > MAX_SOURCE || !source.toLowerCase().includes(needle)) {
      continue;
    }
    source.split('\n').forEach((line, index) => {
      if (matches.length < TOOL_LOOP_LIMITS.searchMatchesMax && line.toLowerCase().includes(needle)) {
        matches.push({ file, line: index + 1, text: line.trim().slice(0, TOOL_LOOP_LIMITS.searchLineCharsMax) });
      }
    });
  }
  return matches;
}

// What a tool call is about to do, in the words the chat shows. The arguments are the model's,
// unvalidated, so only plain strings are read from them, and the label is bounded where it is kept.
function toolLabel(call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    args = record(JSON.parse(call.arguments));
  } catch {
    // The tool itself reports malformed arguments; the label falls back to the tool's name.
  }
  const text = (key: string) => (typeof args[key] === 'string' ? args[key] : '');
  switch (call.name) {
    case 'read_file':
      return `Read ${Array.isArray(args['paths']) ? fileList(args['paths'].filter((path): path is string => typeof path === 'string')) : 'files'}`;
    case 'list_files':
      return `Listed files${text('prefix') ? ` under ${text('prefix')}` : ''}`;
    case 'search_source':
      return `Searched for "${text('query')}"`;
    case 'render_page':
      return `Rendered ${text('path')}`;
    case 'page_data':
      return `Sampled the data of ${text('file').replace(/^src\//, '')}`;
    case 'check_changes':
      return 'Checked candidate changes';
    case 'screenshot':
      return `Took a screenshot of ${text('path')}`;
    default:
      return `Asked ${call.name}`;
  }
}

function problemsField(problems: readonly Problem[]): Pick<Proposal, 'problems'> {
  return problems.length ? { problems } : {};
}

function bounded(text: string): string {
  return text.length > TOOL_LOOP_LIMITS.resultCharsMax ? `${text.slice(0, TOOL_LOOP_LIMITS.resultCharsMax)}…(cut)` : text;
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : 'The tool failed').slice(0, 300);
}

function changesSchema() {
  return {
    type: 'array',
    maxItems: 20,
    items: {
      type: 'object',
      properties: { file: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' } },
      required: ['file', 'before', 'after'],
    },
  };
}

// `properties` is the arguments' properties; an extension passes its whole schema instead.
function tool(name: string, description: string, properties: Readonly<Record<string, unknown>>, kind: 'properties' | 'schema' = 'properties'): ToolDefinition {
  const parameters = kind === 'schema' ? properties : { type: 'object', properties, required: Object.keys(properties).filter((key) => key !== 'prefix') };
  return { type: 'function', function: { name, description, parameters } };
}
