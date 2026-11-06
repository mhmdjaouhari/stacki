import { parseRenameFolders } from '../../../vendor/stacki/shared/properties/pageRenameConflicts';
import { parseWorkspaceId } from '../../shared/workspaceIdentity';
import { parseScanPages, type ScanPage } from '../../../vendor/stacki/shared/properties/projectScan';
import { parseNumericBindings, type NumericStyleBinding } from '../preview/numericStyleProtocol';
import { responseError, StudioRequestError } from './responseError';
import { parseField, type PropField } from '../../../vendor/stacki/shared/properties/propSchema';
import { beginOperation } from '../session/activity';
import { record, string } from '../../shared/validation';
import { componentFile } from '../../../vendor/stacki/shared/properties/componentDefaults';
import { parseComponentOrigin, type ComponentOrigin } from '../../../vendor/stacki/shared/properties/componentSources';

export interface Component {
  readonly origin?: ComponentOrigin;
  readonly importPath?: string;
  readonly numericStyles?: readonly NumericStyleBinding[];
  readonly renderTag?: { readonly tag?: string; readonly prop?: string };
  readonly file: string;
  readonly name: string;
  readonly fields: PropField[];
  readonly slots: string[];
  readonly slotText?: boolean;
}
export interface Project {
  readonly workspaceId?: string;
  readonly name: string;
  readonly pages: string[];
  readonly pageFolders?: readonly string[];
  readonly pageMetadata?: readonly ScanPage[];
  readonly collections: string[];
  readonly assets: string[];
  readonly components: Component[];
  readonly classes: string[];
}
let requestWorkspace = '';
let workspaceRevision = 0;
export async function request(url: string, options?: RequestInit): Promise<unknown> {
  const finish = beginOperation();
  const revision = workspaceRevision;
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...Object.fromEntries(new Headers(options?.headers)),
        'x-studio-workspace': requestWorkspace,
      },
      signal: options?.signal ?? AbortSignal.timeout(240_000),
    });
    if (!response.headers.get('Content-Type')?.includes('application/json')) {
      throw responseError(response);
    }
    const data: unknown = await response.json();
    if (response.ok && revision === workspaceRevision && (url.startsWith('/studio/api/git/') || url === '/studio/api/pages/rename')) {
      const identity = response.headers.get('x-studio-workspace');
      if (identity) {
        const parsed = parseWorkspaceId(identity) ?? '';
        if (parsed !== requestWorkspace) {
          requestWorkspace = parsed;
          workspaceRevision++;
        }
      }
    }
    if (!response.ok) {
      throw new StudioRequestError(string(record(data)['error'] ?? responseError(response).message), response.status);
    }
    return data;
  } catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) {
      throw new StudioRequestError('The connection to Studio was interrupted. Please retry shortly.', 0);
    }
    throw error;
  } finally {
    finish();
  }
}
// A server-sent event is a few lines; a whole reply travels in one, so the bound is the reply's.
const EVENT_CHARS_MAX = 8_000_000;

/**
 * A POST whose reply is a stream of server-sent events, read as they arrive. `onEvent` gets each
 * event's name and parsed data; the promise settles when the stream ends. A reply that isn't a
 * stream (an error from a gate or proxy) fails as `request` would.
 */
export async function requestEvents(url: string, options: RequestInit, onEvent: (event: string, data: unknown) => void): Promise<void> {
  const finish = beginOperation();
  try {
    const response = await fetch(url, {
      ...options,
      headers: { ...Object.fromEntries(new Headers(options.headers)), Accept: 'text/event-stream', 'x-studio-workspace': requestWorkspace },
    });
    const type = response.headers.get('Content-Type') ?? '';
    if (response.ok && type.includes('text/event-stream') && response.body) {
      await readEvents(response.body, onEvent);
      return;
    }
    if (!type.includes('application/json')) {
      throw responseError(response);
    }
    const data: unknown = await response.json();
    if (!response.ok) {
      throw new StudioRequestError(string(record(data)['error'] ?? responseError(response).message), response.status);
    }
    // A server without streaming answers with the reply itself: one result, no steps.
    onEvent('result', data);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new StudioRequestError('The connection to Studio was interrupted. Please retry shortly.', 0);
    }
    throw error;
  } finally {
    finish();
  }
}

async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: unknown) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > EVENT_CHARS_MAX) {
      await reader.cancel();
      throw new StudioRequestError('The reply is too large.', 0);
    }
    // Events end with a blank line; a partial one waits for the next chunk.
    for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');
      if (event && data) {
        const parsed: unknown = JSON.parse(data);
        onEvent(event, parsed);
      }
    }
  }
}

function strings(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 100_000) {
    throw new Error('Invalid list');
  }
  return input.map((item) => string(item));
}
export async function loadProject(signal?: AbortSignal): Promise<Project> {
  const revision = workspaceRevision;
  const project = parseProject(await request('/studio/api/project', signal ? { signal } : undefined));
  if (revision !== workspaceRevision) {
    throw new StudioRequestError('The shared branch changed while loading. Please retry.', 409);
  }
  requestWorkspace = project.workspaceId ?? '';
  return project;
}

export function parseProject(input: unknown): Project {
  const data = record(input);
  if (!Array.isArray(data['components'])) {
    throw new Error('Missing components');
  }
  const components = data['components'].map((input) => {
    const item = record(input);
    if (!Array.isArray(item['fields'])) {
      throw new Error('Invalid fields');
    }
    if (item['slotText'] !== undefined && typeof item['slotText'] !== 'boolean') {
      throw new Error('Invalid default slot type');
    }
    return {
      file: componentFile(item['file']),
      origin: parseComponentOrigin(item['origin']),
      ...(item['importPath'] === undefined ? {} : { importPath: string(item['importPath'], 500) }),
      name: string(item['name']),
      fields: item['fields'].map((field) => parseField(field, 'component')),
      slots: strings(item['slots']),
      numericStyles: parseNumericBindings(item['numericStyles']),
      slotText: item['slotText'] === true,
      ...parseRenderTag(item['renderTag']),
    };
  });
  const workspaceId = parseWorkspaceId(data['workspaceId']);
  return {
    name: string(data['name']),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    pages: strings(data['pages']),
    pageFolders: parseRenameFolders(data['pageFolders'] ?? []),
    pageMetadata: parseScanPages(data['pageMetadata'] ?? []),
    collections: strings(data['collections']),
    assets: strings(data['assets']),
    classes: strings(data['classes']),
    components,
  };
}
function parseRenderTag(input: unknown): Pick<Component, 'renderTag'> {
  if (input === undefined) {
    return {};
  }
  const value = record(input);
  return {
    renderTag: {
      ...(value['tag'] === undefined ? {} : { tag: string(value['tag'], 100) }),
      ...(value['prop'] === undefined ? {} : { prop: string(value['prop'], 100) }),
    },
  };
}
export function routeFor(file: string) {
  if (isDefaultsCanvas(file)) {
    return defaultsCanvasRoute(file);
  }
  const relative = file
    .replace(/^src\/pages\//, '')
    .replace(/\.(astro|md|mdx)$/, '')
    .replace(/(^|\/)index$/, '');
  return '/' + relative;
}
import { isDefaultsCanvas, defaultsCanvasRoute } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
