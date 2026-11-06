import type { ViteDevServer } from 'vite';

// The error behind a failed render in development. Astro answers a page that throws
// with a bare error page (`<title>ReferenceError</title>`) and sends the message,
// file and line to the browser over Vite's HMR channel, where its overlay shows
// them. The apply check (applyCheck.ts) reads pages over HTTP, so it listens on the
// same channel and keeps the latest error, which it pairs with a failed render that
// started before the error arrived.

export interface DevError {
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly atMs: number;
}
export interface DevErrors {
  /** The latest error sent at or after `sinceMs`, if any. */
  readonly since: (sinceMs: number) => DevError | undefined;
  /** The same, waiting briefly: Astro can send the error just after it answers the request. */
  readonly next: (sinceMs: number) => Promise<DevError | undefined>;
}

const MESSAGE_CHARS_MAX = 500;
const WAIT_MS_MAX = 600;
const WAIT_STEP_MS = 50;

export function captureDevErrors(server: ViteDevServer): DevErrors {
  let latest: DevError | undefined;
  const hot = server.environments['client']?.hot;
  if (hot) {
    const send = hot.send.bind(hot);
    // Wrapping keeps whatever Astro or Vite installed; the payload passes on unchanged.
    hot.send = ((...args: Parameters<typeof send>) => {
      const error = devError(args[0]);
      if (error) {
        latest = error;
      }
      send(...args);
    }) as typeof send;
  }
  const since = (sinceMs: number) => (latest && latest.atMs >= sinceMs ? latest : undefined);
  const next = async (sinceMs: number) => {
    for (let waited = 0; waited < WAIT_MS_MAX; waited += WAIT_STEP_MS) {
      const error = since(sinceMs);
      if (error) {
        return error;
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
    }
    return since(sinceMs);
  };
  return { since, next };
}

/** The error in an HMR payload `{ type: 'error', err: { message, loc: { file, line } } }`, or undefined. */
export function devError(payload: unknown): DevError | undefined {
  if (!isObject(payload) || payload['type'] !== 'error' || !isObject(payload['err'])) {
    return undefined;
  }
  const err = payload['err'];
  const message = typeof err['message'] === 'string' ? err['message'].replace(/\u001b\[[0-9;]*m/g, '').trim() : '';
  if (!message) {
    return undefined;
  }
  const loc = isObject(err['loc']) ? err['loc'] : {};
  return {
    message: message.slice(0, MESSAGE_CHARS_MAX),
    ...(typeof loc['file'] === 'string' ? { file: loc['file'] } : {}),
    ...(typeof loc['line'] === 'number' && Number.isSafeInteger(loc['line']) ? { line: loc['line'] } : {}),
    atMs: Date.now(),
  };
}

/** "Missing is not defined (src/pages/index.astro:14)", with the path relative to the project. */
export function describeDevError(error: DevError, root: string): string {
  if (!error.file) {
    return error.message;
  }
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const file = error.file.startsWith(prefix) ? error.file.slice(prefix.length) : error.file;
  return `${error.message} (${file}${error.line === undefined ? '' : `:${error.line}`})`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
