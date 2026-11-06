import { modelConfiguration, parseModels } from './chatContracts';

export async function availableModels() {
  const backend = process.env['STUDIO_BACKEND_URL'];
  const token = process.env['STUDIO_CONTAINER_TOKEN'];
  if (backend && token) {
    const response = await fetch(backend + '/studio/internal/ai/models', {
      headers: { 'x-studio-token': token },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error('Could not load AI models');
    }
    return parseModels(await response.json());
  }
  return modelConfiguration(
    process.env['AI_BASE_URL'] ? process.env['AI_MODEL'] : undefined,
    process.env['AI_BASE_URL'] ? process.env['AI_MODELS'] : undefined,
    process.env['AI_BASE_URL'] ? process.env['AI_EFFORTS'] : undefined,
    process.env['AI_BASE_URL'] ? process.env['AI_TOOL_MODELS'] : undefined,
  );
}
