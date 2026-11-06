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
      response.end(JSON.stringify(await proposals.create(JSON.parse(await readBody()), controller.signal, sources)));
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
