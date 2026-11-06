import type { ParserNode } from '../source/source';

// What the editor knows that a chat request should carry: the page on the canvas,
// which the server renders for the model, and the element selected in the current
// file, whose source the server cuts from its own copy (aiContext.ts).

export interface ChatRequestContext {
  /** The canvas page's path and query, as the dev server serves it. */
  readonly page?: string;
  readonly selection?: { readonly start: number; readonly end: number; readonly label: string };
}

const LABEL_CHARS_MAX = 100;

export function chatRequestContext(node: ParserNode | undefined, previewURL: string | undefined): ChatRequestContext {
  const page = pagePath(previewURL);
  const selection = node ? selectionOf(node) : undefined;
  return { ...(page ? { page } : {}), ...(selection ? { selection } : {}) };
}

/** A short name for the selection, shown in the composer and sent to the model. */
export function selectionLabel(node: ParserNode): string {
  switch (node.kind) {
    case 'component':
    case 'element':
      return `<${node.name}>`.slice(0, LABEL_CHARS_MAX);
    case 'map':
      return 'a list';
    case 'cond':
      return 'a condition';
    case 'expr':
      return `{${node.value}}`.slice(0, LABEL_CHARS_MAX);
    case 'text':
    case 'raw-line':
      return 'text';
    case 'raw':
    case 'chunk-group':
      return node.name.slice(0, LABEL_CHARS_MAX);
    case 'branch':
    case 'comment':
      return node.kind;
  }
}

function selectionOf(node: ParserNode): ChatRequestContext['selection'] {
  const { start, end } = node;
  if (start === undefined || end === undefined || end <= start) {
    return undefined;
  }
  return { start, end, label: selectionLabel(node) };
}

// Studio's own routes (component previews, the defaults canvas) aren't pages of the site.
function pagePath(previewURL: string | undefined): string | undefined {
  if (!previewURL) {
    return undefined;
  }
  const url = new URL(previewURL, location.origin);
  const path = url.pathname + url.search;
  return /^\/(studio|@|__)/.test(url.pathname) ? undefined : path;
}
