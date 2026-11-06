import { lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { importedCallsInScope } from '../../../vendor/stacki/src/editor/dataSuggest';
import { parsePage } from '../source/source';
import { record, string } from '../../shared/validation';
import { renderPath } from '../preview/renderPushServer';
import { optionalSource } from './agent';
import type { ValueRequest } from '../project/valueSampler';

// What the model needs besides source code to make a good edit, gathered once
// for the first message of a request. Source alone hides every value a page
// renders from data: "improve the title" on a page whose title comes from the
// CMS's settings made the model edit code around a value it couldn't see. So
// the request also carries:
//
// - the rendered page: the text and structure the dev server renders for the
//   page on the canvas, every bound value included, as an indented outline;
// - the file's data: what each `const x = await call()` in its frontmatter
//   returns, sampled the way the Settings panel samples it (valueSampler.ts);
// - the selection: the source of the element selected on the canvas;
// - the owner's instructions: `.stacki/ai.md`, the one project file the model
//   takes as guidance. Everything else, rendered text included, is data that
//   editors wrote and that may contain instructions, so it is sent as data.
//
// Each part is bounded, and a part that fails is left out with its reason:
// context improves a reply but must never block one.

export const CONTEXT_LIMITS = {
  outlineCharsMax: 30_000,
  outlineDepthMax: 8,
  selectionCharsMax: 4000,
  selectionLabelCharsMax: 100,
  callsMax: 8,
  sampleCharsMax: 2000,
  instructionsCharsMax: 8000,
  renderBytesMax: 4_000_000,
  renderMsMax: 15_000,
} as const satisfies Record<string, number>;

export const OWNER_INSTRUCTIONS_FILE = '.stacki/ai.md';

/** What the client adds to a request: the page on the canvas, and the selected element of the current file. */
export interface ContextRequest {
  readonly page?: string;
  readonly selection?: { readonly start: number; readonly end: number; readonly label: string };
}
/** The server's handles for rendering and sampling; absent where Studio runs without a dev server. */
export interface ContextSources {
  readonly render: (path: string) => Promise<string>;
  readonly sample: (request: ValueRequest) => Promise<{ readonly value: unknown }>;
}
export interface PromptContext {
  readonly page?: { readonly path: string; readonly outline: string } | { readonly path: string; readonly unavailable: string };
  readonly selection?: { readonly label: string; readonly lines: string; readonly source: string };
  readonly data?: readonly { readonly name: string; readonly call: string; readonly value: string }[];
}

export function parseContextRequest(input: Record<string, unknown>): ContextRequest {
  const page = input['page'] === undefined ? undefined : renderPath({ path: input['page'] });
  if (input['page'] !== undefined && page === undefined) {
    throw new Error('Invalid page path');
  }
  const selection = input['selection'] === undefined ? undefined : parseSelection(input['selection']);
  return { ...(page ? { page } : {}), ...(selection ? { selection } : {}) };
}

export async function gatherContext(root: string, file: string, request: ContextRequest, sources: ContextSources | undefined): Promise<PromptContext> {
  const source = (await optionalSource(root, file)) ?? '';
  const [page, data] = await Promise.all([
    request.page && sources ? renderedPage(request.page, sources) : undefined,
    sources ? dataSamples(file, source, sources) : undefined,
  ]);
  const selection = request.selection ? selectedSource(source, request.selection) : undefined;
  return { ...(page ? { page } : {}), ...(selection ? { selection } : {}), ...(data?.length ? { data } : {}) };
}

/** The owner's guidance for the AI, or undefined when the project has none. */
export async function ownerInstructions(root: string): Promise<string | undefined> {
  const text = (await readInstructions(root))?.trim();
  if (!text) {
    return undefined;
  }
  return text.length > CONTEXT_LIMITS.instructionsCharsMax
    ? `${text.slice(0, CONTEXT_LIMITS.instructionsCharsMax)}\n…(cut at ${CONTEXT_LIMITS.instructionsCharsMax} characters)`
    : text;
}

// Studio's project paths cover src/, public/ and its metadata files, so this one file is read on
// its own terms: inside the project, never through a symbolic link, and only up to a size worth reading.
async function readInstructions(root: string): Promise<string | undefined> {
  const directory = path.join(root, '.stacki');
  const file = path.join(directory, 'ai.md');
  assert(path.relative(root, file) === OWNER_INSTRUCTIONS_FILE.split('/').join(path.sep), 'instructions: path outside the project');
  try {
    const [folder, entry] = [await lstat(directory), await lstat(file)];
    if (folder.isSymbolicLink() || !entry.isFile()) {
      return undefined;
    }
    if (entry.size > CONTEXT_LIMITS.instructionsCharsMax * 4) {
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(CONTEXT_LIMITS.instructionsCharsMax * 4);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return `${buffer.subarray(0, bytesRead).toString('utf8')}\n`;
      } finally {
        await handle.close();
      }
    }
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** The page's rendered HTML fetched from the dev server on `port`, as the browser would get it. */
export async function fetchRenderedPage(port: number, path: string): Promise<string> {
  assert(Number.isSafeInteger(port), 'render: port must be an integer');
  assert(renderPath({ path }) === path, 'render: path must be a validated render path');
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'error', signal: AbortSignal.timeout(CONTEXT_LIMITS.renderMsMax) });
  if (!response.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`The page did not render as HTML (status ${response.status})`);
  }
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > CONTEXT_LIMITS.renderBytesMax) {
    throw new Error('The rendered page is too large');
  }
  const html = await response.text();
  if (html.length > CONTEXT_LIMITS.renderBytesMax) {
    throw new Error('The rendered page is too large');
  }
  return response.ok ? html : `<p>(The page answered with status ${response.status}.)</p>${html}`;
}

async function renderedPage(path: string, sources: ContextSources): Promise<PromptContext['page']> {
  try {
    return { path, outline: pageOutline(await sources.render(path)) };
  } catch (error) {
    return { path, unavailable: error instanceof Error ? error.message.slice(0, 300) : 'The page could not be rendered' };
  }
}

async function dataSamples(file: string, source: string, sources: ContextSources): Promise<PromptContext['data']> {
  if (!file.startsWith('src/')) {
    return undefined;
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? '';
  const parsed = parsePage(source);
  const imports = parsed.editable && 'imports' in parsed.model ? parsed.model.imports : [];
  const calls = importedCallsInScope(frontmatter, imports).slice(0, CONTEXT_LIMITS.callsMax);
  return Promise.all(
    calls.map(async (call) => {
      let value: string;
      try {
        value = JSON.stringify((await sources.sample({ file, spec: call.spec, name: call.exportName })).value) ?? 'undefined';
      } catch (error) {
        value = `(not available: ${error instanceof Error ? error.message.slice(0, 200) : 'the call failed'})`;
      }
      return { name: call.name, call: `await ${call.exportName}()`, value: clipText(value, CONTEXT_LIMITS.sampleCharsMax) };
    }),
  );
}

function selectedSource(source: string, selection: NonNullable<ContextRequest['selection']>): PromptContext['selection'] {
  // The selection was taken on the client's copy, which may be a few edits ahead or behind.
  if (selection.end > source.length) {
    return undefined;
  }
  const first = lineAt(source, selection.start);
  const last = lineAt(source, Math.max(selection.start, selection.end - 1));
  assert(first <= last, 'selection: lines out of order');
  return {
    label: selection.label,
    lines: first === last ? `${first}` : `${first}-${last}`,
    source: clipText(source.slice(selection.start, selection.end), CONTEXT_LIMITS.selectionCharsMax),
  };
}

function parseSelection(value: unknown): NonNullable<ContextRequest['selection']> {
  const input = record(value);
  const start = input['start'];
  const end = input['end'];
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
    throw new Error('Invalid selection');
  }
  return { start, end, label: string(input['label'], CONTEXT_LIMITS.selectionLabelCharsMax) };
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = source.indexOf('\n'); index !== -1 && index < offset; index = source.indexOf('\n', index + 1)) {
    line++;
  }
  return line;
}

function clipText(text: string, charsMax: number): string {
  return text.length > charsMax ? `${text.slice(0, charsMax)}…` : text;
}

// Elements that start a line of the outline, labelled with their tag. Text in other
// elements (spans, emphasis, inline code) joins the line it sits in.
const LINE_ELEMENTS = new Set([
  'title',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'a',
  'button',
  'label',
  'blockquote',
  'figcaption',
  'td',
  'th',
  'dt',
  'dd',
  'summary',
  'option',
  'pre',
]);
// Elements that group lines: the outline indents what they contain.
const GROUP_ELEMENTS = new Set([
  'header',
  'nav',
  'main',
  'section',
  'article',
  'aside',
  'footer',
  'ul',
  'ol',
  'form',
  'table',
  'dl',
  'details',
  'figure',
  'dialog',
]);
const VOID_ELEMENTS = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr']);
const SKIPPED = /<(script|style|svg|noscript|template|iframe|canvas)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->|<!doctype[^>]*>/gi;
// A tag, a run of text, or a stray "<". Linear on any input: no nested quantifiers. A ">"
// inside a quoted attribute ends the tag early, which only costs that tag's attributes.
const TOKEN = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)|</g;

/**
 * The rendered page as an indented outline of its text: one line per heading,
 * paragraph, link, list item or image, labelled with its tag, nested under the
 * landmarks and lists around it. Scripts, styles and markup are dropped.
 */
export function pageOutline(html: string): string {
  assert(html.length <= CONTEXT_LIMITS.renderBytesMax, 'outline: page beyond the render bound');
  const lines: string[] = [];
  let size = 0;
  let depth = 0;
  let line: { tag: string; text: string; href: string } | undefined;
  const flush = () => {
    const text = line?.text.replace(/\s+/g, ' ').trim();
    if (line && text) {
      const entry = `${'  '.repeat(Math.min(depth, CONTEXT_LIMITS.outlineDepthMax))}${line.tag}${line.href ? ` (${line.href})` : ''}: ${text}`;
      lines.push(entry);
      size += entry.length + 1;
    }
    line = undefined;
  };
  for (const match of html.replace(SKIPPED, ' ').matchAll(TOKEN)) {
    if (size > CONTEXT_LIMITS.outlineCharsMax) {
      break;
    }
    const [, closing, rawTag, attributes, text] = match;
    if (text !== undefined) {
      if (!line && !text.trim()) {
        continue; // Whitespace between tags.
      }
      line ??= { tag: 'text', text: '', href: '' };
      line.text += decodeEntities(text);
      continue;
    }
    const tag = rawTag?.toLowerCase();
    if (!tag) {
      continue;
    }
    if (GROUP_ELEMENTS.has(tag)) {
      flush();
      depth = Math.max(0, depth + (closing ? -1 : 1));
    } else if (LINE_ELEMENTS.has(tag)) {
      if (line?.tag === 'a' && tag !== 'a') {
        // A heading or paragraph inside a link (a card) stays part of the link's line.
        line.text += ' ';
      } else if (closing) {
        flush();
      } else {
        flush();
        line = { tag, text: '', href: tag === 'a' ? clipText(attribute(attributes ?? '', 'href'), 200) : '' };
      }
    } else if (tag === 'img') {
      const alt = attribute(attributes ?? '', 'alt');
      if (line) {
        line.text += alt ? ` [image: ${alt}]` : '';
      } else {
        lines.push(`${'  '.repeat(Math.min(depth, CONTEXT_LIMITS.outlineDepthMax))}img: ${alt || '(no alt text)'}`);
      }
    } else if (tag === 'br' || tag === 'div' || tag === 'body') {
      flush();
    } else if (!VOID_ELEMENTS.has(tag) && line) {
      line.text += ' ';
    }
  }
  flush();
  const outline = lines.join('\n');
  return outline.length > CONTEXT_LIMITS.outlineCharsMax ? `${outline.slice(0, CONTEXT_LIMITS.outlineCharsMax)}\n…(the rest of the page is left out)` : outline;
}

function attribute(attributes: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attributes);
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity: string, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return Object.hasOwn(NAMED_ENTITIES, body.toLowerCase()) ? (NAMED_ENTITIES[body.toLowerCase()] ?? entity) : entity;
  });
}
