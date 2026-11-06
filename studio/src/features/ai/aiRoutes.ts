import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProposalStore } from './proposalStore';
import type { ContextSources } from './aiContext';
import { availableModels } from './configuration';

export async function aiRoute(
  proposals: ProposalStore,
  sources: ContextSources | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  readBody: () => Promise<string>,
) {
  if (!pathname.startsWith('/studio/api/ai/')) {
    return false;
  }
  response.setHeader('Content-Type', 'application/json');
  if (pathname === '/studio/api/ai/models' && request.method === 'GET') {
    response.end(JSON.stringify(await availableModels()));
    return true;
  }
  if (pathname === '/studio/api/ai/propose' && request.method === 'POST') {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.once('close', cancel);
    try {
      if (request.headers.accept?.includes('text/event-stream')) {
        await streamProposal(proposals, sources, response, controller.signal, readBody);
      } else {
        response.end(JSON.stringify(await proposals.create(JSON.parse(await readBody()), controller.signal, sources)));
      }
    } finally {
      response.off('close', cancel);
    }
    return true;
  }
  const proposalFile = /^\/studio\/api\/ai\/proposals\/([\w-]{1,100})\/files$/.exec(pathname);
  if (proposalFile?.[1] && request.method === 'GET') {
    const file = new URL(request.url ?? '/', 'http://studio').searchParams.get('file');
    response.end(JSON.stringify(await proposals.proposalFile(proposalFile[1], file)));
    return true;
  }
  if (pathname === '/studio/api/ai/changes/file' && request.method === 'POST') {
    response.end(JSON.stringify(await proposals.changeFile(JSON.parse(await readBody()))));
    return true;
  }
  if (pathname === '/studio/api/ai/revert' && request.method === 'POST') {
    response.end(JSON.stringify(await proposals.revert(JSON.parse(await readBody()))));
    return true;
  }
  if (pathname === '/studio/api/ai/apply' && request.method === 'POST') {
    response.end(JSON.stringify(await proposals.apply(JSON.parse(await readBody()))));
    return true;
  }
  return false;
}

// Keeps proxies from closing a quiet stream while the model thinks for minutes.
const HEARTBEAT_MS = 15_000;

/**
 * The proposal as server-sent events: a `step` event per step while the agent works, then one
 * `result` event with the same reply the JSON route sends, or one `error` event. The headers go
 * out first, so a failure is an event, not a status code.
 */
async function streamProposal(
  proposals: ProposalStore,
  sources: ContextSources | undefined,
  response: ServerResponse,
  signal: AbortSignal,
  readBody: () => Promise<string>,
) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    // Nginx and similar proxies buffer responses unless told not to.
    'X-Accel-Buffering': 'no',
  });
  const send = (event: 'step' | 'result' | 'error', data: unknown) => {
    if (!response.writableEnded) {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  response.write(': stream\n\n');
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) {
      response.write(': keepalive\n\n');
    }
  }, HEARTBEAT_MS);
  try {
    send('result', await proposals.create(JSON.parse(await readBody()), signal, sources, (step) => send('step', step)));
  } catch (error) {
    send('error', { error: error instanceof Error ? error.message : 'Could not generate a reply.' });
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
}
